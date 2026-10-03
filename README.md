# Workflow2Filename

**Workflow → Filename.** A tiny ComfyUI node that turns the *current workflow's
file name* into a filename prefix, so every render is named after the workflow
it came from — no manual renaming, ever.

```
workflow file:   SummerCat.json
output file:     SummerCat_00001_.png     <- instead of ComfyUI_00001_.png
```

---

## Why this exists (read this first)

ComfyUI names everything it saves with the same boring pattern:
`ComfyUI_00001_.png`, `ComfyUI_00002_.png`, `ComfyUI_00003_.png` …

Run thirty workflows and thirty experiments later, the `output` folder tells
you *nothing*. You cannot tell which render belongs to which workflow, so you
end up guessing, sorting by hand, or — worse — keeping a messy side spread-sheet
just to remember "the good one was the 14th picture of that SummerCat test".

**This plugin exists so that a beginner can open the `output` folder and know,
in one second, which workflow produced each picture.**

Because the file name carries the workflow name, the loop closes automatically:

- you find a good render → the name tells you **which workflow and which
  version** made it → you open that workflow and read your own parameters;
- a picture looks bad → the name tells you **which experiment** it was and you
  adjust only that one;
- you keep a whole folder of renders → each one is a **self-documenting
  record** of your process, so you can genuinely learn from what you did
  instead of re-running the same thing twice.

That is the whole point: **workflow file name → output file name**, one-to-one.
You then add a date or a version tag only when you want more granularity —
not because you have to.

---

## Install

Via ComfyUI-Manager: search for **Workflow2Filename**.

Via CLI:

```
comfy node install workflow2filename
```

Restart ComfyUI after installing (custom nodes are imported once at startup).
No models to download, no extra Python packages — only the standard library.

---

## Usage — 4 steps

1. Right-click the canvas → *Add Node* → search `Workflow2Filename`.
   It appears under **utils/io**.
2. Leave the `filename` field alone — it is filled in automatically the moment
   you press Run. Anything you type there is overwritten.
3. Connect `filename` → the `filename_prefix` input of a save node
   (`Save Image`, `VHS_VideoCombine`, `Save Video`, …).
4. Save the workflow. **The workflow must be saved** (with a file name) —
   the node reads your file name, so an unsaved canvas yields
   `UnsavedWorkflow`.

That is it. Run it: `output/SummerCat_00001_.png`.

### The four widgets

| Widget | Default | What it does |
|---|---|---|
| `filename` | auto | Read-only in practice — the workflow name, filled at queue time. |
| `suffix` | empty | Optional extra tag appended to the name. |
| `use_workflow_name` | ON | Master switch. ON = use the workflow name. |
| `fallback_prefix` | empty | Used when the switch is OFF. |

Output matrix:

| Switch | `suffix` | Output | Example |
|---|---|---|---|
| **ON** (default) | empty | plain workflow name | `SummerCat` |
| **ON** | `4k` | workflow name + suffix | `SummerCat_4k` |
| **ON** | `video/%date:yyyyMMdd%` | sub-folder + name + date | `output/video/SummerCat_20261002` |
| **OFF** | ignored | `fallback_prefix` only | `h3/daily` |

### Save into a sub-folder

`filename_prefix` is not only a name — ComfyUI's save nodes also read the
*path* part of it. So if a `suffix` (or a `fallback_prefix`) **starts** with a
folder chain, that becomes a real sub-directory, created on the first render.

Type this in `suffix`:

```
new/%date:yyyy-MM-dd_hhmm%
```

and a render of the `SummerCat` workflow lands here:

```
ComfyUI/output/new/SummerCat_2026-10-03_1009_00001_.png
   └──┬──┘  └──┬──┘  └───────────────┬───────────────┘ └──┬─┘
   base root   this node             workflow name      core
   (SaveImage) created `new/`        + expanded date    _00001_
```

| `suffix` you type | File lands in | Full result |
|---|---|---|
| *(empty)* | `output/` | `output/SummerCat_00001_.png` |
| `new/%date:yyyy-MM-dd_hhmm%` | `output/new/` | `output/new/SummerCat_2026-10-03_1009_00001_.png` |
| `video/%date:yyyyMMdd%` | `output/video/` | `output/video/SummerCat_20261002_00001_.png` |
| `archive/2026-10-03` | `output/archive/` | `output/archive/SummerCat_2026-10-03_00001_.png` |

| `fallback_prefix` (switch OFF) | File lands in | Full result |
|---|---|---|
| `h3/daily` | `output/h3/` | `output/h3/daily_00001_.png` |
| `prefix/ZIMAGE/QAZ` | `output/prefix/ZIMAGE/` | `output/prefix/ZIMAGE/QAZ_00001_.png` |

Rules worth knowing:

- The folder chain has to sit at the very **start** of the field. The node moves
  it *in front of* the workflow name when the switch is ON, so you get
  `new/<name>_…` — never `<name>_new/…`.
- Multiple levels work in both fields. With the switch **ON**, the trailing
  segment joins the file name (`archive/2026-10-03` → folder `archive/`, file
  `<workflow>_2026-10-03`); with the switch **OFF** the whole string is the
  prefix, so `prefix/ZIMAGE/QAZ` gives folder `prefix/ZIMAGE/` and file
  `QAZ_00001_.png`, exactly as typed.
- `/` and `\` both work, and the folders are created for you on the first
  render. No `mkdir`, no manual tidy-up afterwards.
- A trailing slash is fine too: `new/` → folder `new/`, file `<workflow>`.
- **The root depends on the save node**: `Save Image` writes under `output/`,
  `VHS_VideoCombine` under `output/video/`. Your folder is always *inside*
  that root, so avoid names the node already uses (`video`, `image`,
  `custom`).
- Keep the whole chain short — the total path has to stay under Windows'
  MAX_PATH (~260 characters).

- **OFF** with an empty `fallback_prefix` outputs an empty string, so the save
  node keeps ComfyUI's own default naming (`ComfyUI_00001_`).
- Widgets that do not apply to the current mode are greyed out.

---

## Date tokens

Pick one by **double-clicking** the `suffix` (or `fallback_prefix`) field — a
small menu pops up with the supported formats. Picking one writes the token in;
clicking anywhere else or pressing Esc leaves your value untouched.

| Token | Result |
|---|---|
| `%date:yyyy-MM-dd_hh-mm-ss%` | `SummerCat_2026-10-02_22-00-04` |
| `%date:yyyy-MM-dd%` | `SummerCat_2026-10-02` |
| `%date:yyyyMMdd%` | `SummerCat_20261002` |
| `%date:yyyy-MM-dd_hhmm%` | `SummerCat_2026-10-02_2248` |

Notes you will actually hit:

- The sample column in the menu is **live**: it is built from your system clock
  at the moment the menu opens, so it shows a time you can really get instead
  of a frozen string baked into the plugin.
- `hh` is the canonical spelling and it is the **24 hour clock** (as is `HH`).
  At 22:48 you get `…_2248`, never `…_1048`.
- `mm` is **minutes**, `MM` is the **month**. `yyyy` is the 4-digit year.
- **This node expands the token itself.** ComfyUI's own save nodes only know
  `%width% / %height% / %year% / %month% / %day% / %hour% / %minute% /
  %second% / %batch_num%` — they do **not** understand `%date:…%`, so without
  this node the raw token ended up literally in the file name.
- A leading `/` or `\` in `suffix` / `fallback_prefix` becomes a sub-folder and
  is moved *in front* of the workflow name, so the folder is never glued to the
  end. See [Save into a sub-folder](#save-into-a-sub-folder) for the exact
  syntax and the file's final location.

---

## Unsaved workflows

A canvas that has never been saved has no file name, so the output is tagged
with **`_UnsavedWorkflow`** to make those files easy to spot.

When a workflow *was* saved earlier in the session, the node remembers the name
together with a fingerprint of the graph and reuses it **only for a matching
graph** (≥75 % node/widget overlap). Different workflows never inherit each
other's names. The marker is appended in that case too, e.g.
`SummerCat_UnsavedWorkflow`. Delete `workflow_names.json` to clear the memory.

---

## How it works (and why there is a JS file)

A ComfyUI backend only receives the node graph — it has no idea which `.json`
file that graph came from, because workflow files do not store their own name.
So the bundled frontend extension (`js/workflow_filename.js`) captures the open
workflow's path and hands it to the node in two independent ways:

1. it writes the name into the node's `filename` widget (primary);
2. it injects the name into `extra_pnginfo.workflow` (secondary).

The Python node tries both before falling back to `UnsavedWorkflow`, so a
breaking change in one path does not take the node down.

---

## Quick reference

| You want | Put in `suffix` |
|---|---|
| workflow name only | *(leave empty)* |
| workflow name + version | `v2` |
| workflow name + date | `%date:yyyyMMdd%` |
| workflow name + date and time | `%date:yyyy-MM-dd_hhmm%` |
| a sub-folder `output/new/` | `new/%date:yyyy-MM-dd_hhmm%` |
| a sub-folder `output/video/` | `video/%date:yyyyMMdd%` |

- `hh` is the 24 hour clock (22:48 → `2248`); `mm` is minutes, `MM` is the month.
- **A folder goes at the start of the field** (`new/%date:…%`), never after the
  token. The root (`output/` vs `output/video/`) comes from the save node, not
  from this plugin.
- The date token is expanded by **this node** — save nodes only know
  `%year% / %month% / %day% …`.
- The workflow must be **saved and named**, otherwise the output carries the
  `_UnsavedWorkflow` suffix.
- Right-click the node → *Help* (DESCRIPTION) for the long version.

---

## Version history

- **1.0.0** — first public release.
- **1.0.1** — date formats: the menu's date token now uses the lower-case `hh`
  spelling with a matching 24-hour sample (`%date:yyyy-MM-dd_hhmm%` →
  `2026-10-02_2248`); the menu no longer advertises a `HH` token whose sample
  looked 12-hour. A mistyped `yyyyy` is expanded as well. Sub-folders,
  colon-bearing `%date:…%` tokens and per-workflow memory behave as in 1.0.0.
- **1.0.2 / 1.0.3** — the English-only cleanup: README rewritten in English
  (`夏日与猫` → `SummerCat`), then the front end followed.
- **1.0.4** — the front end is all English: the date menu, its title and its
  Esc hints. The menu's sample column is now built from the live system clock
  instead of a frozen string baked into the plugin.
- **1.0.5** — README: sub-folder saving is documented properly — multi-level
  chains work in both `suffix` and `fallback_prefix`, plus the exact output
  path each one produces. No code change.

---

## Known limitations

- The frontend extension must load. If it does not, the node still runs and
  returns `UnsavedWorkflow` — it never crashes the graph. After upgrading, do
  a hard refresh (**Ctrl+F5**).
- The extension reads ComfyUI's internal frontend storage keys (verified
  against `comfyui_frontend_package` 1.53.6). A future frontend release could
  change them; the menu/tooltip niceties stop working while the core naming
  keeps its fallback.
- `workflow_names.json` is machine-local, never uploaded, and excluded from the
  published package. It may be lost if you update through the Manager.
- The internal node type key is `WorkflowFilename` (not `Workflow2Filename`)
  for backwards compatibility with graphs saved before the rename. Workflow
  JSON therefore shows `WorkflowFilename` even though the UI says
  `Workflow2Filename`.

## Privacy

No network access, no telemetry, no model downloads. The only file written is
`workflow_names.json`, kept locally next to the node.

## License

MIT — see [LICENSE](LICENSE).
