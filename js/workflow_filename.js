// ComfyUI-Workflow2Filename frontend extension
//
// Captures the current workflow's file name and hands it to the backend node
// in TWO independent ways so the node keeps working if either breaks:
//
//   A) writes the name into the node's `filename` widget (primary)
//   B) injects the name into extra_pnginfo.workflow (secondary)
//
// Where the name comes from (ComfyUI 1.4x new Vue frontend)
// --------------------------------------------------------
// The new frontend stores workflow state in localStorage under a V2 scheme:
//   Comfy.Workflow.ActivePath:<workspace>      current path (clean only)
//   Comfy.Workflow.LastActivePath:<workspace>  previous path (survives edits)
//   Comfy.Workflow.OpenPaths:<workspace>       opened paths
//   Comfy.Workflow.LastOpenPaths:<workspace>
//   Comfy.Workflow.DraftIndex.v2:<workspace>   {v:2, order:[hash], entries:{hash:{path}}}
//   Comfy.Workflow.Draft.v2:<ws>:<hash>        draft body, hash = fnv1a(path)
//
// Editing a saved workflow moves it into DRAFT state: ActivePath no longer
// points at the .json, so older extensions that only read the legacy
// `Comfy.OpenWorkflowsPaths` key report "UnsavedWorkflow" even though the file
// name is fully recoverable from the draft index / last active path.
//
// This extension therefore resolves the name in layers, newest scheme first:
//   1. ActivePath (authoritative, clean)
//   2. DraftIndex entries -> most recently touched entry (edited workflow)
//   3. LastActivePath
//   4. OpenPaths / LastOpenPaths
//   5. legacy Comfy.OpenWorkflowsPaths (V1)
//   6. document.title ("<workflow> - ComfyUI")
//
// If the name came from anything other than a clean ActivePath, the workflow
// has unsaved changes, so `_UnsavedWorkflow` is appended - making files that
// came from an unsaved canvas recognisable at a glance.
import { app } from "../../scripts/app.js";

const LOG = (...a) =>
    console.log("%c[Workflow2Filename]", "color:#7ab;font-weight:bold", ...a);

const UNSAVED_MARK = "UnsavedWorkflow";

function extractName(rawPath) {
    if (!rawPath || typeof rawPath !== "string") return "";
    if (!/\.json$/i.test(rawPath)) return ""; // drafts / unsaved have no .json path
    const n = rawPath.split(/[\\/]/).pop().replace(/\.json$/i, "");
    // "Unsaved Workflow (2).json" etc. are synthetic names the frontend gives
    // to never-saved drafts - they are NOT real file names.
    if (!n || /^unsaved/i.test(n)) return "";
    return n;
}

// Same hash the frontend uses to key drafts: FNV-1a 32bit -> 8 hex chars.
function fnv1a(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}
function hashPath(p) {
    return fnv1a(p).toString(16).padStart(8, "0");
}

function readRawFrom(storage, key) {
    const v = storage.getItem(key);
    if (v == null) return null;
    try {
        return JSON.parse(v);
    } catch (e) {
        return v; // plain string
    }
}

function readRaw(key) {
    return readRawFrom(localStorage, key);
}

function asStringPath(v) {
    if (!v) return "";
    if (typeof v === "string") return v;
    if (Array.isArray(v)) {
        const hit = v
            .slice()
            .reverse()
            .find((x) => typeof x === "string" && /\.json$/i.test(x));
        return hit || "";
    }
    if (typeof v === "object") {
        // new-frontend pointers look like {workspaceId, path} / {workspaceId, paths, activeIndex}
        for (const k of ["path", "activePath", "filename", "name"]) {
            const cand = v[k];
            if (typeof cand === "string" && /\.json$/i.test(cand)) return cand;
        }
        for (const val of Object.values(v)) {
            if (typeof val === "string" && /\.json$/i.test(val)) return val;
        }
    }
    return "";
}

function scanKeys() {
    const out = [];
    for (const storage of [sessionStorage, localStorage]) {
        try {
            for (let i = 0; i < storage.length; i++) {
                const k = storage.key(i);
                if (k) out.push({ storage, k });
            }
        } catch (e) {
            /* storage unavailable */
        }
    }
    return out;
}

// draft payload keys live in localStorage only; their presence for a path
// means that path has unsaved changes (the frontend deletes them on save)
function hasDraftFor(wsPart, path) {
    return localStorage.getItem(`Comfy.Workflow.Draft.v2:${wsPart}:${hashPath(path)}`) != null;
}

function pickFromV2(keys) {
    // 1. authoritative current path - NOTE: the frontend writes ActivePath to
    //    sessionStorage and only LastActivePath to localStorage!
    for (const { storage, k } of keys) {
        if (!k.startsWith("Comfy.Workflow.ActivePath:")) continue;
        const wsPart = k.slice("Comfy.Workflow.ActivePath:".length);
        const p = asStringPath(readRawFrom(storage, k));
        const n = extractName(p);
        if (n) {
            const dirty = hasDraftFor(wsPart, p);
            LOG("resolved via ActivePath:", p, "| unsavedChanges:", dirty);
            return { name: n, dirty };
        }
    }
    // 2. draft index (workflow was edited after loading)
    for (const { k } of keys) {
        if (!k.startsWith("Comfy.Workflow.DraftIndex.v2:")) continue;
        const idx = readRaw(k);
        const entries = idx && typeof idx === "object" ? idx.entries : null;
        if (!entries) continue;
        let best = "";
        if (Array.isArray(idx.order) && idx.order.length) {
            // order is most-recent-last
            for (let i = idx.order.length - 1; i >= 0; i--) {
                const e = entries[idx.order[i]];
                const cand = e && (e.path || e.key);
                if (typeof cand === "string" && /\.json$/i.test(cand)) {
                    best = cand;
                    break;
                }
            }
        }
        if (!best) {
            let newest = -1;
            for (const hash of Object.keys(entries)) {
                const e = entries[hash] || {};
                const t = typeof e.updatedAt === "number" ? e.updatedAt : 0;
                if (t >= newest && typeof e.path === "string" && /\.json$/i.test(e.path)) {
                    newest = t;
                    best = e.path;
                }
            }
        }
        const n = extractName(best);
        if (n) {
            LOG("resolved via DraftIndex (edited workflow):", best);
            return { name: n, dirty: true };
        }
    }
    // 3. last active path survives edits; draft payload tells us if it is dirty
    for (const { k } of keys) {
        if (!k.startsWith("Comfy.Workflow.LastActivePath:")) continue;
        const wsPart = k.slice("Comfy.Workflow.LastActivePath:".length);
        const p = asStringPath(readRaw(k));
        const n = extractName(p);
        if (n) {
            const dirty = hasDraftFor(wsPart, p);
            LOG("resolved via LastActivePath:", p, "| unsavedChanges:", dirty);
            return { name: n, dirty };
        }
    }
    // 4. open paths (current, then last)
    for (const prefix of ["Comfy.Workflow.OpenPaths:", "Comfy.Workflow.LastOpenPaths:"]) {
        for (const { k } of keys) {
            if (!k.startsWith(prefix)) continue;
            const v = readRaw(k);
            let p = "";
            if (v && typeof v === "object" && Array.isArray(v.paths)) {
                let i = typeof v.activeIndex === "number" ? v.activeIndex : v.paths.length - 1;
                if (i < 0 || i >= v.paths.length) i = v.paths.length - 1;
                p = typeof v.paths[i] === "string" ? v.paths[i] : "";
            } else {
                p = asStringPath(v);
            }
            const n = extractName(p);
            if (n) {
                LOG("resolved via", prefix, p);
                return { name: n, dirty: prefix.includes("Last") };
            }
        }
    }
    return null;
}

function pickFromLegacy(keys) {
    const candidates = [];
    for (const { k } of keys) {
        if (k === "Comfy.OpenWorkflowsPaths" || k.startsWith("Comfy.OpenWorkflowsPaths:")) {
            const v = readRaw(k);
            if (Array.isArray(v)) candidates.push({ paths: v, activeIndex: -1 });
            else if (v && Array.isArray(v.paths))
                candidates.push({
                    paths: v.paths,
                    activeIndex: typeof v.activeIndex === "number" ? v.activeIndex : -1,
                });
        }
    }
    for (const c of candidates) {
        let i = c.activeIndex;
        if (i < 0 || i >= c.paths.length) i = c.paths.length - 1;
        const n = extractName(c.paths[i]);
        if (n) {
            LOG("resolved via legacy OpenWorkflowsPaths:", c.paths[i]);
            return { name: n, dirty: false };
        }
    }
    return null;
}

function fromTitle() {
    const t = document.title || "";
    const m = t.match(/^(.*?)\s*-\s*ComfyUI/);
    if (m && m[1]) {
        const n = m[1].trim().replace(/^\*+/, "");
        if (n && !/^unsaved/i.test(n) && n.toLowerCase() !== "comfyui") {
            LOG("resolved via document.title:", n);
            return { name: n, dirty: true };
        }
    }
    return null;
}

function pickName() {
    const keys = scanKeys();
    let res = pickFromV2(keys);
    if (res) return res;
    res = pickFromLegacy(keys);
    if (res) return res;
    res = fromTitle();
    if (res) return res;
    if (app.lastSavedFilename) {
        const n = extractName(app.lastSavedFilename);
        if (n) return { name: n, dirty: false };
    }
    LOG("no workflow name found");
    return null;
}

function finalName() {
    const res = pickName();
    if (!res) return "UnsavedWorkflow";
    return res.dirty ? `${res.name}_${UNSAVED_MARK}` : res.name;
}

// --- grey-out widgets that do not apply to the current mode -----------------
// ON  -> filename / suffix matter, fallback_prefix is inert  -> grey it
// OFF -> filename / suffix are inert, fallback_prefix matters -> grey those
//
// IMPORTANT (ComfyUI 1.53 / frontend 1.53.6 "Nodes 2.0"):
//   boolean widgets are NOT <input type=checkbox>. They are rendered by
//   reka-ui's SwitchRoot, i.e.
//     <button role="switch" aria-label="<widget name>" data-state="checked|unchecked">
//   and the click does NOT write back into `widget.value` - that only happens
//   when the graph is serialized (on Queue). So any extension that reads
//   `widget.value` to detect a toggle change appears to work "only when you
//   press Run". We therefore read the truth from the DOM switch itself.
const GREY_OPACITY = "0.4";

function widgetByName(node, name) {
    return node.widgets && node.widgets.find((x) => x.name === name);
}

// The Vue-rendered node body carries data-node-id, which lets us scope every
// lookup to THIS node (several WorkflowFilename nodes can coexist).
function findNodeDom(node) {
    const id = node && node.id != null ? String(node.id) : "";
    if (!id) return null;
    try {
        const hit = document.querySelector(`[data-node-id="${id}"]`);
        if (hit) return hit;
    } catch (e) {
        /* invalid selector -> fall through */
    }
    return null;
}

// Last resort: when there is exactly one such node on the canvas there is no
// ambiguity, so the global lookup is safe (and better than reading
// widget.value, which only refreshes at Queue time).
function uniqueGlobalSwitch() {
    try {
        const all = document.querySelectorAll('[aria-label="use_workflow_name"]');
        return all && all.length === 1 ? all[0] : null;
    } catch (e) {
        return null;
    }
}

function domCandidates(node, w) {
    const out = [];
    if (w && w.element) out.push(w.element);
    if (w && w.inputEl) out.push(w.inputEl);
    const host = findNodeDom(node);
    if (host) out.push(host);
    else {
        const solo = uniqueGlobalSwitch();
        if (solo) out.push(solo);
    }
    return out.filter(Boolean);
}

function stateFromSwitchEl(el) {
    if (!el || typeof el.getAttribute !== "function") return null;
    const ds = el.getAttribute("data-state");
    if (ds === "checked" || ds === "unchecked") return ds === "checked";
    const ac = el.getAttribute("aria-checked");
    if (ac === "true" || ac === "false") return ac === "true";
    if (el.dataset && el.dataset.state === "checked") return true;
    if (el.dataset && el.dataset.state === "unchecked") return false;
    return null;
}

// Read the ON/OFF switch truth - DOM first, widget.value last (only reliable
// once the graph has been serialized).
function readToggle(node) {
    const sw = widgetByName(node, "use_workflow_name");
    if (!sw) return null;
    const SEL = '[role="switch"], button[data-state], [aria-checked]';

    for (const host of domCandidates(node, sw)) {
        try {
            // exact match by widget name (the Switch is rendered with
            // aria-label = widget.name)
            const exact = host.querySelectorAll(`[aria-label="use_workflow_name"]`);
            for (const el of exact) {
                const v = stateFromSwitchEl(el);
                if (v !== null) return v;
            }
            if (typeof host.matches === "function" && host.matches(SEL)) {
                const v = stateFromSwitchEl(host);
                if (v !== null) return v;
            }
            const found = host.querySelectorAll(SEL);
            for (const el of found) {
                const v = stateFromSwitchEl(el);
                if (v !== null) return v;
            }
        } catch (e) {
            /* keep trying */
        }
    }
    if (typeof sw.checked === "boolean") return sw.checked;
    return sw.value;
}

// Idempotent per-element marker: if the framework re-renders and replaces an
// element, the fresh element has no marker, so it gets re-greyed on the next
// tick. This also means the loop below can run unconditionally and cheaply.
function markGrey(el, grey) {
    if (!el || !el.style) return;
    if (el.__wfGrey === grey) return;
    el.__wfGrey = grey;
    try {
        el.style.opacity = grey ? GREY_OPACITY : "";
        el.style.filter = grey ? "grayscale(100%)" : "";
        el.style.pointerEvents = grey ? "none" : "";
    } catch (e) {
        /* ignore */
    }
    let ctrl = null;
    try {
        ctrl = typeof el.querySelector === "function" ? el.querySelector("input, textarea, select, [role=switch]") : null;
    } catch (e) {
        ctrl = null;
    }
    const setDisabled = (target) => {
        if (!target) return;
        try {
            target.disabled = !!grey;
        } catch (e) {
            /* some read-only props throw */
        }
        try {
            target.setAttribute && target.setAttribute("aria-disabled", grey ? "true" : "false");
        } catch (e) {
            /* ignore */
        }
    };
    setDisabled(ctrl);
    if (
        el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.tagName === "SELECT" ||
        el.tagName === "BUTTON"
    ) {
        setDisabled(el);
    }
}

function setWidgetGrey(node, name, grey) {
    const w = widgetByName(node, name);
    if (!w) return;
    try {
        for (const host of domCandidates(node, w)) {
            markGrey(host, grey);
        }
        w.disabled = !!grey; // legacy litegraph flag
    } catch (e) {
        /* ignore */
    }
}

// Enforce the grey states for one node. Cheap and idempotent, so it is safe to
// call on every watchdog tick.
function applyGreyState(node) {
    const sw = widgetByName(node, "use_workflow_name");
    if (!sw) return false;
    const v = readToggle(node);
    const on = !(v === false || v === "false");
    setWidgetGrey(node, "fallback_prefix", on);
    setWidgetGrey(node, "filename", !on);
    setWidgetGrey(node, "suffix", !on);
    if (node.__wfLastSw !== v) {
        node.__wfLastSw = v;
        LOG("toggle is", v, "-> grey states refreshed");
    }
    return true;
}

function forEachWfNode(fn) {
    if (!app.graph || !app.graph.nodes) return;
    for (const node of app.graph.nodes) {
        if (node && node.type === "WorkflowFilename") {
            try {
                fn(node);
            } catch (e) {
                /* never let one bad node kill the loop */
            }
        }
    }
}

// Watchdog: re-checks every node continuously. It does not depend on nodeCreated,
// on widget callbacks, on Vue events or on any redraw hook, which is why it keeps
// working across every render mode. ~10.property reads per node per tick.
function startWatchdog() {
    if (startWatchdog.started) return;
    startWatchdog.started = true;
    const sync = () => forEachWfNode(applyGreyState);
    const tick = () => {
        sync();
        setTimeout(tick, 100);
    };
    tick();

    // Clicks should feel instant: after any click re-check a few times so the
    // grey state flips within a frame instead of up to one tick later.
    for (const ev of ["pointerup", "click", "keyup"]) {
        document.addEventListener(ev, () => {
            sync();
            for (const d of [0, 16, 48, 120]) setTimeout(sync, d);
        }, true);
    }
    LOG("grey-state watchdog started");
}

function updateNodes() {
    const name = finalName();
    if (!app.graph || !app.graph.nodes) return;
    let touched = 0;
    for (const node of app.graph.nodes) {
        if (node.type === "WorkflowFilename") {
            const w = node.widgets && node.widgets.find((x) => x.name === "filename");
            if (w) {
                w.value = name;
                touched++;
            }
            applyGreyState(node);
        }
    }
    LOG("updateNodes ->", name, "| nodes updated:", touched);
}

// ---------------------------------------------------------------------------
// Own tooltip engine (delayed by TIP_DELAY)
// ---------------------------------------------------------------------------
// Why not use ComfyUI's built-in tooltip mechanism (the `tooltip` field in
// INPUT_TYPES)? Two reasons:
//   1. Its delay comes from the GLOBAL setting "LiteGraph.Node.TooltipDelay"
//      (100..3000 ms), so tuning it would change every node in the UI.
//   2. It pops after ~500 ms by default, which is exactly the "jumpy" feeling
//      we want to avoid.
// So the texts live HERE (not in Python) and we draw our own bubble after the
// pointer has been resting on a widget for TIP_DELAY ms.
const TIP_DELAY = 1500; // ms; raise/lower freely - this plugin's own business

const WIDGET_TIPS = {
    filename:
        "[AUTO - DO NOT EDIT]\n" +
        "Filled in automatically the moment you press Run:\n" +
        "the plugin writes the CURRENT WORKFLOW'S FILE NAME here.\n" +
        "Anything you type by hand gets overwritten.",
    suffix:
        "[OPTIONAL TAG - only used while the switch is ON]\n" +
        "Output becomes: <workflow name>_<suffix>, e.g. v2 -> MyWorkflow_v2\n" +
        "DOUBLE-CLICK this field to insert a date token:\n" +
        "  %date:yyyyMMdd%         -> MyWorkflow_20261002\n" +
        "  %date:yyyy-MM-dd%       -> MyWorkflow_2026-10-02\n" +
        "  %date:yyyy-MM-dd_hhmm%   -> MyWorkflow_2026-10-02_2248\n" +
        "You can also start with a sub-folder: video/ComfyUI_%date:yyyyMMdd%\n" +
        "  -> MyWorkflow is placed IN output/video/ ...\n" +
        "(the folder is moved in FRONT, never glued to the name)\n" +
        "Tokens are expanded BY THIS NODE, not by the save node.\n" +
        "Leave EMPTY -> no tag, output is the plain workflow name.",
    use_workflow_name:
        "[MASTER SWITCH]\n" +
        "ON  (default): use the current workflow's name as the filename\n" +
        "               prefix, fully automatic.\n" +
        "OFF: ignore the workflow name, use fallback_prefix instead -\n" +
        "     and suffix is NOT applied either.",
    fallback_prefix:
        "[USED ONLY WHILE THE SWITCH IS OFF]\n" +
        "A fixed prefix of your own, e.g. h3/daily.\n" +
        "A '/' makes the save node create that sub-folder;\n" +
        "DOUBLE-CLICK this field to insert a date token, e.g.\n" +
        "h3/%date:yyyyMMdd% -> h3/20261002_\n" +
        "Leave EMPTY -> the save node keeps its own naming (ComfyUI_00001_).\n" +
        "Ignored (greyed out) while the switch is ON.",
};

let __tipEl = null;
let __tipTimer = 0; // legacy single timer slot (kept for the dismissers)
let __tipName = ""; // widget currently pending / displayed
let __reqName = ""; // widget currently counting down (shared countdown)
let __reqTimer = 0;
let __lastDomHit = 0;
const __lastMouse = { x: 0, y: 0 };
const __tipStats = {
    mouseover: 0,
    matched: 0,
    shown: 0,
    lastMatch: null,
    canvasPoll: 0,
    canvasHit: 0,
};

function tipEl() {
    if (__tipEl && document.body.contains(__tipEl)) return __tipEl;
    const d = document.createElement("div");
    d.setAttribute("wf2f-tooltip", "");
    d.setAttribute("role", "tooltip");
    // white-space:pre-line keeps the \n line breaks written above.
    d.style.cssText = [
        "position:fixed", "z-index:2147483000", "left:0", "top:0",
        "max-width:430px", "padding:10px 12px", "border-radius:8px",
        "background:rgba(22,24,30,0.97)", "color:#f3f5f9",
        "border:1px solid rgba(255,255,255,0.14)",
        "box-shadow:0 12px 30px rgba(0,0,0,0.5)",
        "font:12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        "white-space:pre-line", "pointer-events:none", "display:none",
        "opacity:0", "transition:opacity .12s ease",
    ].join(";");
    (document.body || document.documentElement).appendChild(d);
    __tipEl = d;
    return d;
}

function showTip(text, rect) {
    const t = tipEl();
    t.textContent = text;
    t.style.display = "block";
    // measure AFTER the text is set, otherwise the width is stale
    let left = rect.left;
    if (left + t.offsetWidth > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - t.offsetWidth - 8);
    }
    let top = rect.bottom + 6;
    if (top + t.offsetHeight > window.innerHeight - 8) {
        top = Math.max(8, rect.top - t.offsetHeight - 6); // flip above
    }
    t.style.left = left + "px";
    t.style.top = top + "px";
    t.style.opacity = "1";
}

function hideTip() {
    if (__tipTimer) {
        clearTimeout(__tipTimer);
        __tipTimer = 0;
    }
    if (__tipEl) {
        __tipEl.style.opacity = "0";
        __tipEl.style.display = "none";
    }
}

// --- event delegation -------------------------------------------------------
// Binding listeners to each widget element does not survive this frontend:
// Vue re-renders the node body constantly, so elements are replaced underneath
// us. Delegation on `document` instead asks, on every hover, "does this element
// live inside a WorkflowFilename node, and if so inside which widget row?" -
// independent of how often the DOM is rebuilt.
function wfNodeById(id) {
    if (id == null || !app.graph || !app.graph.nodes) return null;
    for (const n of app.graph.nodes) {
        if (n && String(n.id) === String(id) && n.type === "WorkflowFilename") return n;
    }
    return null;
}

// Map a hovered element to one of our widgets, or null when it is elsewhere.
function resolveWidgetRow(target) {
    let el = target;
    if (!el || el.nodeType !== 1) return null;
    const host = typeof el.closest === "function" ? el.closest("[data-node-id]") : null;
    if (!host) return null;
    const node = wfNodeById(host.getAttribute("data-node-id"));
    if (!node) return null; // hovered some other node -> nothing to do

    // Walk up towards the node body and remember the SMALLEST ancestor that
    // identifies a widget (the tightest match is the real row/label, not some
    // wrapper that happens to contain several widgets).
    const names = Object.keys(WIDGET_TIPS);
    let best = null;
    let cur = el;
    let guard = 0;
    while (cur && cur !== host && guard++ < 15) {
        let name = null;
        const al = cur.getAttribute ? cur.getAttribute("aria-label") : null;
        if (al && WIDGET_TIPS[al]) name = al; // reka-ui switch carries this
        if (!name) {
            const txt = (cur.textContent || "").trim();
            for (const k of names) {
                if (txt === k || txt.indexOf(k) === 0) {
                    name = k;
                    break;
                }
            }
        }
        if (name) {
            const r = cur.getBoundingClientRect();
            const area = Math.max(1, r.width * r.height);
            if (!best || area < best.area) best = { name, el: cur, area: area };
        }
        cur = cur.parentElement;
    }
    return best ? { node, name: best.name, el: best.el } : null;
}

function installDelegatedTips() {
    if (installDelegatedTips.done) return;
    installDelegatedTips.done = true;

    // === path A: hover detected through the DOM ============================
    document.addEventListener(
        "mouseover",
        (ev) => {
            __tipStats.mouseover++;
            const hit = resolveWidgetRow(ev.target);
            if (!hit) return;
            __tipStats.matched++;
            __tipStats.lastMatch = hit.name;
            __lastDomHit = Date.now();
            requestTip(hit.name, () => hit.el.getBoundingClientRect());
        },
        true
    );

    document.addEventListener(
        "mouseout",
        (ev) => {
            const rt = ev.relatedTarget;
            if (!rt) {
                requestTip(null);
                return;
            }
            const hit = resolveWidgetRow(rt);
            if (!hit || hit.name !== __reqName) requestTip(null);
        },
        true
    );

    LOG("delayed tooltip engine installed, delay =", TIP_DELAY, "ms");
}

// === path B: hover detected through the canvas ==============================
// Some ComfyUI builds DRAW the widgets on the canvas instead of rendering them
// as DOM elements. Path A cannot see those, so we ask the canvas itself which
// widget is under the cursor - the frontend uses the very same call for its own
// tooltips.
function canvasWidgetName() {
    try {
        const c = app.canvas;
        if (!c || typeof c.getWidgetAtCursor !== "function") return null;
        const node = c.node_over;
        if (!node || node.type !== "WorkflowFilename") return null;
        const w = c.getWidgetAtCursor();
        return w && WIDGET_TIPS[w.name] ? w.name : null;
    } catch (e) {
        return null;
    }
}

function installCanvasTips() {
    if (installCanvasTips.done) return;
    const el = app.canvas && app.canvas.canvas;
    if (!el) {
        // canvas not ready yet (early startup) - try again shortly
        setTimeout(installCanvasTips, 400);
        return;
    }
    installCanvasTips.done = true;
    let last = 0;
    el.addEventListener(
        "mousemove",
        (ev) => {
            __lastMouse.x = ev.clientX;
            __lastMouse.y = ev.clientY;
            const now = Date.now();
            if (now - last < 120) return;
            last = now;
            __tipStats.canvasPoll++;

            // If a DOM widget is currently hovered it owns the request - do not
            // let the canvas vote cancel it (the overlay swallows canvas moves).
            const name = canvasWidgetName();
            if (!name && Date.now() - __lastDomHit < 800) return;
            if (name) __tipStats.canvasHit++;
            requestTip(name, () => ({
                left: __lastMouse.x,
                bottom: __lastMouse.y + 16,
                top: __lastMouse.y - 16,
                right: __lastMouse.x,
            }));
        },
        true
    );
    LOG("canvas hover probe installed for delayed tooltips");
}

// --- double-click date-token picker -----------------------------------------
// Typing "%date:yyyyMMdd%" by hand is fiddly and easy to mistype, so a DOUBLE
// CLICK on a text widget pops a small menu with the supported formats. Picking
// one writes the token into the widget; clicking anywhere else - or pressing
// Esc - just dismisses the menu and leaves the value untouched.
// The sample shown on the right used to be a frozen string, so every render of
// the menu advertised the same day - it looked stale, and worse, it read like
// the token always produced that one value. Build the sample on demand instead:
// the right column is now the moment you opened the menu.
// Lower-case `hh` is the canonical spelling (Java/Unity style). The Python
// side maps BOTH `hh` and `HH` to strftime %H, i.e. always the 24 hour
// clock - so every sample below is a real 24h render, never a 12h one.
// (Earlier builds paired a capital `HH` token with a 12 hour sample
// ("..._1015" for 22:48), which read like a bug in the menu itself.)
const DATE_TOKENS = [
    { token: "%date:yyyy-MM-dd_hh-mm-ss%", sampleOf: dateAndTime },
    { token: "%date:yyyy-MM-dd%", sampleOf: dateOnly },
    { token: "%date:yyyyMMdd%", sampleOf: dateCompact },
    { token: "%date:yyyy-MM-dd_hhmm%", sampleOf: dateAndShortTime },
];

// Each helper renders the same shape the Python side writes, from a Date.
function pad2(n) {
    return String(n).padStart(2, "0");
}

function dateAndTime(now) {
    return (
        now.getFullYear() +
        "-" +
        pad2(now.getMonth() + 1) +
        "-" +
        pad2(now.getDate()) +
        "_" +
        pad2(now.getHours()) +
        pad2(now.getMinutes()) +
        pad2(now.getSeconds())
    );
}

function dateOnly(now) {
    return (
        now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate())
    );
}

function dateCompact(now) {
    return now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate());
}

function dateAndShortTime(now) {
    return dateOnly(now) + "_" + pad2(now.getHours()) + pad2(now.getMinutes());
}

// `filename` is filled in by us on Queue, so it is deliberately excluded.
const DATE_FIELDS = ["suffix", "fallback_prefix"];

let __dateMenu = null;
let __dateOpenedAt = 0;

function closeDateMenu() {
    if (__dateMenu && __dateMenu.parentNode) {
        __dateMenu.parentNode.removeChild(__dateMenu);
    }
    __dateMenu = null;
}

// Append, but keep it readable: "v2" -> "v2_<token>", while a trailing "/" ties
// into the sub-folder syntax ("h3/" -> "h3/<token>") instead of "h3/_<token>".
function joinedToken(current, token) {
    const cur = String(current == null ? "" : current).replace(/\s+$/, "");
    if (!cur) return token;
    return /\/$/.test(cur) ? cur + token : cur + "_" + token;
}

// widget.value alone is NOT enough: Vue only reads it when the graph is
// serialized, so the visible input has to be updated and nudged as well.
function writeWidgetValue(node, name, text) {
    const w = widgetByName(node, name);
    if (!w) return false;
    w.value = joinedToken(w.value, text);

    const el = w.element || w.inputEl;
    if (el && el.nodeType === 1) {
        const tag = (el.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea") {
            el.value = w.value;
            try {
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
            } catch (e) {
                /* older browsers: the widget value alone will still survive */
            }
        }
    }
    try {
        if (typeof w.callback === "function") w.callback(w.value);
    } catch (e) {
        /* ignore */
    }
    try {
        if (node && typeof node.setDirtyCanvas === "function") {
            node.setDirtyCanvas(true, true);
        }
    } catch (e) {
        /* ignore */
    }
    LOG("date token written into", name, "->", w.value);
    return true;
}

function openDateMenu(node, name, rect) {
    if (DATE_FIELDS.indexOf(name) < 0) return;
    closeDateMenu();
    requestTip(null); // our own bubble would sit right on top of the menu

    const menu = document.createElement("div");
    menu.setAttribute("data-wf2f-date-menu", "1");
    menu.style.cssText =
        "position:fixed;z-index:99999;min-width:210px;padding:6px;" +
        "background:#ffffff;border:1px solid rgba(0,0,0,.18);border-radius:8px;" +
        "box-shadow:0 6px 20px rgba(0,0,0,.18);" +
        "font:12px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#2c2c2a;" +
        "user-select:none;cursor:default;";

    const head = document.createElement("div");
    head.textContent = "Insert date token";
    head.style.cssText =
        "padding:2px 8px 6px;font-size:11px;color:#888780;border-bottom:" +
        "1px solid rgba(0,0,0,.08);margin-bottom:4px;";
    menu.appendChild(head);

    for (const item of DATE_TOKENS) {
        const row = document.createElement("div");
        row.style.cssText =
            "padding:6px 8px;border-radius:6px;cursor:pointer;display:flex;" +
            "justify-content:space-between;gap:12px;align-items:baseline;";

        const tk = document.createElement("span");
        tk.textContent = item.token;
        tk.style.cssText = "font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;";

        const sm = document.createElement("span");
        const now = new Date();
        sm.textContent = item.sampleOf(now);
        sm.style.cssText = "font-size:11px;color:#888780;";

        row.appendChild(tk);
        row.appendChild(sm);

        row.addEventListener("mouseenter", () => {
            row.style.background = "#f1efe8";
        });
        row.addEventListener("mouseleave", () => {
            row.style.background = "transparent";
        });
        // mousedown (not click) so the choice lands before the document-level
        // dismiss handler can remove the menu from under the pointer.
        row.addEventListener("mousedown", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            writeWidgetValue(node, name, item.token);
            closeDateMenu();
        });

        menu.appendChild(row);
    }

    const hint = document.createElement("div");
    hint.textContent = "click elsewhere or press Esc to dismiss";
    hint.style.cssText =
        "padding:6px 8px 2px;font-size:11px;color:#888780;border-top:" +
        "1px solid rgba(0,0,0,.08);margin-top:4px;";
    menu.appendChild(hint);

    document.body.appendChild(menu);

    // Place under the widget, flipping above / clamped horizontally when the
    // menu would otherwise fall off screen.
    const box = menu.getBoundingClientRect();
    let top = rect.bottom + 4;
    if (top + box.height > window.innerHeight - 8) {
        top = Math.max(8, rect.top - box.height - 4);
    }
    let left = rect.left;
    if (left + box.width > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - box.width - 8);
    }
    menu.style.top = top + "px";
    menu.style.left = left + "px";

    __dateOpenedAt = Date.now();
    __dateMenu = menu;
}

// --- the native "value" edit dialog ------------------------------------------
// Double-clicking a string widget opens ComfyUI's own edit dialog. We attach
// our date menu to THAT dialog (above its input) and select all of the input
// content, so the user either types a fresh string or clicks a date format.
// Picking a format REPLACES the selected content; the dialog's own OK button
// ("OK") commits it - cancelling always leaves the widget untouched.
// Same list as DATE_FIELDS, kept separate because the two paths behave a bit
// differently (widget-anchored fallback vs. native dialog bridge).
// `filename` is filled in by us on Queue, so it is excluded on purpose:
// double-clicking it gives plain ComfyUI editing, with no date menu.
const DIALOG_FIELDS = ["suffix", "fallback_prefix"];
let __dlgWatch = null;

// Which of OUR widgets did the pointer touch last? The native dialog does NOT
// tell us which field it belongs to, so we remember it. That is what makes the
// date menu work when the dialog was opened by a single click (or by keyboard,
// or programmatically) instead of through our own double-click on the row.
let __lastWidgetHit = null;
const __HIT_TTL = 3000; // ms; how long the memory stays valid for a NEW field
const __HIT_TTL_DIALOG = 60000; // ... but it stays usable while that field's
//                                  own edit dialog is still open on screen

// IMPORTANT: several frontend builds render the "value" dialog in very different
// ways - a native <dialog>, a reka-ui modal, an absolutely positioned panel
// inside the node. Missing one of them made every attempt to double-click
// inside the dialog fail, so this list is deliberately broad.
// One single definition of "this element sits in a modal/dialog", shared by
// every check below so they can never drift apart.
const DIALOG_SEL =
    '[role="dialog"], dialog, [class*="modal"], [class*="dialog"], ' +
    '[class*="popup"], [class*="overlay"], [class*="sheet"], ' +
    '[id*="dialog"], [id*="modal"], [id*="popup"]';

function inDialog(el) {
    if (!el || typeof el.closest !== "function") return false;
    try {
        return !!el.closest(DIALOG_SEL);
    } catch (e) {
        return false;
    }
}

// Is any modal/dialog currently on screen? Used to keep a still-open dialog's
// field association alive past __HIT_TTL.
function dialogOnScreen() {
    try {
        return !!document.querySelector(DIALOG_SEL);
    } catch (e) {
        return false;
    }
}

// A pointer press inside the dialog must NOT wipe the memory of which field
// the dialog belongs to - and that applies to presses we CANNOT even classify
// as a widget (that was exactly the case for the native <dialog>, which broke
// the menu whenever the dialog was opened with a single click).
function noteWidgetHit(target) {
    try {
        if (inDialog(target)) {
            // Same dialog: keep the association, just refresh its age.
            if (__lastWidgetHit) __lastWidgetHit.ts = Date.now();
            return;
        }
        // === canvas-rendered widgets =========================================
        // In canvas builds the widget rows are painted on the <canvas> - there
        // is no DOM row to walk up, so the "closest('[data-node-id]')" lookup
        // used by resolveWidgetRow() can never match. Ask the canvas itself.
        const cvsEl = app.canvas && app.canvas.canvas;
        if (cvsEl && (target === cvsEl || target.parentElement === cvsEl)) {
            const c = app.canvas;
            const node = c && c.node_over;
            const w =
                c && typeof c.getWidgetAtCursor === "function"
                    ? c.getWidgetAtCursor()
                    : null;
            const name =
                w && DIALOG_FIELDS.indexOf(w.name) >= 0 ? w.name : null;
            __lastWidgetHit =
                name && node && node.type === "WorkflowFilename"
                    ? { node, name, ts: Date.now() }
                    : null;
            return;
        }
        const hit = resolveWidgetRow(target);
        if (!hit) return; // unknown chrome (our dialog, canvas, menus...): leave it alone
        if (!hit.node || hit.node.type !== "WorkflowFilename") {
            __lastWidgetHit = null; // another node's widget -> forget ours
            return;
        }
        __lastWidgetHit =
            DIALOG_FIELDS.indexOf(hit.name) >= 0
                ? { node: hit.node, name: hit.name, ts: Date.now() }
                : null;
    } catch (e) {
        /* never clear the memory here - it is the only link to the field */
    }
}

function recentHit() {
    if (!__lastWidgetHit) return false;
    const age = Date.now() - __lastWidgetHit.ts;
    if (age < __HIT_TTL) return true;
    // The user may have read the dialog for a while before double-clicking;
    // as long as THAT dialog is still open the field is still known.
    return age < __HIT_TTL_DIALOG && dialogOnScreen();
}

// Latch the field onto the dialog's input. Once latched, any later double
// click inside the dialog opens the menu through branch (a) without having to
// re-derive (and re-expire) the "last hit" memory.
function latchDialogInput() {
    try {
        if (!__lastWidgetHit) return;
        const inp = findDialogInput();
        if (!inp) return;
        if (inp.__wf2fDialogField !== __lastWidgetHit.name) {
            inp.__wf2fDialogField = __lastWidgetHit.name;
        }
        inp.__wf2fDialogTs = Date.now();
        __lastWidgetHit.ts = Date.now();
    } catch (e) {
        /* ignore */
    }
}

function isWidgetInput(el) {
    return !!(el && el.closest && el.closest("[data-node-id]"));
}

// Is this element one of OUR node's own widget rows (as opposed to a floating
// dialog that may be rendered inside the node DOM too)?
function isOurWidgetRow(el) {
    try {
        const hit = resolveWidgetRow(el);
        return !!(hit && hit.node && hit.node.type === "WorkflowFilename");
    } catch (e) {
        return false;
    }
}

// The edit dialog renders somewhere at body level, outside any node container.
// Prefer the freshly focused input (the dialog autofocuses), then scan visible
// inputs that live in a dialog-ish host.
function findDialogInput() {
    const shaped = (el) =>
        el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
    // Focused element first: dialogs autofocus their field.
    const act = document.activeElement;
    if (shaped(act) && (act.offsetWidth || act.offsetHeight)) {
        // A field inside a modal counts even when it also happens to live in
        // the node DOM (some builds render the dialog inside the node).
        if (!isWidgetInput(act) || inDialog(act)) return act;
    }
    for (const inp of document.querySelectorAll("input, textarea")) {
        if (!shaped(inp)) continue;
        if (!inp.offsetWidth && !inp.offsetHeight) continue;
        if (!inDialog(inp)) continue;
        return inp;
    }
    return null;
}

function stopDialogWatch() {
    if (__dlgWatch) {
        if (__dlgWatch.timer) clearInterval(__dlgWatch.timer);
        __dlgWatch = null;
    }
}

// Menu bound to the dialog's input. Picking a token replaces the whole
// (pre-selected) content; the dialog still has to be confirmed with its OK
// button, so cancelling is always possible.
function showDialogDateMenu(inp) {
    requestTip(null); // our hover bubble would sit right on top of the menu
    closeDateMenu();

    const menu = document.createElement("div");
    menu.setAttribute("data-wf2f-date-menu", "1");
    menu.style.cssText =
        "position:fixed;z-index:99999;min-width:210px;padding:6px;" +
        "background:#ffffff;border:1px solid rgba(0,0,0,.18);border-radius:8px;" +
        "box-shadow:0 6px 20px rgba(0,0,0,.18);" +
        "font:12px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#2c2c2a;" +
        "user-select:none;cursor:default;";

    const head = document.createElement("div");
    head.textContent = "Insert date token";
    head.style.cssText =
        "padding:2px 8px 6px;font-size:11px;color:#888780;border-bottom:" +
        "1px solid rgba(0,0,0,.08);margin-bottom:4px;";
    menu.appendChild(head);

    for (const item of DATE_TOKENS) {
        const row = document.createElement("div");
        row.style.cssText =
            "padding:6px 8px;border-radius:6px;cursor:pointer;display:flex;" +
            "justify-content:space-between;gap:12px;align-items:baseline;";

        const tk = document.createElement("span");
        tk.textContent = item.token;
        tk.style.cssText = "font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;";

        const sm = document.createElement("span");
        const now = new Date();
        sm.textContent = item.sampleOf(now);
        sm.style.cssText = "font-size:11px;color:#888780;";

        row.appendChild(tk);
        row.appendChild(sm);

        row.addEventListener("mouseenter", () => {
            row.style.background = "#f1efe8";
        });
        row.addEventListener("mouseleave", () => {
            row.style.background = "transparent";
        });
        // mousedown (not click) so the choice lands before the document-level
        // dismiss handler can remove the menu from under the pointer.
        row.addEventListener("mousedown", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            inp.value = item.token; // replaces the select-all'ed content
            try {
                inp.dispatchEvent(new Event("input", { bubbles: true }));
                inp.dispatchEvent(new Event("change", { bubbles: true }));
                inp.focus();
                inp.setSelectionRange(item.token.length, item.token.length);
            } catch (e) {
                /* older browsers: the plain value assignment still shows */
            }
            LOG("date token written into edit dialog ->", item.token);
            closeDateMenu();
        });

        menu.appendChild(row);
    }

    const hint = document.createElement("div");
    hint.textContent =
        "picking a format replaces the whole field, Esc cancels";
    hint.style.cssText =
        "padding:6px 8px 2px;font-size:11px;color:#888780;border-top:" +
        "1px solid rgba(0,0,0,.08);margin-top:4px;";
    menu.appendChild(hint);

    document.body.appendChild(menu);

    // ABOVE the dialog input, flipping below / clamped when it would clip.
    const box = menu.getBoundingClientRect();
    const r = inp.getBoundingClientRect();
    let top = r.top - box.height - 6;
    if (top < 8) {
        top = Math.min(r.bottom + 6, window.innerHeight - box.height - 8);
    }
    let left = r.left;
    if (left + box.width > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - box.width - 8);
    }
    menu.style.top = top + "px";
    menu.style.left = left + "px";

    __dateOpenedAt = Date.now();
    __dateMenu = menu;
}

function attachDialogMenu(inp) {
    try {
        inp.focus();
        inp.select(); // selects it all, so typing replaces it
    } catch (e) {
        /* ignore */
    }
    showDialogDateMenu(inp);
}

function installDateMenu() {
    if (installDateMenu.done) return;
    installDateMenu.done = true;

    // Remember which field the pointer is on. Needed for dialogs that were
    // opened by a single click - the dialog itself never says which field it
    // belongs to, so without this memory a double-click inside it could not be
    // turned into a date menu.
    for (const ev of ["mousedown", "click", "dblclick"]) {
        document.addEventListener(ev, (e) => noteWidgetHit(e.target), true);
    }

    // Once the dialog exists, tie it to the field we remember - the dialog
    // itself never says which field it belongs to. `focusin` covers dialogs
    // that open with focus (single click / Enter), `click`/`mousedown` cover
    // the rest (keyboard, paste, programmatic).
    latchDialogInput(); // in case a dialog is already open on install
    for (const ev of ["mousedown", "click", "focusin"]) {
        document.addEventListener(ev, () => latchDialogInput(), true);
    }

    // Safety net: some builds render the dialog a tick after the click (Vue),
    // others focus it even later. Watching the DOM for newly created inputs
    // catches all of those without depending on the event timing.
    try {
        const obs = new MutationObserver(() => latchDialogInput());
        obs.observe(document.body, { childList: true, subtree: true });
    } catch (e) {
        /* older browsers / detached body: the listeners above still cover it */
    }

    document.addEventListener(
        "dblclick",
        (ev) => {
            const t = ev.target;
            // (a) inside an already-bridged dialog input: re-open the menu
            if (
                t &&
                (t.tagName === "INPUT" || t.tagName === "TEXTAREA") &&
                t.__wf2fDialogField
            ) {
                if (ev.preventDefault) ev.preventDefault();
                t.__wf2fDialogTs = Date.now();
                if (__lastWidgetHit) __lastWidgetHit.ts = Date.now();
                attachDialogMenu(t);
                return;
            }
            // (a2) a dialog opened WITHOUT our double-click (single click,
            // keyboard, paste...): adopt it, as long as we still know which of
            // our fields it belongs to and a dialog is on screen.
            if (
                t &&
                (t.tagName === "INPUT" || t.tagName === "TEXTAREA") &&
                !isOurWidgetRow(t) &&
                findDialogInput() &&
                recentHit()
            ) {
                if (ev.preventDefault) ev.preventDefault();
                const inp = findDialogInput();
                inp.__wf2fDialogField = __lastWidgetHit.name;
                attachDialogMenu(inp);
                return;
            }
            // (a3) anywhere else inside that dialog (the "value" label, padding,
            // the panel around the input): adopt its input as well.
            if (t && !isOurWidgetRow(t) && findDialogInput() && recentHit()) {
                if (ev.preventDefault) ev.preventDefault();
                const inp = findDialogInput();
                inp.__wf2fDialogField = __lastWidgetHit.name;
                attachDialogMenu(inp);
                return;
            }
            // (b) on one of OUR string widgets: ComfyUI is about to open its
            //     native edit dialog - watch for it and decorate it.
            const hit = resolveWidgetRow(ev.target);
            if (!hit || DIALOG_FIELDS.indexOf(hit.name) < 0) return;
            stopDialogWatch();
            const watch = {
                node: hit.node,
                name: hit.name,
                el: hit.el,
                until: Date.now() + 1500,
                timer: 0,
            };
            __dlgWatch = watch;
            watch.timer = setInterval(() => {
                const inp = findDialogInput();
                if (inp) {
                    stopDialogWatch();
                    inp.__wf2fDialogField = watch.name;
                    attachDialogMenu(inp);
                } else if (Date.now() > watch.until) {
                    // no dialog showed up -> fall back to the widget-anchored menu
                    stopDialogWatch();
                    if (DATE_FIELDS.indexOf(watch.name) >= 0) {
                        const w = widgetByName(watch.node, watch.name);
                        const el =
                            w && w.element && w.element.getBoundingClientRect
                                ? w.element
                                : watch.el;
                        openDateMenu(watch.node, watch.name, el.getBoundingClientRect());
                    }
                }
            }, 60);
        },
        true
    );

    // Dismiss: anything that is not the menu itself.
    //
    // pointerdown MUST be one of the listened events. The litegraph canvas
    // calls preventDefault() on pointerdown, and per the Pointer Events spec
    // that suppresses the compatibility mouse events - Chromium then never
    // dispatches mousedown at all, so a mousedown-only dismisser silently
    // fails the moment the user clicks on empty canvas (verified with a real
    // browser: pointerdown arrived, mousedown never did).
    //
    // The 200 ms grace window ignores the tail of the very click sequence that
    // opened the menu; the contains() check keeps clicks on the menu rows
    // alive - those write the token on their own mousedown/pointerdown.
    function dismissIfOutside(ev) {
        if (!__dateMenu) return;
        if (Date.now() - __dateOpenedAt < 200) return;
        if (__dateMenu.contains(ev.target)) return;
        closeDateMenu();
    }
    for (const ev of ["pointerdown", "mousedown", "wheel"]) {
        document.addEventListener(ev, dismissIfOutside, true);
    }

    document.addEventListener(
        "keydown",
        (ev) => {
            if (ev.key === "Escape" && __dateMenu) {
                ev.stopPropagation();
                closeDateMenu();
            }
        },
        true
    );

    LOG("date picker bridged to the native edit dialog for:", DIALOG_FIELDS.join(", "));
}

// Shared countdown used by both paths.
// Keeps the timer alive while the pointer stays on the SAME widget, restarts it
// when the widget changes (or is left) and always positions fresh at show time.
function requestTip(name, posFn) {
    if (!name) {
        if (__reqTimer) {
            clearTimeout(__reqTimer);
            __reqTimer = 0;
        }
        __reqName = "";
        hideTip();
        return;
    }
    // already counting down for this very widget -> keep waiting
    if (__reqName === name && __reqTimer) return;
    if (__reqTimer) {
        clearTimeout(__reqTimer);
        __reqTimer = 0;
    }
    __reqName = name;
    hideTip();
    __reqTimer = window.setTimeout(() => {
        __reqTimer = 0;
        __tipStats.shown++;
        const box = typeof posFn === "function" ? posFn() : null;
        if (box) showTip(WIDGET_TIPS[name], box);
    }, TIP_DELAY);
}

// Any interaction elsewhere should dismiss the bubble promptly.
(function installTipDismissers() {
    if (installTipDismissers.done) return;
    installTipDismissers.done = true;
    // any real interaction elsewhere kills both the bubble and the countdown
    const dismiss = () => requestTip(null);
    for (const ev of ["wheel", "scroll", "pointerdown", "keydown"]) {
        window.addEventListener(ev, dismiss, true);
    }
})();

app.registerExtension({
    name: "ComfyUI.Workflow2Filename",

    // nodeCreated may or may not fire depending on how the node got here
    // (added by hand / loaded from a saved workflow / pasted). It is therefore
    // only an optimisation - the watchdog installed in setup() is what
    // guarantees the grey state is always correct.
    nodeCreated(node) {
        if (node.type !== "WorkflowFilename") return;
        applyGreyState(node);
        let tries = 0;
        const timer = setInterval(() => {
            if (applyGreyState(node) || ++tries > 40) clearInterval(timer);
        }, 250);
    },

    setup() {
        LOG("extension loaded, frontend hooks installed");
        installDelegatedTips(); // path A: hover via DOM
        installCanvasTips(); // path B: hover via canvas (if widgets are drawn)
        installDateMenu(); // double-click a text widget -> pick a date token
        startWatchdog(); // keeps grey states live without relying on any hook

        // Diagnostics: in the browser console run __wfDebug() to see exactly
        // where the toggle value came from.
        try {
            window.__wfDebug = () => {
                const rows = [];
                forEachWfNode((node) => {
                    const sw = widgetByName(node, "use_workflow_name");
                    const host = findNodeDom(node);
                    rows.push({
                        nodeId: node.id,
                        nodeDomFound: !!host,
                        readFromDom: readToggle(node),
                        widgetValue: sw ? sw.value : "(no widget)",
                        lastSeen: node.__wfLastSw,
                    });
                });
                console.table ? console.table(rows) : console.log(rows);

                // tooltip engine diagnostics
                const probe = [];
                forEachWfNode((node) => {
                    const host = findNodeDom(node);
                    if (!host) {
                        probe.push({ nodeId: node.id, nodeDom: false });
                        return;
                    }
                    const kids = Array.from(host.querySelectorAll("*"))
                        .map((e) => (e.textContent || "").trim())
                        .filter((t) => t && t.length < 40)
                        .slice(0, 12);
                    probe.push({
                        nodeId: node.id,
                        nodeDom: true,
                        childTexts: kids.join(" | "),
                    });
                });
                console.log(
                    "%c[Workflow2Filename] tooltip engine",
                    "color:#7ab;font-weight:bold",
                    { delay: TIP_DELAY, stats: __tipStats, pending: __tipName }
                );
                console.table ? console.table(probe) : console.log(probe);
                return rows;
            };
            // Force-paint one bubble, without any hovering, to prove whether the
            // bubble itself works: __wfTipTest("suffix")
            window.__wfTipTest = (name) => {
                const key = WIDGET_TIPS[name] ? name : "suffix";
                showTip(WIDGET_TIPS[key], { left: 240, bottom: 240, top: 220, right: 240 });
                return "bubble shown for: " + key;
            };
            // Diagnostics for the date menu. After a double click inside the
            // "value" dialog, run __wfDateTest() in the console: it prints what the
            // extension thinks the dialog belongs to, whether it recognised the
            // dialog at all and whether it latched an input.
            window.__wfDateTest = () => {
                const inp = findDialogInput();
                return {
                    rememberedField: __lastWidgetHit
                        ? {
                              name: __lastWidgetHit.name,
                              ageMs: Date.now() - __lastWidgetHit.ts,
                          }
                        : null,
                    recentHit: recentHit(),
                    dialogOnScreen: dialogOnScreen(),
                    dialogInput: inp
                        ? {
                              tag: inp.tagName,
                              latchedField: inp.__wf2fDialogField || null,
                              insideNodeDom: isWidgetInput(inp),
                              insideDialog: inDialog(inp),
                          }
                        : null,
                    menuOpen: !!__dateMenu,
                };
            };
            // Force one menu, bypassing all event plumbing, to prove the menu
            // itself renders for the given field.
            window.__wfDateOpen = (name) => {
                const n = name || (__lastWidgetHit && __lastWidgetHit.name);
                if (!n) return "no field remembered - click the widget first";
                let node = __lastWidgetHit && __lastWidgetHit.node;
                if (!node) {
                    forEachWfNode((x) => {
                        if (!node && widgetByName(x, n)) node = x;
                    });
                }
                if (!node) return "WorkflowFilename node not found";
                const w = widgetByName(node, n);
                const el = w && w.element ? w.element : null;
                if (!el) return "no DOM element for widget " + n;
                const rect = el.getBoundingClientRect();
                if (!rect.width && !rect.height) return "widget element has no layout";
                openDateMenu(node, n, rect);
                return "menu opened for: " + n;
            };
        } catch (e) {
            /* ignore */
        }

        // (A) refresh widget values right after a graph loads + before queueing
        const origLoad = app.loadGraphData;
        if (typeof origLoad === "function") {
            app.loadGraphData = function (...args) {
                const r = origLoad.apply(this, args);
                updateNodes();
                return r;
            };
        }

        const origQueue = app.queuePrompt;
        if (typeof origQueue === "function") {
            app.queuePrompt = function (...args) {
                updateNodes(); // must run before the graph is serialized
                return origQueue.apply(this, args);
            };
        }

        // (B) also inject the name into extra_pnginfo so the backend can read
        // it even if the widget update is lost
        const origGraphToPrompt = app.graphToPrompt;
        if (typeof origGraphToPrompt === "function") {
            app.graphToPrompt = async function (...args) {
                const result = await origGraphToPrompt.apply(this, args);
                try {
                    const name = finalName();
                    if (result && result.workflow) {
                        if (!result.workflow.extra) result.workflow.extra = {};
                        result.workflow.extra.workflowName = name;
                        result.workflow.name = name;
                    }
                } catch (e) {
                    /* ignore */
                }
                return result;
            };
        }

        updateNodes();
    },
});
