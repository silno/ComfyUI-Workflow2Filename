# Workflow2Filename

**Workflow → Filename.** A tiny ComfyUI node that turns the *current workflow's
file name* into a filename prefix, so every render is named after the workflow
it came from — no manual renaming, ever.

```
workflow file:   夏日与猫.json
output file:     夏日与猫_00001_.png     <- instead of ComfyUI_00001_.png
```

---

## Why this exists (read this first)

ComfyUI names everything it saves with the same boring pattern:
`ComfyUI_00001_.png`, `ComfyUI_00002_.png`, `ComfyUI_00003_.png` …

Run thirty workflows and thirty experiments later, the `output` folder tells
you *nothing*. You cannot tell which render belongs to which workflow, so you
end up guessing, sorting by hand, or — worse — keeping a messy side spread-sheet
just to remember "the good one was the 14th picture of that 夏日与猫 test".

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

That is it. Run it: `output/夏日与猫_00001_.png`.

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
| **ON** (default) | empty | plain workflow name | `夏日与猫` |
| **ON** | `4k` | workflow name + suffix | `夏日与猫_4k` |
| **ON** | `video/%date:yyyyMMdd%` | sub-folder + name + date | `output/video/夏日与猫_20261002` |
| **OFF** | ignored | `fallback_prefix` only | `h3/daily` |

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
| `%date:yyyy-MM-dd_hh-mm-ss%` | `夏日与猫_2026-10-02_22-00-04` |
| `%date:yyyy-MM-dd%` | `夏日与猫_2026-10-02` |
| `%date:yyyyMMdd%` | `夏日与猫_20261002` |
| `%date:yyyy-MM-dd_hhmm%` | `夏日与猫_2026-10-02_2248` |

Notes you will actually hit:

- `hh` is the canonical spelling and it is the **24 hour clock** (as is `HH`).
  At 22:48 you get `…_2248`, never `…_1048`.
- `mm` is **minutes**, `MM` is the **month**. `yyyy` is the 4-digit year.
- **This node expands the token itself.** ComfyUI's own save nodes only know
  `%width% / %height% / %year% / %month% / %day% / %hour% / %minute% /
  %second% / %batch_num%` — they do **not** understand `%date:…%`, so without
  this node the raw token ended up literally in the file name.
- A leading `/` or `\` in `suffix` / `fallback_prefix` becomes a sub-folder and
  is moved *in front* of the workflow name, so the folder is never glued to the
  end (`video/ComfyUI_%date:yyyyMMdd%` → `output/video/<name>_20261002`).

---

## Unsaved workflows

A canvas that has never been saved has no file name, so the output is tagged
with **`_UnsavedWorkflow`** to make those files easy to spot.

When a workflow *was* saved earlier in the session, the node remembers the name
together with a fingerprint of the graph and reuses it **only for a matching
graph** (≥75 % node/widget overlap). Different workflows never inherit each
other's names. The marker is appended in that case too, e.g.
`夏日与猫_UnsavedWorkflow`. Delete `workflow_names.json` to clear the memory.

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

## Version history

- **1.0.0** — first public release.
- **1.0.1** — date formats: the menu's date token now uses the lower-case
  `hh` spelling with a matching 24-hour sample (`%date:yyyy-MM-dd_hhmm%` →
  `2026-10-02_2248`); the menu no longer advertises a `HH` token whose sample
  looked 12-hour. The token is also expanded for a mistyped `yyyyy`.
  Sub-folders, colon-bearing `%date:…%` tokens and per-workflow memory all
  behave as in 1.0.0.

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

---

## 中文速查

| 你要的效果 | suffix 填什么 |
|---|---|
| 只要工作流名 | 留空 |
| 工作流名 + 版本 | `v2` |
| 工作流名 + 日期 | `%date:yyyyMMdd%` |
| 工作流名 + 日期时间 | `%date:yyyy-MM-dd_hhmm%` |
| 存进 `output/video/` 子目录 | `video/%date:yyyyMMdd%` |

- `hh` = 24 小时制（22:48 → `2248`），`mm` = 分钟，`MM` = 月。
- 日期 token 由**本节点**展开，保存节点只认 `%year%/%month%/%day%…` 那几个。
- 工作流必须**存盘并命名**，否则输出带 `_UnsavedWorkflow` 后缀。
- 右键节点 → 帮助（DESCRIPTION）里有更长的说明。
