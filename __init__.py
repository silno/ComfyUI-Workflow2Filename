"""
ComfyUI-Workflow2Filename
=========================
Node name you see in the UI: "Workflow2Filename"  (Workflow -> Filename)
It outputs the CURRENT workflow's file name as a STRING, so it can be wired into
any node that takes a `filename_prefix` (e.g. VHS_VideoCombine, Save Image).

Why the name cannot come from the backend alone
-----------------------------------------------
ComfyUI's backend only receives the node graph; it has no idea which .json file
that graph came from (workflow .json files do not store their own name). The
bundled frontend extension (`js/workflow_filename.js`) therefore captures the
open workflow's path and hands it to this node in two independent ways, so the
node keeps working even if one path breaks:

  1. It writes the name into this node's `filename` widget (primary).
  2. It injects the name into `extra_pnginfo.workflow` (secondary).

This node tries BOTH sources, plus several plausible key names, before falling
back to "UnsavedWorkflow".

Usage
-----
1. Add a "Workflow2Filename" node (category `utils/io`).
2. Leave `filename` alone - it is filled in automatically on Queue.
3. Optionally set `suffix` to append a variant tag.
4. Connect its `filename` output to the `filename_prefix` input of
   VHS_VideoCombine.

Single output - `suffix` controls everything
--------------------------------------------
Leave `suffix` EMPTY and the output IS the plain workflow file name; no extra
output needed for that case.

Output depending on state:
- switch ON,  suffix empty   -> `MyWorkflow`                    (or `MyWorkflow_UnsavedWorkflow`)
- switch ON,  suffix = "4k"  -> `MyWorkflow_4k`
- switch OFF                 -> `fallback_prefix`  (suffix NOT applied)

On / off switch
---------------
- `use_workflow_name` = ON  (default): output the current workflow's file name
  (+ optional suffix) - fully automatic.
- `use_workflow_name` = OFF: ignore the workflow name and output
  `fallback_prefix` (+ suffix) instead. Leave `fallback_prefix` empty to get an
  empty string, i.e. the save node falls back to its own default naming
  (e.g. ComfyUI_00001_).

Per-workflow memory (for unsaved / draft workflows)
---------------------------------------------------
Whenever a real workflow name is read, this node stores that name TOGETHER WITH
A FINGERPRINT of the graph (node types + their widget contents) in
`workflow_names.json` next to this file.

If a later run has no name - an unsaved canvas, a draft, a "copy" that was
never saved - the node fingerprints that graph and reuses the remembered name
**only if the graph matches that workflow** (identical, or at least 75% similar
by Jaccard overlap). A different workflow therefore never inherits somebody
else's name. Nothing is shared globally; if there is no match, the node falls
back to "UnsavedWorkflow".

Delete `workflow_names.json` to clear the memory.
"""

import hashlib
import json
import os
import re
import time
from datetime import datetime

# Characters illegal in Windows / most file systems.
_ILLEGAL = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

# Path separators. A sub-directory ("video/ComfyUI_x") is legal input for the
# suffix / fallback_prefix fields: ComfyUI's save nodes turn the leading path
# into a subfolder and create it on demand (folder_paths.get_save_image_path
# -> os.path.dirname + os.makedirs). These separators must therefore survive
# cleaning, which the generic scrubbing above would happily delete.
_SEP = re.compile(r"[/\\]")

# A save-node date token, e.g. "%date:yyyyMMdd%". Its ':' is REQUIRED for the
# token to expand later on, yet ':' is also illegal in a real file name - so
# inside a token it must survive the illegal-character scrub below. Splitting on
# this pattern (capturing group) keeps tokens verbatim while everything else
# still gets cleaned normally.
_DATE_TOKEN = re.compile(r"(%date:[^%\s]*%)")

# `%date:<format>%` tokens are resolved HERE, not by the save node.
# ---------------------------------------------------------------------
# ComfyUI's `folder_paths.get_save_image_path()` only expands
# %width% / %height% / %year% / %month% / %day% / %hour% / %minute% /
# %second% / %batch_num%. A `%date:...%` token (the Java/Unity style that the
# bundled JS menu inserts) is NOT understood by it, so the token used to end up
# verbatim in the saved file name - exactly the bug reported as
# "ComfyUI222_%date:yyyy-MM-dd_hh-mm-ss%" on disk. Expanding it here keeps the
# output correct no matter which save node is downstream.
# NOTE: exactly ONE capturing group here on purpose. `re.split()` hands back
# every inner group separately, so a second group would make `_clean()` treat
# the token's *format text* as a separate plain fragment and append it again
# ("%date:yyyy-MM-dd%yyyy-MM-dd"). The format itself is matched by
# _DATE_TOKEN_FMT below, which is used with .sub() instead of .split().
_DATE_TOKEN = re.compile(r"(%date:[^%\s]*%)")
_DATE_TOKEN_FMT = re.compile(r"%date:(?P<fmt>[^%\s]*?)%")

# Java -> strftime.
# `hh` and `HH` BOTH mean the 24 hour clock. Java/Unity spell the 12 hour clock
# `hh`, but a bare "10" in a file name (instead of "22") reads like a bug, so
# both spellings deliberately collapse to strftime `%H`.
# `mm` (minutes) vs `MM` (month) is the classic mix-up: `m` -> `%M`, `M` -> `%m`.
_DIRECTIVES = {
    # 1-2 digit "yy/yyyy", but also tolerate a fat-fingered "yyyyy" -> %Y.
    "y": {1: "%y", 2: "%y", 3: "%Y", 4: "%Y", 5: "%Y", 6: "%Y", 7: "%Y", 8: "%Y"},
    "M": {1: "%m", 2: "%m"},
    "d": {1: "%d", 2: "%d"},
    "H": {1: "%H", 2: "%H"},
    "h": {1: "%H", 2: "%H"},
    "m": {1: "%M", 2: "%M"},
    "s": {1: "%S", 2: "%S"},
}


def _to_strftime(fmt: str) -> str:
    """Translate a Java-ish format ("yyyy-MM-dd_hh-mm-ss") to strftime.

    '%' is escaped first so user text can never inject directives, and unknown
    letters stay literal instead of being swallowed."""
    out = []
    i, n = 0, len(fmt)
    while i < n:
        ch = fmt[i]
        if ch == "%":
            out.append("%%")
            i += 1
            continue
        if ch in _DIRECTIVES:
            j = i
            while j < n and fmt[j] == ch:
                j += 1
            width = j - i
            rep = _DIRECTIVES[ch].get(width, "")
            out.append(rep if rep else ch * width)
            i = j
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _expand_date_tokens(value: str) -> str:
    """Replace every `%date:<format>%` with the current date/time.

    A format that cannot be rendered is left untouched, so a mistyped token
    never silently turns into nonsense instead of staying visible."""
    if not value or "%date:" not in value:
        return value

    def repl(m):
        fmt = _to_strftime(m.group("fmt"))
        # Nothing in the format was recognised (e.g. "%date:zz%") - a typo must
        # stay visible instead of silently turning into its own letters.
        if "%" not in fmt:
            return m.group(0)
        try:
            return datetime.now().strftime(fmt)
        except Exception:
            return m.group(0)

    return _DATE_TOKEN_FMT.sub(repl, value)


# Values that mean "we did not actually get a name".
_PLACEHOLDERS = {"", "unsavedworkflow", "untitled", "unknown", "none", "null"}

# Marker the frontend appends for canvases with unsaved changes.
_UNSAVED_MARK = "_UnsavedWorkflow"

# Keep the generated prefix short enough to stay well under Windows MAX_PATH.
_MAX_LEN = 80

# Where per-workflow name memory lives.
_STATE_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "workflow_names.json"
)

# How similar two graphs must be to be considered "the same workflow".
_MATCH_THRESHOLD = 0.75
_MAX_RECORDS = 50


def _clean(value, keep_dir=False) -> str:
    """Normalise a raw candidate (path, file name, or bare name) to a safe
    file-name fragment. Returns '' when nothing usable is found.

    `keep_dir=True` keeps a leading sub-directory chain ("video/ComfyUI_x" ->
    "video/ComfyUI_x") instead of reducing the input to its last segment. Use
    it for the fields the user fills in themselves; the workflow-name
    candidates deliberately keep the old basename behaviour.

    `%date:...%` tokens pass through byte-for-byte - a ':' inside one is part of
    the token grammar, not an illegal file-name character. A ':' anywhere else
    is still scrubbed (Windows would reject it)."""
    if not value or not isinstance(value, str):
        return ""
    s = value.strip()
    if not s:
        return ""
    # Splitting on the pattern's capture group yields [plain, token, plain, ...].
    # Odd indexes are date tokens and are appended untouched below.
    pieces = _DATE_TOKEN.split(s)
    if keep_dir:
        s = "".join(p if (i & 1) else _clean_relpath(p) for i, p in enumerate(pieces))
    else:
        s = "".join(p if (i & 1) else _clean_plain(p) for i, p in enumerate(pieces))
    return s


def _clean_plain(value: str) -> str:
    """The original scrubbing, applied to a fragment that contains no token."""
    if not value:
        return ""
    # accept either a full path or a bare file name
    s = value.split("/")[-1].split("\\")[-1]
    return _clean_basename(_clean_norm(s))


def _clean_relpath(value: str) -> str:
    """Clean "a/b/c" keeping the folders.

    The separator at the very END is deliberately kept: the piece after it is
    often a date token ("video/%date:yyyyMMdd%") rather than a name segment,
    and dropping the '/' there would glue the folder to the token."""
    if not value:
        return ""
    trailing = "/" if value[-1] in "/\\" else ""
    core = value[:-1] if trailing else value
    cleaned = [_clean_norm(s) for s in _SEP.split(core)]
    cleaned = [c for c in cleaned if c]  # "a//b" -> "a/b"
    if not cleaned:
        return trailing
    # the last segment is the real file name -> run the full validation
    cleaned[-1] = _clean_basename(cleaned[-1])
    return "/".join(cleaned) + trailing


def _clean_norm(value: str) -> str:
    """Strip a trailing .json, drop illegal characters, trim dots/spaces."""
    s = re.sub(r"\.json$", "", value, flags=re.IGNORECASE)
    s = _ILLEGAL.sub("", s)
    return s.strip().strip(".")


def _clean_basename(value: str) -> str:
    """Final validation of a single file-name segment."""
    s = value
    # synthetic names the new frontend gives to never-saved drafts
    # ("Unsaved Workflow (2)", "UnsavedWorkflow", ...) are NOT real names
    if s.lower().startswith("unsaved"):
        return ""
    if s.lower() in _PLACEHOLDERS:
        return ""
    if len(s) > _MAX_LEN:
        s = s[:_MAX_LEN].rstrip().rstrip(".")
    return s


def _leading_dir(s: str) -> str:
    """Return the directory chain at the start of `s`, with its trailing '/'
    ("video/ComfyUI_x" -> "video/", "a/b/c" -> "a/b/", "x" -> "")."""
    m = re.match(r"^((?:[^/\\]+/)+)", s or "")
    return m.group(1) if m else ""


def _strip_mark(s: str) -> str:
    """Remove a trailing unsaved-changes marker (added by the frontend)."""
    if s.endswith(_UNSAVED_MARK):
        return s[: -len(_UNSAVED_MARK)].rstrip("_").rstrip()
    return s


def _from_pnginfo(extra_pnginfo):
    """Yield every plausible workflow-name candidate found in extra_pnginfo."""
    if not isinstance(extra_pnginfo, dict):
        return
    wf = extra_pnginfo.get("workflow")
    if isinstance(wf, dict):
        for key in ("name", "filename", "file_name", "path", "title"):
            yield wf.get(key)
        # what WorkflowNameNode's JS injects
        extra = wf.get("extra")
        if isinstance(extra, dict):
            for key in ("workflowName", "workflow_name", "name", "filename"):
                yield extra.get(key)
        nested = wf.get("extra_pnginfo")
        if isinstance(nested, dict):
            yield nested.get("workflowName")


# --- per-workflow memory ----------------------------------------------------


def _fingerprint(workflow):
    """Build a set of tokens describing a graph: node type + a hash of its
    widget values. Stable across renames/re-saves, different across workflows."""
    if not isinstance(workflow, dict):
        return set()
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        return set()
    tokens = set()
    for n in nodes:
        if not isinstance(n, dict):
            continue
        ntype = str(n.get("type") or "")
        try:
            wv = json.dumps(n.get("widgets_values"), ensure_ascii=False, sort_keys=True)
        except Exception:
            wv = ""
        digest = hashlib.md5(wv.encode("utf-8", "ignore")).hexdigest()[:12]
        tokens.add(f"{ntype}|{digest}")
    return tokens


def _similarity(a, b):
    """Jaccard overlap of two token sets."""
    if not a or not b:
        return 0.0
    inter = len(a & b)
    if not inter:
        return 0.0
    return inter / float(len(a | b))


def _load_records():
    try:
        with open(_STATE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        recs = data.get("records") if isinstance(data, dict) else None
        if isinstance(recs, list):
            return [r for r in recs if isinstance(r, dict) and r.get("name")]
    except Exception:
        pass
    return []


def _save_records(records):
    try:
        with open(_STATE_FILE, "w", encoding="utf-8") as f:
            json.dump({"records": records}, f, ensure_ascii=False)
    except Exception:
        pass


def _remember(name, fingerprint):
    """Store `name` for this graph. Replaces any older record of the same name
    or of a near-identical graph, so the memory never drifts."""
    if not name or not fingerprint:
        return
    records = _load_records()
    kept = []
    for r in records:
        old_fp = set(r.get("fp") or [])
        if r.get("name") == name:
            continue  # replaced below
        if _similarity(old_fp, fingerprint) >= 0.9:
            continue  # same graph, older entry
        kept.append(r)
    kept.append(
        {
            "name": name,
            "fp": sorted(fingerprint),
            "ts": int(time.time()),
        }
    )
    kept.sort(key=lambda r: r.get("ts", 0), reverse=True)
    _save_records(kept[:_MAX_RECORDS])


def _recall(fingerprint):
    """Return the name remembered for THIS graph, or '' when there is no match."""
    if not fingerprint:
        return ""
    best_name, best_score = "", 0.0
    for r in _load_records():
        score = _similarity(set(r.get("fp") or []), fingerprint)
        if score > best_score:
            best_name, best_score = r.get("name") or "", score
    if best_score >= _MATCH_THRESHOLD:
        return best_name
    return ""


class WorkflowFilename:
    """Returns the current workflow's file name (without .json), optionally
    appended with a suffix. Fully automatic - do not type the workflow name."""

    # Shown when hovering the node's title bar / in the node info card.
    DESCRIPTION = (
        "Turns the CURRENT WORKFLOW'S FILE NAME into a filename prefix, so you\n"
        "can wire it into a save node's filename_prefix and every render is\n"
        "named after its workflow automatically - no more manual renaming.\n"
        "- switch ON : filename = <workflow name> (+ _suffix if suffix is set)\n"
        "- switch OFF: filename = your fallback_prefix (suffix NOT applied)\n"
        "- unsaved workflow: the name is tagged with _UnsavedWorkflow\n"
        "- suffix / fallback_prefix may start with a sub-directory, e.g.\n"
        "  \"video/ComfyUI_%date:yyyyMMdd%\" -> output\\video\\name_20261002\n"
        "TIP: DOUBLE-CLICK the suffix or fallback_prefix field (or double-click\n"
        "inside the value edit box it opens) to pick a date token from a menu:\n"
        "%date:yyyy-MM-dd_hh-mm-ss%, %date:yyyy-MM-dd%, %date:yyyyMMdd%\n"
        "or %date:yyyy-MM-dd_hhmm%  (hh = 24h, so 22:48 -> ..._2248).\n"
        "This node expands the token to the current date/time before output, so\n"
        "what you see downstream is already the final name - ComfyUI's own save\n"
        "nodes do NOT understand %date:...% (they only know %year%/.../%second%)."
    )

    @classmethod
    def INPUT_TYPES(cls):
        # NOTE: keep `filename` and `suffix` FIRST - existing workflows store
        # widget values by position, so appending new widgets at the end is the
        # only safe way to avoid shifting values in already-saved graphs.
        # NOTE: there is deliberately NO "tooltip" field here. ComfyUI would
        # render it with its GLOBAL delay setting (LiteGraph.Node.TooltipDelay,
        # ~500 ms by default), which is exactly the jumpy behaviour we do not
        # want - and tuning that setting would affect EVERY node in the UI.
        # The four widgets below therefore use our own delayed tooltip engine
        # implemented in js/workflow_filename.js (see TIP_DELAY there).
        # Texts live there as well (WIDGET_TIPS) - single source of truth.
        return {
            "required": {
                "filename": (
                    "STRING",
                    {"default": "UnsavedWorkflow", "multiline": False},
                ),
                "suffix": ("STRING", {"default": "", "multiline": False}),
                # --- switch -----------------------------------------------
                "use_workflow_name": ("BOOLEAN", {"default": True}),
                # used when the switch is OFF; empty = leave default naming
                "fallback_prefix": ("STRING", {"default": "", "multiline": False}),
            },
            "hidden": {
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    # Outputs:
    #   [0] filename -> ready-to-use filename_prefix:
    #                   ON  -> workflow name  (+ `_suffix` only if suffix is set;
    #                          suffix empty = plain workflow name)
    #                   OFF -> fallback_prefix (suffix NOT applied)
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("filename",)
    OUTPUT_TOOLTIPS = (
        "Wire this into the filename_prefix input of any save node\n"
        "(e.g. VHS_VideoCombine, Save Image).\n"
        "Output: ON -> <workflow name> (+ _suffix) | OFF -> fallback_prefix.\n"
        "Unsaved canvas -> the name is tagged with _UnsavedWorkflow.\n"
        "A sub-directory typed in the suffix or fallback_prefix (e.g.\n"
        "\"video/ComfyUI_%date:yyyyMMdd%\") is kept and moved in front, so the\n"
        "save node writes into output\\video\\ ...\n"
        "Date tokens (%date:yyyyMMdd%) are expanded HERE by this node - the\n"
        "save nodes only know %year%/.../%second%, never %date:...%.",
    )
    FUNCTION = "get_filename"
    # Where the node shows up in the right-click menu. Generic on purpose so it
    # makes sense to anyone, not just inside the author's H3 project.
    CATEGORY = "utils/io"
    OUTPUT_NODE = False

    # -- name resolution ----------------------------------------------------
    def _resolve(self, filename, extra_pnginfo):
        """Return (name, dirty) where `name` is the workflow's file name without
        .json and WITHOUT the unsaved marker applied yet; `dirty` says whether
        the canvas currently has unsaved changes."""
        dirty = False
        name = _clean(filename)
        if name:
            base = _strip_mark(name)
            dirty = base != name
            name = base
        if not name:
            for candidate in _from_pnginfo(extra_pnginfo):
                c = _clean(candidate)
                if c:
                    base = _strip_mark(c)
                    dirty = base != c
                    name = base
                    break
        fingerprint = _fingerprint(
            extra_pnginfo.get("workflow") if isinstance(extra_pnginfo, dict) else None
        )
        if name:
            if not dirty:
                _remember(name, fingerprint)
        else:
            remembered = _recall(fingerprint)
            if remembered:
                print(
                    "[WorkflowFilename] no name for this workflow -> "
                    f"reusing remembered name of a matching graph: {remembered}"
                )
                name = remembered
                dirty = True  # canvas has unsaved changes -> keep the marker
            else:
                name = "UnsavedWorkflow"
                dirty = False
        return name, dirty

    def get_filename(
        self,
        filename,
        suffix,
        use_workflow_name=True,
        fallback_prefix="",
        extra_pnginfo=None,
    ):
        # The plain workflow name is what you get whenever `suffix` is empty -
        # there is no separate output for it.
        base_name, dirty = self._resolve(filename, extra_pnginfo)
        workflow_name = f"{base_name}{_UNSAVED_MARK}" if dirty else base_name

        if use_workflow_name:
            name = workflow_name
            suffix = _clean(suffix, keep_dir=True)
            # A directory typed at the start of the suffix belongs in FRONT of
            # the workflow name ("video/x" -> "video/<name>_x"), otherwise the
            # folder would end up glued to the name as "<name>_x/".
            folder = _leading_dir(suffix)
            if folder:
                suffix = suffix[len(folder) :]
                name = folder + name
            if suffix:
                name = f"{name}_{suffix}" if name else suffix
        else:
            # OFF -> prefix = fallback_prefix only; `suffix` does NOT apply.
            # Empty fallback_prefix = empty output = save node keeps its
            # own default naming (e.g. ComfyUI_00001_).
            name = _clean(fallback_prefix, keep_dir=True)

        # Resolve `%date:...%` last so both branches benefit: the token has
        # already survived the illegal-character scrub above.
        return (_expand_date_tokens(name),)


# Node registration -----------------------------------------------------------
# IMPORTANT: never rename the KEY below ("WorkflowFilename").
# Saved workflows reference nodes by their type key, so renaming it would break
# every graph that already contains this node ("node not found" on load), and
# the bundled JS matches the node with `node.type === "WorkflowFilename"`.
# Only the DISPLAY name above is meant to be changed - the internal key here is
# deliberately kept even though the plugin was renamed to Workflow2Filename.
NODE_CLASS_MAPPINGS = {
    "WorkflowFilename": WorkflowFilename,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    # What you search for in the node menu ("Workflow2Filename" = Workflow -> Filename).
    "WorkflowFilename": "Workflow2Filename",
}

# Tell ComfyUI to serve + auto-load the JS extensions in this folder.
# Without this, the frontend extension never loads and the filename
# stays at its default value.
WEB_DIRECTORY = "./js"

# Import-time breadcrumb. ComfyUI imports every custom node once at startup and
# this ComfyUI build has no --enable-reload-handlers, so the code running in the
# server is whatever existed at boot. Printing here makes it obvious in the
# startup log whether THIS file's token-aware _clean() is the one in use,
# instead of debugging a stale module and mistaking it for a regex bug.
print(
    "[WorkflowFilename] token-aware filename cleaning ACTIVE "
    "(%date:...% keeps its colon, suffix/prefix sub-folders are kept)"
)
