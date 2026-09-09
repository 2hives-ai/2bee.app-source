import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { parseScad, sceneLines, type ScadResult, type SceneLine } from './scad';
import { meshScene, type MeshResult } from './mesh';
import { CadPreview, type CadCamera } from './preview';
import { CadEditor, marksFromConsole, type CadEditorHandle } from './editor';
import { CadConsole, consoleBadge, consoleLines } from './console';
import { CadOpen, MOUNT_A_FOLDER } from './open';
import { claimPending, subscribeHandoff, type PendingDesign } from '../shop/handoff';
import ObjectPicker, { type ObjectItem } from '../ObjectPicker';
import { buildCadRecord, isCadRecord, type CadBuild } from './record';
import { GAPS, MenuBar, OMISSIONS, cadMenus, onCadKeyDown } from './menu';
import {
  ASK_PANEL_VISIBLE,
  AskPanel,
  AskSettings,
  readAskConfig,
  writeAskConfig,
  type AskConfig,
} from './ask';
import {
  canRedo,
  canUndo,
  initialEditor,
  redo as redoEditor,
  redoLabel,
  replaceWith,
  stored as storedAs,
  typed,
  undo as undoEditor,
  undoLabel,
  type EditorState,
} from './replace';
import {
  EMPTY_LIBRARY,
  makeLibraryHost,
  type LibraryMiss,
  type ScadLibrary,
} from './library';
import {
  SESSION_SAVE_MS,
  SESSION_SHAPE,
  readStoredSession,
  writeSession,
  type CadSession,
} from './session';
import { list as listSaved, saveCadModel } from '../store';
import { CAD_DEFAULT_PROJECTION, readProjection, type Projection } from '../projection';

// 2bee.cad stage 2 — an editor, a parse result, and a preview with a kernel
// behind it.
//
// 🔴 THE STAGE-1 HEADER SAID "THERE IS NO 3D VIEW HERE AND THAT IS THE POINT",
// and it was right for the tree it had: a viewport fed by an UNEVALUATED tree
// draws what the code says rather than what it means, so every `difference()`
// appears as the solid it was meant to cut away from. That condition is what
// changed, not the rule. `mesh.ts` now computes the booleans and AUDITS the
// result, and the preview refuses to draw anything the audit cannot stand
// behind. The rule the old header encoded — no picture without a kernel — is
// still the rule; it is simply satisfied now.
//
// What has NOT changed: nothing this lane produces has ever cut anything, and
// this tab emits no toolpath and no G-code.
//
// 🔴 WHAT HAS CHANGED, 2026-08-10, AND THE HEADER SAID THE OPPOSITE UNTIL THIS
// LINE: this tab IS now connected to the CNC side. Founder: *"in the 1st tab
// (cad) we should able to save the cad files in the same list as drawings"* —
// `SaveToDrawings` below writes a model into the `drawings` collection, which is
// the list the other tab picks parts from. A stale "not connected" is not a
// harmless leftover here: it is the sentence a reader uses to decide that
// nothing in this file can reach a spindle.
//
// The connection is a MESH, and the other tab is 2.5D: what it cuts is ONE FLAT
// SECTION of that mesh at one Z, never the solid drawn here. That is the lane's
// standing scope rule and the record carries the words with it.
//
// 🔴 AND IT IS NOW A ROUND TRIP, 2026-08-11. Founder: *"load existing file from
// a list?"* — `CadOpen` reads a saved model's SOURCE back into this editor.
// Until then `loadCadModel` existed in the store with no caller at all: a model
// could be written and never re-opened, which made saving a one-way trip.
//
// This file is self-contained by design: it adds no CSS to the shared sheet and
// no dependency to the lockfile. Layout is inline; colours come from the theme
// variables that `styles.css` already defines, so the tab follows the app theme
// without owning a copy of the palette.
//
// 🔴 THE MESH IS DEBOUNCED AND THE PARSE IS NOT. Parsing is microseconds and
// runs on every keystroke; meshing a boolean is tens to hundreds of milliseconds
// and would make the editor stutter, so it settles 250 ms after typing stops.
// Between the two, the picture on screen is of the PREVIOUS source — which is a
// wrong picture, so the preview is told and marks itself STALE. A viewport that
// silently lags the editor is the same defect as one that draws the wrong shape,
// arriving more slowly.
//
// ---------------------------------------------------------------------------
// THE LAYOUT IS OPENSCAD'S, AND IT WAS READ RATHER THAN REMEMBERED
// ---------------------------------------------------------------------------
//
// Founder 2026-08-11: *"make panels look like the same as openscad!"*. Checked
// against OpenSCAD 2026.08.07's own `src/gui/MainWindow.ui` — Qt dock areas,
// where 1 = left, 2 = right, 8 = bottom:
//
//   · `editorDock`   dockWidgetArea 1  → LEFT
//   · `qglview`      inside `centralwidget` → the MAIN area
//   · `consoleDock`  dockWidgetArea 8  → BOTTOM, full width
//   · `errorLogDock` dockWidgetArea 8  → BOTTOM, tabbed with the console
//   · `parameterDock` (the Customizer) dockWidgetArea 2 → RIGHT
//
// So: editor left, 3D central, a full-width TABBED pane along the bottom. The
// bottom pane being tabbed is not an invention — OpenSCAD puts two docks in
// that one area and Qt tabs them.
//
// 🔴 WHAT IS DELIBERATELY NOT COPIED, because a dead control is worse than a
// missing one and this tab is the wrong place to start faking a surface:
//
//   · NO CUSTOMIZER DOCK. It reads `/* [Section] */` annotations and parameter
//     sets, and `docs/openscad-feature-inventory.md` records that we parse
//     neither. An empty Customizer would say "this model has no parameters",
//     which is a claim about the MODEL made by a feature that does not exist.
//   · NO F5/F6 SPLIT. OpenSCAD's toolbar carries Preview and Render as separate
//     actions because they are different computations. Here `mesh.ts` always
//     computes real booleans and always audits the result — there is one
//     evaluation path. Two buttons doing the same thing would assert a
//     capability difference we do not have.
//   · NO ANIMATE / FONT-LIST / COLOR-LIST / VIEWPORT-CONTROL DOCKS. No
//     animation loop and no font engine (`text()` is refused by name).
//     🔴 THE COLOUR HALF OF THIS LINE WENT STALE ON 2026-08-11 and is corrected
//     rather than deleted: it said there was *"no colour model (`color()` passes
//     geometry through and discards the colour)"*, and `color()` was implemented
//     that day — 148 CSS Color 4 names, `#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa`,
//     alpha, and the outermost-wins rule read at OpenSCAD's own source. What is
//     still absent is the DOCK: a colour-scheme list is a preferences surface
//     for the editor's own palette, and this app takes its palette from brand
//     tokens. A stale 🔴 lies exactly like a stale ✅.
//   · NO TOOLBAR ICONS BORROWED. The founder asked for the LAYOUT. This app has
//     its own brand tokens and chrome, and importing another tool's palette
//     into an app that has one would be a different change with a different
//     owner (`brand`).
//
// 🔴 AND THERE IS NOW A MENU BAR, 2026-08-11. Founder: *"create a similar menu
// structure in the 2bee.cad what looks like openscad (open/save … etc)"*. It is
// `menu.tsx`, held to the same rule as the docks above — **no item whose
// function we do not have** — so it carries a dozen of OpenSCAD's 105 actions
// and Help → About lists what was left out and why, in TWO lists: what does not
// exist (`OMISSIONS`) and what exists-but-is-not-wired or is simply unbuilt
// (`GAPS`). One list holding both kinds meant "absent" could not be read as
// "impossible", which is the only thing that made it worth printing.
//
// 🔴 IT BINDS EXACTLY ONE KEY — `Ctrl+S` — AND THIS LINE SAID "NONE" UNTIL
// 2026-08-11. F5 stays unbound (intercepting a reload on a page that has needed
// one is a worse trap) and the `beforeunload` guard below covers it along with
// Ctrl+W, the back button and the tab close. **Ctrl+S is different and the guard
// never covered it**: Save Page does not unload the document, so an operator got
// a completed browser save dialog and a false belief that their MODEL was saved.
// Binding it removes that; see `menu.tsx`'s header for why Ctrl+N and Ctrl+Z stay
// unbound, and for the two reasons that are not F5's.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 2026-08-11 — WHAT WAS TAKEN OFF THIS TAB, AND WHAT REPLACED IT
// ═══════════════════════════════════════════════════════════════════════════
//
// Founder, verbatim: *"remove Open a saved model , alerts"*, *"remove alert
// Exported a binary STL"*, *"remove What this tab is not"*, *"Remove Scene
// Tree"*, *"remove MESH AUDITED"*.
//
// One rule covers all five: **REMOVE EVERY NOTICE THAT ALWAYS SAYS YES; KEEP
// EVERY REFUSAL.** A confirm that fires on each replace, an alert that says the
// export worked, a green that says the mesh was audited — each appears when
// things are FINE, which is nearly always, so it carries no information and
// teaches an operator past the one that does. This tab already made that
// argument against itself, in `PendingReplace`'s own words: *"a press that
// always says yes is how people learn to click through the one that matters"*.
// It was true of the confirm too.
//
//   · **The two-press confirm on New / Example / Open is GONE**, and the thing
//     it was standing in for is now real. `replace.ts` stashes the text every
//     replacement displaces and the toolbar carries ONE put-back. That is
//     strictly better than the confirm in both directions: no press in the
//     ordinary case, and an actual recovery in the bad one — where a confirm
//     cost a press every time and recovered nothing once pressed through.
//     ⚠ It is a put-back for ONE ACTION, not an undo for typing, and the label
//     says which. This tab has no history of keystrokes and must not imply one.
//   · **The `Exported a binary STL` alert is GONE.** The refusal is not: an
//     export blocked by the audit still reports, now in the error colour, and
//     an export that WROTE A FILE MISSING FEATURES still says so, because that
//     is a stated absence rather than a receipt.
//   · **The `What this tab is not` banner is GONE**, with each of its nine
//     sentences either deleted as stale/duplicated or moved to where it acts —
//     see the note above `runCommand`'s `help.about` branch.
//   · **The scene tree is menu-toggled**, not a permanent tab. `Design →
//     Display CSG Tree` and `View → Scene tree` are what open it, so the menu
//     commands have a job and nothing is orphaned.
//   · **`MESH AUDITED — watertight` is GONE from the picture.** `preview.tsx`
//     says nothing when the audit is clean and says it loudly when it is not.
//
// 🔴 AND ONE PANE NOW SENDS SOMETHING SOMEWHERE, 2026-08-11. Founder: *"in the
// 2bee.cad add a freetext what will call an llm api call … to change the scad"*.
// `ask.tsx` is the whole of it and it is the ONLY outbound path in this app.
// What matters here is what it does NOT do: it ships with no endpoint, no model
// id and no key, so a fresh browser cannot send anything at all; and a model's
// answer is a PROPOSAL that is reviewed by the same parser and the same audit as
// any other source, never text that lands in this editor. `setSrc` is reachable
// from it through exactly one callback that only its `accept` action can fire.

// Dev-only: pre-fetch the hardware/cad/ SCAD tree at module load time so the
// library is available before the first render. The Vite plugin at
// /__cad-library serves every .scad file as a JSON map.
//
// 🔴 THIS IS A MODULE-TOP-LEVEL AWAIT — Vite handles it in dev mode. The
// fetch runs once when the module is imported, and the result is cached in
// `devLibrary`. Components read it synchronously via `useState(() => ...)`,
// so there is no flash of "no library" and no race with the parser.
let devLibrary: ScadLibrary = EMPTY_LIBRARY;
if (import.meta.env?.DEV) {
  try {
    const r = await fetch('/__cad-library');
    if (r.ok) {
      const data: { rootName: string; files: Record<string, string> } = await r.json();
      const files = new Map<string, string>();
      for (const [path, source] of Object.entries(data.files)) {
        files.set(path, source);
      }
      devLibrary = { files, rootName: data.rootName || 'cad', pickedAt: Date.now(), skipped: [] };
    }
  } catch {
    /* Not an error — the plugin may not be running. */
  }
}

const EXAMPLE = `// 2bee.cad. Edit freely: this parses on every keystroke.
// Millimetres and degrees, as in OpenSCAD.

$fn = 48;
wall = 6;
w = 120;
d = 80;
h = 40;

module post(r, height) {
    cylinder(h = height, r = r);
}

difference() {
    cube([w, d, h]);
    translate([wall, wall, -1])
        cube([w - 2 * wall, d - 2 * wall, h]);
}

for (i = [0 : 3]) {
    translate([i * 30 + 10, d + 20, 0]) post(5, 25);
}

// Try uncommenting either line below and watch it get named, not ignored:
// hull() { sphere(5); translate([20, 0, 0]) sphere(5); }
// minkowski() { cube(10); sphere(2); }
`;

/**
 * 🔴 WHAT SURVIVED THE `What this tab is not` BANNER, AND WHY ONLY THIS.
 *
 * The banner carried nine sentences at the top of the tab, read once and then
 * scrolled past forever. Seven of them are gone because they were STALE or
 * already said at the point where they act — the reassignment divergence is
 * warned by the parser at the exact line, the 2D-operand refusal is a console
 * row on the boolean that hit it, the un-unioned top-level shapes are in the
 * viewport's own hint, the shortcuts are the File menu's footnote, and the
 * "only outbound path" sentence is the first line of the Ask panel.
 *
 * These two had no home: they are properties of the WHOLE evaluator rather than
 * of any one diagnostic, so they belong in the report a reader asked for, next
 * to the omissions. **They are not decoration — the first names the two ways
 * this kernel is known to be wrong, and the second is the tab's contract.**
 */
const KERNEL_LIMITS: string[] = [
  'The kernel is a BSP tree over triangles, not a robust solid modeller. Its two known failure modes ' +
    'are coplanar faces (two operands sharing a face plane exactly — overshoot a cut by a fraction of ' +
    'a millimetre) and near-degenerate geometry (features close to the 0.00001 mm classification ' +
    'tolerance). Every result is audited for closure and the verdict rides on the picture.',
  'This is a SUBSET of the OpenSCAD language, not the language. Anything outside it is listed by name ' +
    'and by line in the console, contributes nothing to the tree, and is therefore MISSING from the ' +
    'picture — read the picture as a subset of your model, never as a proof of it.',
  /* 🔴 MOVED HERE 2026-08-11 FROM THE VIEWPORT FOOTER, which the founder removed
   * whole. The other two sentences in that footer were the drag directions (now
   * the viewport's own tooltip) and the never-cut disclaimer (which is already
   * two lines above this one, in this same report). THIS one had nowhere else to
   * be, and it is the one that surprises people: it is a real semantic difference
   * between what you are looking at and what an STL export contains. Deleting the
   * footer without moving it would have removed the knowledge, not the clutter. */
  'Top-level shapes are drawn SEPARATELY and are NOT unioned — the same as OpenSCAD’s preview. Two ' +
    'overlapping top-level solids are two solids in the picture and two solids in the exported STL, ' +
    'not one merged body. Wrap them in union() if that is what you meant.',
];

function Counts({ result }: { result: ScadResult }) {
  const c = result.counts;
  return (
    <div className="grid2" data-testid="cad-counts" style={{ marginBottom: 12 }}>
      <span>primitives</span>
      <strong>{c.primitives}</strong>
      <span>transforms</span>
      <strong>{c.transforms}</strong>
      <span>booleans in the tree</span>
      <strong>{c.booleans}</strong>
      <span>groups</span>
      <strong>{Math.max(c.groups, 0)}</strong>
      <span>refused by name</span>
      <strong style={{ color: result.unsupported.length ? 'var(--warn)' : undefined }}>
        {result.unsupported.length}
      </strong>
      <span>warnings</span>
      <strong style={{ color: result.warnings.length ? 'var(--warn)' : undefined }}>
        {result.warnings.length}
      </strong>
      <span>errors</span>
      <strong style={{ color: result.errors.length ? 'var(--bad)' : undefined }}>{result.errors.length}</strong>
    </div>
  );
}

function TreeView({ lines, onGoToLine }: { lines: SceneLine[]; onGoToLine: (n: number) => void }) {
  if (lines.length <= 1) {
    return (
      <p className="note" data-testid="cad-tree-empty">
        Nothing in this source produced a scene node. An empty tree means nothing was understood, not that
        the model is empty.
      </p>
    );
  }
  return (
    <div data-testid="cad-tree" style={{ font: '11.5px/1.5 var(--mono)' }}>
      {lines.slice(1).map((l, i) => (
        // The program root is scaffolding, not something the user wrote — hence
        // the slice. Every other node names a line, so every other node is a
        // place the caret can go.
        <button
          key={i}
          type="button"
          data-testid="cad-tree-row"
          data-line={l.line}
          onClick={() => onGoToLine(l.line)}
          style={{
            display: 'block',
            width: '100%',
            textAlign: 'left',
            font: 'inherit',
            padding: '1px 4px',
            background: 'transparent',
            color: 'var(--ink)',
            border: '1px solid transparent',
            borderRadius: 'var(--radius)',
            cursor: 'pointer',
            whiteSpace: 'pre',
          }}
        >
          <span style={{ color: 'var(--muted)' }}>{String(l.line).padStart(4, ' ')}</span>
          {'  '}
          {'  '.repeat(Math.max(l.depth - 1, 0))}
          {l.text}
        </button>
      ))}
    </div>
  );
}

/** Long enough that a burst of typing produces one mesh, short enough that a
 *  pause reads as instant. The STALE marker is what makes the delay honest. */
const MESH_DEBOUNCE_MS = 250;

/**
 * Pane geometry, persisted.
 *
 * Follows the `2bee.app.panels.open` precedent in `App.tsx` rather than
 * inventing a second mechanism: a single JSON object under one `2bee.app.*`
 * key, read once, written on change, and every read validated at the point of
 * use so one corrupt field cannot discard the rest. It is deliberately NOT in
 * `store.ts`'s session blob — that blob holds machining configuration, and
 * where a splitter sits is chrome.
 */
const LAYOUT_KEY = '2bee.app.cad.layout';

interface CadLayout {
  /** Fraction of the main row given to the editor, 0.2…0.8. */
  split: number;
  /** Height of the bottom dock in CSS pixels. */
  dock: number;
  /** Which bottom tab is showing. */
  tab: BottomTab;
  /**
   * OpenSCAD's `view/showAxes`, and its default is OpenSCAD's — TRUE.
   *
   * 🔴 IT DEFAULTS ON FOR A REASON THIS TAB CAN NAME, not merely for parity.
   * The origin cross is what marks `[0,0,0]`, and the orbit pivot is now the XY
   * centre of the model at z = 0 rather than the world origin — so with the
   * axes off there is nothing on screen that says where zero is, on a tab whose
   * whole language is `translate()`. Off by default would ship a viewport with
   * no origin reference.
   */
  axes: boolean;
  /**
   * OpenSCAD's `view/showScaleProportional`, also defaulting TRUE.
   *
   * 🔴 A CHILD OF {@link CadLayout.axes}, exactly as in OpenSCAD — the menu item
   * is disabled while axes are off (`MainWindow.cc:2761`) and the renderer ANDs
   * the two (`GLView.cc:198`). It is STORED independently so that turning axes
   * back on restores the scale setting the operator last chose, rather than
   * silently resetting it.
   */
  scaleMarkers: boolean;
  /**
   * OpenSCAD's `view/orthogonalProjection`, stored as the word.
   *
   * 🔴 DEFAULT **PERSPECTIVE**, WHICH IS OPENSCAD'S — read at `Camera.h:29`
   * (`projection{ProjectionType::PERSPECTIVE}`) and at `MainWindow.cc:2872`,
   * where `viewTogglePerspective()` reads the persisted bool and an unset key
   * gives `false`. It is stored here, beside the two instrument toggles, because
   * OpenSCAD stores it in the same place as `view/showAxes` and
   * `view/showScaleProportional` and restores all three from one
   * `loadViewSettings()`.
   *
   * ⚠ THE CNC TAB DEFAULTS THE OTHER WAY, on purpose. See
   * `CNC_DEFAULT_PROJECTION` in `projection.ts` for the reason — it is a
   * judgement about dimensional reading, not a preference, and the two tabs are
   * asserted to differ so a later tidy-up cannot quietly align them.
   */
  projection: Projection;
}

type BottomTab = 'console' | 'tree' | 'ask';

/**
 * 🔴 `pinned` IS THE WHOLE OF "Remove Scene Tree" (founder, 2026-08-11).
 *
 * An UNPINNED pane is still a real pane — it renders, `readLayout` still accepts
 * it, and the menu still opens it — it simply has no permanent button in the
 * strip. That is what OpenSCAD does with the dock this mirrors, and it is the
 * only shape that removes the tree from the default screen WITHOUT orphaning
 * `Design → Display CSG Tree` and `View → Scene tree`, which is the dead-control
 * defect this lane has now found six times.
 *
 * ⚠ Its button appears while it IS the showing pane, or the operator would have
 * no way to tell what they are looking at and no way back.
 */
const BOTTOM_TABS: { id: BottomTab; label: string; pinned: boolean }[] = [
  { id: 'console', label: 'Console', pinned: true },
  { id: 'tree', label: 'Scene tree', pinned: false },
  /* Gated on the module constant rather than on a prop: whether this app offers
   * a network feature at all is the lane's decision, and it should be one token
   * to change. ⚠ The safety property does not depend on it — with no endpoint
   * and no key, which is what every fresh browser has, the panel refuses before
   * a request is constructed. */
  ...(ASK_PANEL_VISIBLE ? ([{ id: 'ask', label: 'Ask a model', pinned: true }] as const) : []),
];

/**
 * The dock tab's DOM id — referenced by the pane's `aria-labelledby`.
 *
 * Named apart from `Tabs.tsx`'s `tab-<id>` on purpose: both widgets are on the
 * page at once whenever the CAD tab has been opened, and two elements sharing an
 * id is a document where `aria-controls` resolves to whichever came first.
 */
export function dockTabDomId(id: BottomTab): string {
  return `cad-dock-tab-${id}`;
}

/**
 * The pane's DOM id — referenced by EVERY dock tab's `aria-controls`.
 *
 * One element, because the panes swap inside one container rather than each
 * being a hidden sibling. See the strip's note at the foot of this file for what
 * that buys (an unmount, which is what makes manual activation the right call)
 * and what it costs (tabs cannot each name their own panel).
 */
export const DOCK_PANEL_ID = 'cad-dock-panel';

/**
 * Where an arrow key moves focus in the dock strip, or `null` for a key this
 * widget does not claim.
 *
 * 🔴 PURE, AND SEPARATE FROM THE HANDLER, so the off-by-one can be watched
 * failing without a browser: `null` for `Tab`, for `Enter`, for anything else —
 * a tab widget that swallowed `Tab` would trap a keyboard user inside the strip,
 * and one that swallowed `Enter` would stop the manual activation this widget
 * depends on. Wrapping at both ends, per the WAI-ARIA APG and per `Tabs.tsx`.
 *
 * ⚠ `count` IS THE RENDERED SET, not `BOTTOM_TABS`. `Scene tree` is unpinned and
 * has a button only while it is showing, so the strip is 2 or 3 buttons wide
 * depending on what is selected — arithmetic against the full list would step
 * past the end of the row that is actually on screen.
 */
export function nextDockTabIndex(key: string, i: number, count: number): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  if (key === 'ArrowRight') return i === last ? 0 : i + 1;
  if (key === 'ArrowLeft') return i === 0 ? last : i - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  return null;
}

export const DEFAULT_LAYOUT: CadLayout = {
  split: 0.44,
  dock: 180,
  tab: 'console',
  /* Both true, which is OpenSCAD's default for both, read at
   * `MainWindow.cc:512` and `:518` rather than assumed. See the fields. */
  axes: true,
  scaleMarkers: true,
  /* OpenSCAD's default, read at `Camera.h:29` rather than assumed. */
  projection: CAD_DEFAULT_PROJECTION,
};

export function readLayout(raw: string | null | undefined): CadLayout {
  try {
    if (!raw) return DEFAULT_LAYOUT;
    const v = JSON.parse(raw) as Partial<CadLayout> | null;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return DEFAULT_LAYOUT;
    return {
      split:
        typeof v.split === 'number' && Number.isFinite(v.split)
          ? Math.min(0.8, Math.max(0.2, v.split))
          : DEFAULT_LAYOUT.split,
      dock:
        typeof v.dock === 'number' && Number.isFinite(v.dock)
          ? Math.min(600, Math.max(0, v.dock))
          : DEFAULT_LAYOUT.dock,
      tab: BOTTOM_TABS.some((t) => t.id === v.tab) ? (v.tab as BottomTab) : DEFAULT_LAYOUT.tab,
      /* 🔴 `=== false` RATHER THAN `?? true` OR A TRUTHINESS TEST. The only
       * value that may turn an instrument OFF is the literal `false` somebody
       * stored; a corrupt field, a missing field, a `0` or a `"no"` all fall
       * back to the default, which is ON. An instrument that vanishes because a
       * preference blob went bad is a viewport the operator reads as broken. */
      axes: v.axes === false ? false : DEFAULT_LAYOUT.axes,
      scaleMarkers: v.scaleMarkers === false ? false : DEFAULT_LAYOUT.scaleMarkers,
      /* Same rule as the two above, through the shared validator: only one of
       * the two words is honoured and everything else — missing, corrupt, `true`,
       * `"ortho"` — falls back to the default rather than to a third state. */
      projection: readProjection(v.projection, DEFAULT_LAYOUT.projection),
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function readStoredLayout(): CadLayout {
  try {
    return readLayout(globalThis.localStorage?.getItem(LAYOUT_KEY));
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function writeLayout(l: CadLayout) {
  try {
    globalThis.localStorage?.setItem(LAYOUT_KEY, JSON.stringify(l));
  } catch {
    /* A browser with storage disabled loses the preference and nothing else. */
  }
}


/**
 * A drag handle between two panes. No dependency: a splitter is a pointer
 * capture and a delta, and `TODO.md` #12 makes every lockfile addition a
 * licence review against AGPL-3.0-or-later. It is a `<div role="separator">`
 * with arrow-key support, because a splitter that only responds to a drag is
 * unusable from a keyboard.
 */
function Splitter({
  vertical,
  onDelta,
  label,
  testid,
}: {
  /** True for a left/right splitter (it is itself a vertical bar). */
  vertical: boolean;
  onDelta(px: number): void;
  label: string;
  testid: string;
}) {
  const last = useRef<number | null>(null);
  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={label}
      data-testid={testid}
      tabIndex={0}
      onPointerDown={(e) => {
        last.current = vertical ? e.clientX : e.clientY;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (last.current === null) return;
        const now = vertical ? e.clientX : e.clientY;
        onDelta(now - last.current);
        last.current = now;
      }}
      onPointerUp={() => {
        last.current = null;
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 10;
        if (e.key === (vertical ? 'ArrowLeft' : 'ArrowUp')) {
          onDelta(-step);
          e.preventDefault();
        } else if (e.key === (vertical ? 'ArrowRight' : 'ArrowDown')) {
          onDelta(step);
          e.preventDefault();
        }
      }}
      style={{
        flex: '0 0 auto',
        [vertical ? 'width' : 'height']: 6,
        cursor: vertical ? 'col-resize' : 'row-resize',
        background: 'transparent',
      }}
    />
  );
}

/**
 * 🔴 THE ONE WRITER. Both doors into the store — the dialog below and `File →
 * Save` on a model that already has a name — call THIS, so "may this be saved"
 * is decided in one place and the record that lands is built the same way from
 * the same source whichever door was used. A second `buildCadRecord` call
 * beside a copy of its conditions is the thing that eventually disagrees.
 */
async function writeCadModel(args: {
  name: string;
  /** The source the mesh is OF. Never the editor's text. */
  source: string;
  parse: ScadResult;
  mesh: MeshResult;
}): Promise<{ ok: true; stored: string } | { ok: false; why: string }> {
  const built = buildCadRecord({ ...args, now: Date.now() });
  if (!built.ok) return { ok: false, why: `${built.refusal.headline}. ${built.refusal.detail}` };
  try {
    await saveCadModel(built.record, Date.now());
  } catch (e) {
    return { ok: false, why: String(e instanceof Error ? e.message : e) };
  }
  /* 🔴 THE BASELINE IS THE SOURCE THAT WAS STORED, not the editor's text. They
   * differ whenever the mesh is a keystroke behind, and calling the editor
   * "saved" on the strength of a record built from a different string is how
   * unsaved work gets discarded by an open with no warning. */
  return { ok: true, stored: built.record.cad.source };
}

/**
 * Save this model into the DRAWINGS list — the same one the CNC tab picks parts
 * from. Founder 2026-08-10: *"in the 1st tab (cad) we should able to save the
 * cad files in the same list as drawings"*.
 *
 * 🔴 IT IS A DIALOG WITH THE EXISTING LIST IN IT, NOT A NAME BOX (founder,
 * 2026-08-11: *"File Save... should bring up a window (similar to the list) to
 * save, not an alert"*). The list is not decoration and it is not symmetry with
 * Open: **`store.ts::save()` keys on the NAME, so saving over an existing name
 * replaces that record and the old one is gone** — no undo, no server copy. A
 * bare name box asks for a name against an INVISIBLE set, so the operator finds
 * the collision after it has destroyed something. With the list on screen the
 * collision is visible before the commit, and replacing becomes a thing you
 * chose — you can select the row you mean to overwrite.
 *
 * The rules this control exists to make visible, all of which live in
 * `record.ts` and none of which are re-implemented here:
 *
 *   · 🔴 THE SOURCE SAVED IS THE SOURCE THAT WAS MESHED, never what is in the
 *     editor. Those differ for 250 ms after every keystroke, and a record built
 *     from the editor text with a mesh of the previous text is born stale — a
 *     cached mesh that does not belong to its source, with a checksum pair that
 *     says so and a user who never saw a warning. The button additionally
 *     REFUSES while the preview is marked STALE, so the two never even race.
 *   · 🔴 AN AUDIT THAT DID NOT RETURN `closed` REFUSES THE SAVE OUTRIGHT, with
 *     the audit's own sentence. This is the CNC tab's input; a solid with holes
 *     or a non-manifold edge still sections into a closed-looking outline that
 *     posts, simulates and cuts. **That verdict is shown in this dialog, before
 *     a name is typed** — being refused after naming a file and pressing save is
 *     the thing the founder called an alert.
 *   · REFUSED CONSTRUCTS DO NOT refuse the save — they TRAVEL, and the row in
 *     the drawings list says so at selection time. A model missing `minkowski()`
 *     is a real closed solid that is missing a feature. It is stated here too,
 *     where the decision is made, because the person who cuts it later may not
 *     be the person who drew it.
 *   · SAVING OVER A NAME REPLACES IT, and the control says which of the two it
 *     is about to do BEFORE it is pressed — the store will not ask again.
 *
 * ⚠ SUCCESS IS SILENT. The dialog closing is the confirmation; a strip that
 * only ever says the save worked is the same defect as the export alert that
 * was removed in the same pass.
 */
function SaveDialog({
  source,
  parse,
  mesh,
  stale,
  initialName,
  onSaved,
  onClose,
}: {
  /** The source the mesh is OF. Not the editor's text. */
  source: string;
  parse: ScadResult;
  mesh: MeshResult;
  stale: boolean;
  /** The name this model already has, if it has one. */
  initialName: string;
  /** Told the exact text that was stored AND the name it was stored under. */
  onSaved(source: string, name: string): void;
  onClose(): void;
}) {
  const [name, setName] = useState(initialName);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [existing, setExisting] = useState<{ name: string; savedAt: number; isCad: boolean }[]>([]);
  const [namesRead, setNamesRead] = useState(false);

  const refreshNames = useCallback(() => {
    listSaved('drawings')
      .then((items) => {
        setExisting(
          items.map((i) => ({ name: i.name, savedAt: i.saved_at, isCad: isCadRecord(i.data) })),
        );
        setNamesRead(true);
      })
      /* 🔴 A FAILED READ IS SAID, not swallowed into an empty list. An empty
       * list and an unreadable one look identical on screen, and the difference
       * decides whether "Save" or "Replace" is the true word for what is about
       * to happen. `namesRead` stays false so the control says it does not know. */
      .catch((e) => setNote(`could not read the saved drawings: ${String(e)}`));
  }, []);
  useEffect(refreshNames, [refreshNames]);

  /* 🔴 THE SAME GATE, CALLED TWICE, rather than one call plus a copy of its
   * conditions. This build is thrown away — it exists only so the control can
   * show the refusal (or the summary) BEFORE the button is pressed — and the
   * real record is built again on click with the real name. Encoding a small
   * STL twice is cheap; a second implementation of "may this be saved" is the
   * thing that eventually disagrees with the first. The placeholder name only
   * reaches the STL's 80-byte header. */
  const preview: CadBuild = useMemo(
    () => buildCadRecord({ name: 'preview', source, parse, mesh, now: 0 }),
    [source, parse, mesh]
  );

  const clean = name.trim();
  const hit = namesRead ? existing.find((e) => e.name === clean) : undefined;
  const taken = !!hit;
  const blocked = stale
    ? 'the preview is still catching up with the editor — the mesh on screen is of the previous source. ' +
      'A model saved now would store a mesh that does not belong to its source. It clears in a moment.'
    : !preview.ok
      ? preview.refusal.headline
      : !clean
        ? 'give it a name'
        : null;

  /**
   * 🔴 EVERY EXISTING NAME IS A ROW, INCLUDING THE ONES THAT ARE NOT 2bee.cad
   * MODELS. The store keys on the name alone, so an imported DXF called
   * `bracket` IS a thing this save would destroy — leaving it out of the list
   * would hide exactly the collision the list exists to show. Nothing here is
   * disabled: every row is a real replace target, and choosing one is how an
   * operator says "that one" rather than typing it and hoping.
   */
  const rows = useMemo(
    (): ObjectItem[] =>
      existing.map((e) => ({
        id: e.name,
        name: e.name,
        detail: e.isCad
          ? 'a 2bee.cad model · saving under this name REPLACES it'
          : 'an imported drawing (no 2bee.cad source) · saving under this name REPLACES it',
        properties: [
          {
            label: 'Where this came from',
            value:
              `YOU saved this in THIS browser on ${new Date(e.savedAt).toLocaleString()}. ` +
              'Clearing site data deletes it — there is no server copy.',
          },
          {
            label: 'What choosing it does',
            value:
              'It puts this name in the box. Saving then REPLACES this record with the model in the ' +
              'editor, and the old one is gone — there is no undo.',
          },
        ],
      })),
    [existing],
  );

  const doSave = async () => {
    setBusy(true);
    setNote('');
    try {
      const out = await writeCadModel({ name: clean, source, parse, mesh });
      if (!out.ok) {
        setNote(`NOT saved — ${out.why}`);
        return;
      }
      /* ⚠ SILENT ON SUCCESS. The dialog closes and the drawings list has it;
       * a strip saying it worked is the alert this pass removed everywhere. */
      onSaved(out.stored, clean);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const c = preview.ok ? preview.record.cad : null;

  return (
    <div className="block" data-testid="cad-save" style={{ marginBottom: 8 }}>
      <strong>Save into the drawings list</strong>
      <p className="note">
        The same list the CNC tab picks parts from — a model saved here is a part there. What is stored
        is the 2bee.cad SOURCE (so it stays editable) and the evaluated mesh beside it as a cache, each
        with a checksum, so a mesh that stops matching its source is reported rather than cut.
      </p>

      <ObjectPicker
        label="Already saved in this browser — choosing one REPLACES it"
        testid="cad-save-picker"
        mode="single"
        placeholder={rows.length ? 'choose a name to replace…' : 'nothing is saved in this browser yet'}
        searchPlaceholder="name…"
        items={rows}
        selectedIds={taken ? [clean] : []}
        onChange={(ids) => setName(ids[0] ?? '')}
        emptyMessage="Nothing is saved in this browser yet, so nothing can be replaced — whatever you name this is a new record."
      />

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '8px 0' }}>
        <input
          data-testid="cad-save-name"
          aria-label="name this model"
          value={name}
          placeholder="name this model…"
          onChange={(e) => setName(e.target.value)}
          style={{
            flex: '1 1 200px',
            minWidth: 160,
            padding: '6px 8px',
            background: 'var(--bg)',
            color: 'var(--ink)',
            border: `1px solid ${taken ? 'var(--warn)' : 'var(--line)'}`,
            borderRadius: 'var(--radius)',
          }}
        />
        <button
          type="button"
          data-testid="cad-save-go"
          disabled={!!blocked || busy}
          onClick={() => void doSave()}
        >
          {/* 🔴 THE BUTTON SAYS WHICH OF THE TWO IT WILL DO. `save()` replaces on
              a name collision and never asks; the moment to know that is before
              the press, not in the note afterwards. While the name list is
              unreadable the button will not claim either — it says so instead. */}
          {!namesRead ? 'Save (name list unread)' : taken ? `REPLACE "${clean}"` : 'Save to drawings'}
        </button>
        <button type="button" data-testid="cad-save-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>

      {taken ? (
        <p className="warn" data-testid="cad-save-replaces" style={{ margin: '0 0 6px' }}>
          A {hit?.isCad ? '2bee.cad model' : 'drawing'} called <strong>{clean}</strong> is already saved
          in this browser. Saving REPLACES it, and the old one is gone — there is no server copy and no
          undo.
        </p>
      ) : null}

      {blocked ? (
        <p className="bad" data-testid="cad-save-blocked" style={{ margin: '0 0 6px' }}>
          Cannot save: {blocked}
          {!stale && !preview.ok ? <> {preview.refusal.detail}</> : null}
        </p>
      ) : null}

      {c ? (
        <div className="grid2" data-testid="cad-save-summary">
          <span>solids</span>
          <strong>{c.solids}</strong>
          <span>triangles</span>
          <strong>{c.triangles}</strong>
          <span>mesh audit</span>
          <strong>{c.verdict}</strong>
          <span>spans Z</span>
          <strong>
            {c.z_span_mm[0].toFixed(2)} … {c.z_span_mm[1].toFixed(2)} mm
          </strong>
          <span>section chosen for you</span>
          <strong>{c.mid_height_z_mm.toFixed(2)} mm</strong>
          <span>complete?</span>
          <strong style={{ color: c.complete ? undefined : 'var(--bad)' }}>
            {c.complete
              ? 'yes — nothing was refused'
              : `NO — ${c.unsupported.length + c.issues.filter((i) => i.severity === 'refused').length} refused, features missing`}
          </strong>
          {c.flats_dropped > 0 ? (
            <>
              <span>2D shapes not saved</span>
              <strong>{c.flats_dropped}</strong>
            </>
          ) : null}
        </div>
      ) : null}

      {c && !c.complete ? (
        <p className="warn" data-testid="cad-save-incomplete" style={{ marginBottom: 0 }}>
          This save is allowed and the part will be MISSING those features. They are recorded in the
          drawing and shown when it is selected in the CNC tab, because the person who cuts it may not be
          the person who drew it.
        </p>
      ) : null}

      {note ? (
        <p className="bad" data-testid="cad-save-note" style={{ marginBottom: 0 }}>
          {note}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Why one import was not read, in one sentence, in ONE PLACE.
 *
 * 🔴 IT IS EXTRACTED BECAUSE IT NOW HAS TWO READERS. {@link ImportReport} prints
 * it in the panel, and the editor's gutter mark puts it on the failing line's
 * `title` (founder, 2026-08-11: *"show it in the editor as well"*). Two copies of
 * an operator-facing sentence is two things to keep true, and the one nobody
 * edits is the one that goes stale — so there is one, and it is a function.
 *
 * 🔴 IT NAMES A MENU ITEM, SO IT WENT STALE THE MOMENT THAT ITEM MERGED — AND
 * THIS NOTE PREDICTED IT: *"if `File → Open library folder…` ever merges into
 * `Open`, this sentence changes with it or it becomes an instruction to use a
 * control that is not there."* That merge happened on 2026-08-11 (founder:
 * *"have just 1 open!"*), and the sentence changed in the same commit. The path
 * now lives in `open.tsx` as {@link MOUNT_A_FOLDER} — beside the control it
 * names, so the two cannot drift — and a test compares it against the menu.
 *
 * ⚠ Plain text, not JSX: a `title` attribute cannot hold an element. The panel
 * gave `resolved` a `<code>` wrapper and no longer does — the cost of one writer,
 * and paid deliberately.
 */
function missReason(m: LibraryMiss): string {
  switch (m.why) {
    case 'no-library':
      return `no library folder is mounted, so nothing could be read. ${MOUNT_A_FOLDER}`;
    case 'escapes-the-folder':
      return 'this path climbs OUT of the folder you picked. Pick a folder further up, or move the file in.';
    default:
      return `no such file at ${m.resolved} in the folder you picked.`;
  }
}

/**
 * What the imports in the current source did, stated where a refusal would be.
 *
 * 🔴 THE PARSER'S OWN REFUSAL SAYS *"could not be resolved"* AND CANNOT SAY MORE
 * — `ScadFileHost.read` returns a file or `null`, with nowhere to put a reason.
 * This is the reason. An operator staring at an unknown module needs to know
 * that the path climbed out of the folder they picked, or that the file they
 * meant is one directory over, and neither is guessable from "unresolved".
 *
 * ⚠ CANDIDATES ARE OFFERED, NEVER SUBSTITUTED. A near-miss resolved for you is
 * how a model gets drawn from the wrong file, perfectly, with no error anywhere.
 */
function ImportReport({ misses, reads }: { misses: readonly LibraryMiss[]; reads: readonly string[] }) {
  if (misses.length === 0) return null;
  return (
    <div className="block" data-testid="cad-import-misses" style={{ flex: '0 0 auto', marginBottom: 8 }}>
      <strong style={{ color: 'var(--bad)' }}>
        {misses.length} import(s) in this source were NOT read
      </strong>
      <ul className="notes" style={{ marginTop: 4 }}>
        {misses.map((m, i) => (
          <li key={`${m.spec}-${i}`} data-testid="cad-import-miss" data-why={m.why}>
            <code>&lt;{m.spec}&gt;</code>
            {m.from ? <> from <code>{m.from}</code></> : null} —{' '}
            {missReason(m)}
            {m.candidates.length > 0 ? (
              <>
                {' '}These exist and may be what you meant — nothing was substituted for you:{' '}
                {m.candidates.map((c) => (
                  <code key={c} style={{ marginRight: 6 }}>
                    {c}
                  </code>
                ))}
              </>
            ) : null}
          </li>
        ))}
      </ul>
      {reads.length > 0 ? (
        <p className="note" style={{ marginBottom: 0 }}>
          {reads.length} import(s) DID resolve: {reads.join(', ')}
        </p>
      ) : null}
    </div>
  );
}

/** An empty file, with the one sentence a blank editor cannot say for itself. */
const BLANK = `// A new, empty 2bee.cad model. Millimetres and degrees.
// Nothing is saved anywhere until you save it into the drawings list below.
`;

/**
 * A read-only answer the menu produced. Never a modal — it cannot trap focus.
 *
 * ⚠ `tone` exists because ONE of these is now a refusal rather than an answer.
 * With the export's success alert gone, a blocked export is the only thing that
 * appears in this slot unbidden, and it must not look like the report you get
 * from `Help → About`.
 */
interface MenuReport {
  title: string;
  lines: string[];
  tone?: 'bad';
}

export function CadTab() {
  /**
   * 🔴 THE EDITOR'S TEXT, WHAT IS ON DISK, AND WHAT A REPLACEMENT DISPLACED —
   * one value, in `replace.ts`, whose rules are pure and asserted.
   *
   * `baseline` is the STORED string, not "the editor at the moment we pressed
   * save": those differ during the mesh debounce and the record stores the
   * meshed one. `replaced` is what the put-back puts back, and it is set by
   * every action that replaces the editor and by nothing else — typing does not
   * touch it, because this is not an undo for typing.
   */
  /**
   * 🔴 WHAT THE LAST SESSION LEFT, READ EXACTLY ONCE — see {@link readSession}.
   *
   * A ref rather than a `useState` initialiser because THREE pieces of state
   * are seeded from it (the editor, the name, the camera) and they are declared
   * hundreds of lines apart. Three initialisers each calling `readStoredSession`
   * would be three reads that could disagree if anything wrote in between, and
   * one initialiser feeding the other two through a side effect is an ordering
   * dependency nobody can see.
   */
  const boot = useRef<CadSession | null | undefined>(undefined);
  if (boot.current === undefined) boot.current = readStoredSession();
  const opened = boot.current;

  /**
   * 🔴 THE EDITOR'S TEXT, WHAT IS ON DISK, AND WHAT A REPLACEMENT DISPLACED —
   * one value, in `replace.ts`, whose rules are pure and asserted.
   *
   * ⚠ `baseline` COMES BACK SEPARATELY FROM `src`, NOT DERIVED FROM IT. `dirty`
   * is `src !== baseline`, so seeding both from `src` would make every restored
   * session look SAVED — the unsaved-changes marker gone, the leave guard
   * unregistered, and an operator one `File → New` away from losing work the tab
   * had just told them was safe.
   */
  const [ed, setEd] = useState<EditorState>(() =>
    opened
      ? {
          src: opened.src,
          baseline: opened.baseline,
          /* The one entry that was worth the quota. See {@link CadSession}. */
          past: opened.undoStep ? [opened.undoStep] : [],
          future: [],
        }
      : initialEditor(EXAMPLE),
  );
  const { src, baseline } = ed;
  const setSrc = useCallback((text: string) => setEd((s) => typed(s, text)), []);
  const setBaseline = useCallback((stored: string) => setEd((s) => storedAs(s, stored)), []);
  const editor = useRef<CadEditorHandle>(null);

  /**
   * 🔴 THAT THIS TEXT CAME BACK OUT OF A BROWSER STORE IS ITSELF A FACT THE
   * OPERATOR NEEDS, and it is the answer to *"a restored dirty buffer must be
   * distinguishable from a saved model of the same name"*.
   *
   * Without it: `bracket` is the name, the editor holds something that is NOT
   * what `bracket` contains, and the only difference on screen is the generic
   * `unsaved changes` marker — which also appears while you are simply editing a
   * model you opened a minute ago and can still remember. `File → Save` on a
   * named model saves SILENTLY and by design, so the moment to know which text
   * you are looking at is before that press, not after.
   *
   * ⚠ IT IS CLEARED BY ANY ACTION THAT INSTALLS KNOWN TEXT — `New`, `Example`,
   * an open, an applied proposal — and by a successful save. It is deliberately
   * NOT cleared by typing: text you have edited on top of a restored buffer is
   * still descended from it, and the name still does not describe it.
   */
  const [restored, setRestored] = useState(opened !== null);
  /**
   * Whether the browser is actually keeping this session. `false` ⇒ a write was
   * refused (quota, or storage disabled) and the key has been REMOVED rather
   * than left stale. The tab says so; a persistence feature that fails silently
   * is worse than one that was never offered, because the operator has stopped
   * saving on the strength of it.
   */
  const [sessionKept, setSessionKept] = useState(true);

  const [layout, setLayout] = useState<CadLayout>(readStoredLayout);
  const patch = useCallback((p: Partial<CadLayout>) => {
    setLayout((old) => {
      const next = { ...old, ...p };
      writeLayout(next);
      return next;
    });
  }, []);

  const mainRow = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLDivElement>(null);

  /**
   * 🔴 THE LIBRARY, AND THE HOST THAT RESOLVES AGAINST IT. Without one every
   * `include`/`use` refuses BY NAME — which is the parser's design, not a
   * failure: an unresolved import is never treated as an empty file.
   *
   * ⚠ A FRESH HOST PER PARSE. `misses` and `reads` describe ONE parse; a host
   * reused across parses would keep reporting a resolution failure that has
   * since been fixed, and a stale red reads exactly like a stale green.
   */
  const [library, setLibrary] = useState<ScadLibrary>(devLibrary);
  /** Where the editor's own source sits in the library, so `../` means something. */
  const [selfPath, setSelfPath] = useState('');

  const parsed = useMemo(() => {
    const host = makeLibraryHost(library);
    return { result: parseScad(src, { host, path: selfPath }), misses: host.misses, reads: host.reads };
  }, [src, library, selfPath]);
  const result = parsed.result;
  const lines = useMemo(() => sceneLines(result.scene), [result]);

  // The source the MESH is currently of. Parsing again from it is microseconds
  // and keeps this a pure function of one string, rather than a second copy of
  // the tree that could disagree with the one on the right.
  const [meshSrc, setMeshSrc] = useState(src);
  useEffect(() => {
    const id = setTimeout(() => setMeshSrc(src), MESH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [src]);
  /* 🔴 THE PARSE OF THE MESHED SOURCE IS KEPT, not discarded. It used to be
   * inlined — `meshScene(parseScad(meshSrc).scene)` — which threw away the
   * REFUSAL LIST for exactly the source the mesh is of. `result` above is the
   * parse of the EDITOR's text, and during the debounce window the two disagree
   * about which constructs were refused. A record built from one and the other
   * would carry a refusal list belonging to a different source: the one thing
   * saved with a part that must not be about a different part. */
  const meshParse = useMemo(
    () => parseScad(meshSrc, { host: makeLibraryHost(library), path: selfPath }),
    [meshSrc, library, selfPath],
  );
  const mesh = useMemo(() => meshScene(meshParse.scene), [meshParse]);
  const stale = meshSrc !== src;
  const dirty = src !== baseline;

  const goToLine = useCallback((line: number) => editor.current?.goToLine(line), []);

  /**
   * The one door text takes into this editor from an ACTION rather than a
   * keystroke. Everything that replaces the editor goes through it, so
   * everything that replaces the editor is put-backable by construction — there
   * is no second path that could forget.
   */
  /**
   * 🔴 THE NAME THIS MODEL ALREADY HAS, or `null` for one that has never been
   * saved. It is what makes `File → Save` able to be SILENT: a model with a
   * name just saves, and only a model without one has to ask.
   *
   * ⚠ EVERY REPLACEMENT CLEARS IT unless the replacement itself brought a name
   * (an open did). `New`, `Example`, an accepted proposal and the put-back all
   * install text that is not the named record any more, and a plain `Save` that
   * silently overwrote `bracket` with a blank file because the name outlived
   * its content is the exact destruction this dialog exists to make visible.
   * Clearing costs one dialog; not clearing costs a record.
   */
  const [savedName, setSavedName] = useState<string | null>(opened?.savedName ?? null);

  const replaceEditor = useCallback((what: string, next: string, named: string | null = null) => {
    setEd((s) => replaceWith(s, { next, what, isStored: named !== null }));
    setSavedName(named);
    /* The text on screen is now something this session chose, not something a
     * store handed back — so the restore marker has nothing left to warn about
     * and would become the permanently-present notice this tab keeps deleting. */
    setRestored(false);
  }, []);

  /**
   * A design picked in the Designs tab arrives here.
   *
   * 🔴 IT GOES THROUGH `replaceEditor`, WHICH IS THE WHOLE POINT. That pushes
   * onto `replace.ts`'s history, so a user who had unsaved text in the editor
   * when they went shopping can PUT IT BACK. Writing the session store instead
   * — the obvious implementation — would either be ignored (this tab reads that
   * key once, at mount) or land on top of unsaved work with no undo. See
   * `shop/handoff.ts`.
   *
   * ⚠ THE LIBRARY AND `selfPath` ARE SET BEFORE THE TEXT, and neither is
   * optional. `parseScad` resolves `use`/`include` RELATIVE TO THE IMPORTING
   * FILE, so a design installed without its path resolves `../lib/box.scad`
   * against the wrong directory; and a production build has NO library at all
   * (the `/__cad-library` route is dev-only), so the closure has to travel with
   * the design or every import refuses in the built app and nowhere else.
   */
  const acceptDesign = useCallback(
    (d: PendingDesign) => {
      const files = new Map<string, string>();
      for (const [path, source] of Object.entries(d.files)) files.set(path, source);
      setLibrary({ files, rootName: 'Designs', pickedAt: Date.now(), skipped: [] });
      setSelfPath(d.path);
      replaceEditor(`the design "${d.title}"`, d.source, null);
    },
    [replaceEditor],
  );

  useEffect(() => {
    const held = claimPending();
    if (held) acceptDesign(held);
    return subscribeHandoff(acceptDesign);
  }, [acceptDesign]);


  /** A save moved what is on disk, and gave this model a name. */
  const onSaved = useCallback(
    (storedSource: string, name: string) => {
      setBaseline(storedSource);
      setSavedName(name);
      /* After a save the record and the editor agree, which is exactly what the
       * marker exists to deny. */
      setRestored(false);
    },
    [setBaseline],
  );

  const openModel = useCallback(
    (source: string, name: string) => {
      /* `isStored`: what was just opened IS what is on disk. `New`, `Example`
       * and an accepted proposal are not, and calling them saved would let the
       * next open discard them without a word.
       *
       * The mesh is re-derived from the new text by the debounce like any other
       * edit. It is NOT taken from the record's cached STL: that cache is the
       * CNC tab's input, and re-evaluating the source here is the only way the
       * picture in this tab is a picture of the text in this editor. */
      replaceEditor(`opening "${name}"`, source, name);
    },
    [replaceEditor],
  );

  /* ═══════════════════════════════════════════════════════════════════════
     KEEPING THE SESSION — one writer, two triggers
     ═══════════════════════════════════════════════════════════════════════ */

  /**
   * The camera, held in a ref rather than in state.
   *
   * 🔴 IT MUST NOT RE-RENDER THIS TAB. The preview reports a camera after every
   * orbit, pan and wheel gesture (debounced there), and this component parses a
   * source on every render path it touches. A `useState` here would re-render
   * the editor, the console and the tree because somebody moved the mouse over
   * the picture.
   */
  const cameraRef = useRef<CadCamera | null>(opened?.camera ?? null);
  /**
   * The document, mirrored for the camera path.
   *
   * ⚠ THE CAMERA CALLBACK IS STABLE (`[]`) SO IT CANNOT CLOSE OVER `ed`. Without
   * this mirror it would write the source it saw on the first render forever —
   * a session that restores an hour-old buffer with nothing anywhere reporting
   * an error, which is precisely the failure this feature is supposed to end.
   */
  const docRef = useRef({ ed, savedName });
  useEffect(() => {
    docRef.current = { ed, savedName };
  });

  /** One shape, built in one place, so the two triggers cannot store different
   *  things about the same moment. */
  const sessionNow = useCallback(
    (e: EditorState, name: string | null, camera: CadCamera | null): CadSession => ({
      v: SESSION_SHAPE,
      src: e.src,
      baseline: e.baseline,
      savedName: name,
      undoStep: e.past.length > 0 ? e.past[e.past.length - 1] : null,
      camera,
    }),
    [],
  );

  /**
   * Trigger 1 — the document changed. Debounced, because this writes the whole
   * source and the source changes on every keystroke.
   *
   * ⚠ `ed.past` IS IN THE DEPENDENCIES, not just `ed.src`. The put-back entry is
   * the thing worth storing; a dependency list that watched only the text would
   * miss the moment an auto-applied proposal created the entry, which is the one
   * event this whole store exists for.
   */
  useEffect(() => {
    const id = setTimeout(() => {
      setSessionKept(writeSession(sessionNow(ed, savedName, cameraRef.current)));
    }, SESSION_SAVE_MS);
    return () => clearTimeout(id);
  }, [ed, savedName, sessionNow]);

  /**
   * Trigger 2 — the camera stopped moving. Written straight out: it is already
   * debounced in the preview, and waiting for an editor change that may never
   * come would lose the view of anyone who framed a model and then read it.
   */
  const onCameraChange = useCallback(
    (camera: CadCamera) => {
      cameraRef.current = camera;
      const { ed: e, savedName: name } = docRef.current;
      setSessionKept(writeSession(sessionNow(e, name, camera)));
    },
    [sessionNow],
  );

  /* ---- the menu bar, and everything it needs to say true things ---------- */

  const [report, setReport] = useState<MenuReport | null>(null);
  /** The Open picker is mounted on demand — see the note in `open.tsx`. */
  const [openShowing, setOpenShowing] = useState(false);
  /**
   * 🔴 THE ENDPOINT CONFIG IS THE TAB'S, NOT THE ASK PANE'S — moved 2026-08-11.
   *
   * Founder: *"when endpoint set move it to the settings tab under File and
   * hide"*. That makes `File → Settings…` a SECOND surface editing the same
   * three values, and a pane and a dialog each holding their own `useState`
   * copy of one preference is how a dialog saves a model id the pane then does
   * not use. One owner, one writer, and the persistence beside it.
   *
   * ⚠ The key's storage rule is unchanged and travelled with the values, not
   * with the component: `writeAskConfig` omits `apiKey` unless `rememberKey` is
   * on, and `readAskConfig` refuses to read one back out of a forged blob.
   */
  const [askCfg, setAskCfg] = useState<AskConfig>(() => {
    try {
      return readAskConfig(globalThis.localStorage);
    } catch {
      return readAskConfig(null);
    }
  });
  const patchAsk = useCallback((patch: Partial<AskConfig>) => {
    setAskCfg((old) => {
      const next = { ...old, ...patch };
      try {
        writeAskConfig(next, globalThis.localStorage);
      } catch {
        /* Storage disabled: the setting lives for this session and nothing else. */
      }
      return next;
    });
  }, []);
  /** `File → Settings…`, and the route back from a failed call. */
  const [settingsShowing, setSettingsShowing] = useState(false);
  const settingsPanel = useRef<HTMLDivElement>(null);
  const openSettings = useCallback(() => {
    setSettingsShowing(true);
    queueMicrotask(() => settingsPanel.current?.scrollIntoView({ block: 'nearest' }));
  }, []);
  /** So is the Save dialog — see {@link SaveDialog}. */
  const [saveShowing, setSaveShowing] = useState(false);
  const openPanel = useRef<HTMLDivElement>(null);
  const savePanel = useRef<HTMLDivElement>(null);
  /** Where `Jump to next error` is in the console's own ordering. */
  const errorCursor = useRef(-1);

  /**
   * 🔴 THE SAME GATE THE SAVE BUTTON USES, CALLED AGAIN — not a copy of its
   * conditions. `File → Export as STL` and `Save to drawings` write the same
   * bytes from the same encoder, so they refuse on the same terms, and the one
   * way to guarantee that is to ask the same function.
   */
  const exportBuild = useMemo(
    () => buildCadRecord({ name: 'export', source: meshSrc, parse: meshParse, mesh, now: 0 }),
    [meshSrc, meshParse, mesh],
  );
  const saveBlocked = stale
    ? 'The preview is still catching up with the editor, so the mesh on screen is of the previous source. It clears in a moment.'
    : exportBuild.ok
      ? null
      : `${exportBuild.refusal.headline}. ${exportBuild.refusal.detail}`;

  /** Every diagnostic that names a line, in the order the console lists them. */
  const jumpTargets = useMemo(() => consoleLines(result, mesh), [result, mesh]);

  /**
   * 🔴 THE TAB BADGE, FROM THE PANE'S OWN LIST — the last hop of a defect that
   * was otherwise fixed and invisible (`112d2e34b9` landed `consoleBadge()`
   * exported, tested, and rendered by nothing, because this file is where the
   * tab strip lives).
   *
   * What it replaces: `result.errors.length + result.unsupported.length +
   * result.warnings.length`, a SECOND SUM over the PARSE result only. The mesher
   * refuses things the parser accepts, so
   * `difference() { cube(10); circle(3); }` gave tab badge **0** and console row
   * **1 REFUSED** — and with any other pane showing there was no signal at all
   * that something had been refused.
   *
   * ⚠ `jumpTargets` IS THE LIST `CadConsole` IS GIVEN. The badge and the pane are
   * one list by construction rather than by agreement, which is the whole point:
   * the defect was two producers, and a second sum is exactly what drifts.
   */
  const badge = useMemo(() => consoleBadge(jumpTargets), [jumpTargets]);

  /* ── THE BOTTOM DOCK'S TAB WIDGET ────────────────────────────────────────
   *
   * The strip that renders these is at the foot of this file and carries the
   * reasoning; this is the state it needs. `dockTabs` is the RENDERED set — the
   * pinned panes plus the unpinned one while it is showing — and it is computed
   * ONCE so the strip, the roving index and the arrow keys cannot disagree about
   * which tabs exist. Deriving it twice is how "the third tab" means two
   * different buttons on the same screen. */
  const dockTabs = useMemo(
    () => BOTTOM_TABS.filter((t) => t.pinned || layout.tab === t.id),
    [layout.tab]
  );
  /* Refs so an arrow key can MOVE FOCUS rather than only change a number. With a
   * roving tabindex the newly focused tab is the only one in the tab order, and
   * leaving focus behind would strand the keyboard user outside the strip.
   * `Tabs.tsx` keeps the same map for the same reason. */
  const dockTabRefs = useRef(new Map<BottomTab, HTMLButtonElement | null>());
  /**
   * Arrow / Home / End over the strip. **Focus only — selection is `Enter` or
   * `Space`**, which the button element already gives us; see the strip's note
   * for why this widget is manual where `Tabs.tsx` is automatic.
   *
   * ⚠ Wrapping, like the APG and like `Tabs.tsx`. Nothing else is intercepted —
   * `Tab` must still leave the strip, and a key this does not handle returns
   * before `preventDefault`.
   */
  const onDockKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>, i: number) => {
      const next = nextDockTabIndex(e.key, i, dockTabs.length);
      if (next === null) return;
      e.preventDefault();
      dockTabRefs.current.get(dockTabs[next].id)?.focus();
    },
    [dockTabs]
  );

  /**
   * 🔴 THE SAME DIAGNOSTICS, ON THEIR LINES IN THE GUTTER. Founder, 2026-08-11:
   * *"show it in the editor as well"*. The console takes you FROM a diagnostic
   * TO a line; nothing took you the other way, so an operator looking at line 12
   * had to hold the list in their head.
   *
   * 🔴 THE UNRESOLVED-IMPORT CASE IS ENRICHED, and the join is exact rather than
   * fuzzy: the parser's refusal carries `use <spec>` / `include <spec>` as its
   * own name, so the bracketed spec is a delimiter-bounded substring the parser
   * itself produced — not a heuristic match on a filename. Without this the mark
   * would say the file was not read and NOT say the one thing that fixes it,
   * which is the sentence the founder quoted.
   *
   * ⚠ STALENESS IS DECIDED IN `marksFromConsole`, not here: mesh rows are of the
   * previous source and their line numbers may have moved, so they do not mark
   * until the mesh catches up. The console still shows them, grouped and labelled
   * — it has room to say "these may lag" and a one-character mark does not.
   */
  const marks = useMemo(() => {
    const rows = jumpTargets.map((r) => {
      const miss =
        r.severity === 'refused' && r.name
          ? parsed.misses.find((m) => r.name!.includes(`<${m.spec}>`))
          : undefined;
      return miss ? { ...r, text: `${r.text} ${missReason(miss)}` } : r;
    });
    return marksFromConsole(rows as readonly import('./editor').DiagnosticRow[], { meshStale: stale, src });
  }, [jumpTargets, parsed.misses, stale, src]);

  const runCommand = useCallback(
    (id: string) => {
      switch (id) {
        case 'file.new':
          replaceEditor('New', BLANK);
          break;
        case 'file.example':
          replaceEditor('Example', EXAMPLE);
          break;
        case 'file.open':
          /* 🔴 THE MENU MOUNTS THE PICKER WITH ITS LIST ALREADY UP, it does not
           * scroll to a panel that is always there. This used to `focusPanel` a
           * permanent block, which is exactly what coupled the two: deleting the
           * block would have deleted Open. The ellipsis on `Open…` promises a
           * chooser, so a chooser is what appears — see `defaultOpen` in
           * `open.tsx`. */
          setOpenShowing(true);
          queueMicrotask(() => openPanel.current?.scrollIntoView({ block: 'nearest' }));
          break;
        case 'file.save':
          /* 🔴 `Save` ON A MODEL THAT ALREADY HAS A NAME JUST SAVES. No dialog,
           * no strip, nothing to dismiss — which is the whole of the principle
           * this pass applies. A model that has never been saved has no name to
           * save under, so it falls through to the dialog ONCE and then stops
           * asking. */
          if (savedName === null) {
            setSaveShowing(true);
            queueMicrotask(() => savePanel.current?.scrollIntoView({ block: 'nearest' }));
            break;
          }
          if (saveBlocked) {
            /* The audit refuses this model. Saying so is not an alert — it is
             * the refusal, and it is the same one the dialog shows before a
             * name is typed. */
            setReport({ title: 'Save REFUSED — nothing was written', lines: [saveBlocked], tone: 'bad' });
            break;
          }
          void writeCadModel({ name: savedName, source: meshSrc, parse: meshParse, mesh }).then((out) => {
            if (out.ok) onSaved(out.stored, savedName);
            else setReport({ title: 'Save REFUSED — nothing was written', lines: [out.why], tone: 'bad' });
          });
          break;
        case 'file.settings':
          /* 🔴 ALWAYS AVAILABLE, WHATEVER THE PANE IS SHOWING. The Ask pane
           * collapses to the prompt box once an endpoint is set, so this is the
           * only permanent door to the endpoint, the model id and the key —
           * including when the configured endpoint is broken, which is exactly
           * when it is needed and exactly when the pane no longer offers it. */
          openSettings();
          break;
        case 'file.save-as':
          setSaveShowing(true);
          queueMicrotask(() => savePanel.current?.scrollIntoView({ block: 'nearest' }));
          break;
        case 'file.export.stl': {
          if (!exportBuild.ok || stale) {
            /* 🔴 THE REFUSAL IS THE ONE THING IN THIS SLOT THAT GOT LOUDER.
             * With the success alert gone, this is the only report that appears
             * unbidden — so it is marked, rather than looking like the answer
             * `Help → About` gives. */
            setReport({ title: 'Export REFUSED — no file was written', lines: [saveBlocked ?? 'refused'], tone: 'bad' });
            break;
          }
          /* 🔴 THE BYTES ARE THE RECORD'S, and the record was built from the
           * source the MESH was evaluated from — not from the editor's text,
           * which differs for 250 ms after every keystroke. An STL whose
           * geometry belongs to a different string than the one on screen is
           * exactly the plausible-wrong-part this lane exists to refuse. */
          const rec = exportBuild.record;
          const blob = new Blob([rec.bytes as BlobPart], { type: 'model/stl' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `${savedName ?? '2bee-cad-model'}.stl`;
          a.click();
          URL.revokeObjectURL(a.href);

          /* 🔴 A SUCCESSFUL EXPORT NOW SAYS NOTHING (founder, 2026-08-11:
           * *"remove alert Exported a binary STL"*). The browser's own download
           * is the confirmation, and a dialog that only ever says "it worked"
           * teaches an operator to dismiss dialogs unread — which is what makes
           * the refusal above ineffective.
           *
           * 🔴 WHAT IS NOT A RECEIPT STAYS. An export can succeed and still
           * write a file that is MISSING features, because a refused construct
           * does not block a save — only the audit does. That is a stated
           * absence about a file already on the operator's disk, and it is the
           * one thing they cannot see by looking at the download. Likewise a 2D
           * shape that had no volume to write. When neither is true there is
           * nothing to say, and nothing is said. */
          const refusedCount =
            rec.cad.unsupported.length + rec.cad.issues.filter((i) => i.severity === 'refused').length;
          const absences = [
            refusedCount > 0
              ? `${refusedCount} construct(s) were REFUSED and are MISSING from the file just written. ` +
                'It is a real closed solid that is missing features — read it as a subset of your model.'
              : '',
            rec.cad.flats_dropped > 0
              ? `${rec.cad.flats_dropped} 2D shape(s) were not written — a zero-thickness plate has no ` +
                'volume to put in an STL.'
              : '',
          ].filter(Boolean);

          /* 🔴 COLOUR IS DROPPED AT EXPORT, SAID OUT LOUD RATHER THAN LEFT TO BE
           * NOTICED. Binary STL is a triangle soup with an unused 16-bit
           * attribute per face; the "colour" conventions that exploit that field
           * are vendor extensions no two readers agree on, and our own reader
           * ignores it. Writing one would produce a file that looks coloured in
           * one program and wrong in the next. So nothing is written — and
           * because this tab now DRAWS the colour, an operator has every reason
           * to expect the file to carry it. That expectation is what this line
           * corrects.
           *
           * ⚠ IT IS A NOTE, NOT AN ALARM, AND THE TONE IS THE POINT. A `color()`
           * is in 36 of the 68 hardware files this company cuts, so a red banner
           * here would fire on nearly every export — and a warning that is
           * almost always present is one the eye stops reading, including on the
           * day it says something else. Geometry loss keeps the alarm; losing an
           * appearance does not get to borrow it. */
          const colouredSolids = mesh.parts.filter((p) => p.dim === 3 && p.colour?.rgb).length;
          const colourLine =
            colouredSolids > 0
              ? `${colouredSolids} solid(s) carry a color() and the STL does NOT. Binary STL has no ` +
                'colour, so the file is byte-for-byte what it would be with every color() deleted — the ' +
                'shape is complete, the appearance is not in it.'
              : '';

          if (absences.length > 0) {
            setReport({
              title: 'The exported STL is MISSING something',
              lines: [...absences, colourLine].filter(Boolean),
              tone: 'bad',
            });
          } else if (colourLine) {
            setReport({ title: 'The exported STL carries no colour', lines: [colourLine] });
          }
          break;
        }
        case 'edit.undo':
          /* 🔴 THE SAME MECHANISM AS THE TOOLBAR BUTTON, NOT A SECOND ONE
           * (founder, 2026-08-11: *"Have an undo, redo option"*). The button
           * existed first as a one-step put-back; this is `Edit → Undo` reaching
           * the same stack. Two undo systems — one a menu item and one a button
           * — is a confusion the operator pays for, and with a model's reply now
           * landing unpressed it is load-bearing rather than a convenience. */
          setEd(undoEditor);
          break;
        case 'edit.redo':
          setEd(redoEditor);
          break;
        case 'edit.jump-error': {
          if (jumpTargets.length === 0) break;
          errorCursor.current = (errorCursor.current + 1) % jumpTargets.length;
          goToLine(jumpTargets[errorCursor.current].line);
          break;
        }
        case 'design.check-validity': {
          /* 🔴 THIS REPORTS THE AUDIT THAT ALREADY RAN. It does not run a
           * second, separate check — a validity answer produced by a different
           * code path than the one the preview refuses to draw around is two
           * verdicts that can disagree. */
          const solids = mesh.parts.filter((p) => p.dim === 3);
          setReport({
            title: 'Check Validity',
            lines: [
              `Overall: ${mesh.trust} — ${mesh.trustDetail}`,
              ...(solids.length === 0
                ? ['No solid was produced, so there was nothing to audit for closure.']
                : solids.map(
                    (p) =>
                      `${p.label} (line ${p.line}): ${p.audit?.verdict ?? 'unaudited'} — ${
                        p.audit?.detail ?? 'no audit was attached to this part.'
                      }`,
                  )),
              ...(mesh.parts.some((p) => p.dim === 2)
                ? ['2D shapes are present and are never audited: closure is not a meaningful question about a zero-thickness plate.']
                : []),
              'This audit runs on EVERY evaluation, not only when you ask. The menu item reports it; it does not cause it.',
              stale ? '⚠ This is the audit of the PREVIOUS source — the mesh has not caught up with the editor yet.' : '',
            ].filter(Boolean),
          });
          break;
        }
        case 'design.csg-tree':
          patch({ tab: 'tree' });
          break;
        case 'design.ask':
        case 'view.ask':
          patch({ tab: 'ask' });
          break;
        case 'view.axes':
          /* 🔴 TURNING AXES OFF DOES NOT TOUCH THE SCALE SETTING. The two are
           * stored independently and ANDed at the renderer, so turning axes back
           * on restores whatever the operator last chose for the markers. A
           * parent toggle that silently clears its child is a preference that
           * disappears without anybody having changed it. */
          patch({ axes: !layout.axes });
          break;
        case 'view.scale-markers':
          /* Unreachable while axes are off — the menu item is disabled there,
           * for OpenSCAD's own reason (`MainWindow.cc:2761`). The guard is here
           * as well because a disabled control is a UI fact and this is the
           * rule: with no axis line, a tick annotates nothing. */
          if (!layout.axes) break;
          patch({ scaleMarkers: !layout.scaleMarkers });
          break;
        /* 🔴 SET, NOT TOGGLE. OpenSCAD's two actions live in an exclusive
         * `QActionGroup` and each handler runs only `if (checked)`
         * (`MainWindow.cc:2858-2869`) — pressing the mode you are already in
         * does nothing. A toggle here would make the two items one control with
         * two names, and pressing "Perspective" while in perspective would put
         * you in orthogonal, which is the opposite of what the label says. */
        case 'view.projection.perspective':
          patch({ projection: 'perspective' });
          break;
        case 'view.projection.orthogonal':
          patch({ projection: 'orthographic' });
          break;
        case 'view.console':
          patch({ tab: 'console' });
          break;
        case 'view.tree':
          patch({ tab: 'tree' });
          break;
        case 'view.reset-layout':
          setLayout(DEFAULT_LAYOUT);
          writeLayout(DEFAULT_LAYOUT);
          break;
        case 'help.about':
          /* 🔴 THE TWO SURVIVORS OF THE `What this tab is not` BANNER LAND HERE,
           * and this is the right place for exactly them: they are properties of
           * the whole evaluator rather than of any one diagnostic, so there is no
           * "thing they are about" to attach them to — and this report is one a
           * reader ASKED for, which is the difference between a limit and an
           * interruption. Everything else the banner said was either stale or
           * already stated where it acts; see {@link KERNEL_LIMITS}. */
          setReport({
            title: 'About 2bee.cad',
            lines: [
              'A subset of the OpenSCAD language, parsed and evaluated in your browser, with a real ' +
                'boolean kernel and a manifold audit on every result. AGPL-3.0-or-later.',
              /* ⚠ THE ONE CNC-SIDE SENTENCE KEPT, and only here. This tab emits
               * no G-code at all, so a claim about cut output is not really
               * its to make — but a stated absence costs nothing in a report
               * somebody asked for, and deleting it outright would be the first
               * step of a tab that stops saying it. Where it BELONGS is where
               * the cutting happens; that is not this lane-boundary's to move. */
              'This tab emits no toolpath and no G-code. Nothing this app has produced has ever cut anything.',
              ...KERNEL_LIMITS,
              'The pane layout and this menu were read from OpenSCAD 2026.08.07’s own MainWindow.ui — six ' +
                'menus, 105 actions. This bar carries the ones that map onto something real.',
              /* 🔴 TWO HEADED LISTS, NOT ONE RUN-ON. The whole value of the
               * first is that a reader may take "absent" to mean "impossible",
               * and one entry meaning "we have not built it" destroys that for
               * every other entry — which is exactly what the camera line was
               * doing. Printing them under one heading would put the distinction
               * back where a reader cannot see it. */
              'WHAT DOES NOT EXIST HERE, and why the thing each one controls is absent:',
              ...OMISSIONS,
              'AND WHAT IS SIMPLY MISSING — not decisions. Each of these either exists in this tab with ' +
                'no menu item in front of it, or would work here and has not been built:',
              ...GAPS,
            ],
          });
          break;
        default:
          break;
      }
    },
    [
      replaceEditor,
      exportBuild,
      stale,
      saveBlocked,
      jumpTargets,
      goToLine,
      mesh,
      meshSrc,
      meshParse,
      patch,
      savedName,
      onSaved,
      layout.axes,
      layout.scaleMarkers,
      openSettings,
    ],
  );

  const menus = useMemo(
    () =>
      cadMenus({
        dirty,
        saveBlocked,
        errorCount: jumpTargets.length,
        undoLabel: undoLabel(ed),
        redoLabel: redoLabel(ed),
        bottomTab: layout.tab,
        askVisible: ASK_PANEL_VISIBLE,
        savedName,
        axes: layout.axes,
        scaleMarkers: layout.scaleMarkers,
        projection: layout.projection,
      }),
    /* ⚠ `ed.past`/`ed.future`, NOT `ed`. The whole editor state changes on every
     * keystroke and the two labels change only when the history does — depending
     * on `ed` would rebuild the entire menu tree on each character typed, in a
     * tab that already parses on each character typed. */
    [
      dirty,
      saveBlocked,
      jumpTargets.length,
      ed.past,
      ed.future,
      layout.tab,
      savedName,
      layout.axes,
      layout.scaleMarkers,
      /* Without this the two projection items keep the check mark they had when
       * the menu was last built — the control would work and look like it had
       * not. A memo dependency omitted is a stale green in the plainest form. */
      layout.projection,
    ],
  );

  /**
   * 🔴 THE ONE BOUND KEY. `Ctrl+S` (and `Cmd+S`) saves, and — the part that
   * matters — `preventDefault` stops the browser's Save Page ever appearing.
   *
   * Until this existed the File footnote named Ctrl+S as lost work and then
   * offered the `beforeunload` guard below as the answer. **The guard does not
   * cover it**: Save Page does not unload the document, so nothing fired. The
   * operator got a save dialog that completed successfully and believed their
   * model was stored, with the dirty marker still showing and no way to connect
   * the two. Documenting that was the cheap fix; removing it is this.
   *
   * ⚠ THE TWO GUARDS DO NOT BOTH FIRE, and that was checked rather than assumed:
   * with the default prevented there is no navigation and no unload, so
   * `beforeunload` has no event; and a save that succeeds sets the baseline,
   * which clears `dirty`, which unregisters the guard.
   *
   * 🔴 ONLY WHILE THIS TAB IS THE ONE ON SCREEN. `Tabs.tsx` keeps every panel
   * MOUNTED and hides it with `display: none` — deliberately, because unmounting
   * would discard the operator's source. So a window listener registered here
   * outlives the tab being visible, and without this check a Ctrl+S pressed while
   * looking at the CNC tab would silently write THIS tab's model and show its
   * refusals on a screen nobody is looking at: the same false belief, arriving
   * from the other direction. A hidden element generates no layout box, which is
   * the same fact `preview.tsx` uses to stop its render loop.
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      const el = shell.current;
      if (!el || el.getClientRects().length === 0) return;
      onCadKeyDown(e, runCommand);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runCommand]);

  /**
   * 🔴 THE GUARD FOR THE KEYS WE DID NOT BIND, AND IT COVERS AN UNLOAD ONLY.
   *
   * OpenSCAD's F5 is a browser reload. In this tab a reload used to lose the
   * model outright — no undo, no autosave, no server copy — so an operator with
   * the muscle memory was one keystroke from losing work. Intercepting F5 would
   * take their reload away on a page that has needed one; this catches F5 **and**
   * Ctrl+W, the back button and the tab close, and takes no key from anybody.
   *
   * 🔴 WHAT THIS GUARD NOW MEANS, AND IT IS NOT WHAT IT MEANT THIS MORNING. The
   * session store above usually puts the buffer back, so the sentence *"a reload
   * loses the model"* is no longer true — and the guard is KEPT anyway, because
   * *"the buffer usually comes back"* and *"your work is safe"* are different
   * claims and only the first one is ours to make. It survives:
   *   · a browser with site data disabled, or a quota refusal — in which case
   *     nothing was stored and the toolbar says `not being remembered`;
   *   · clearing site data, a different browser, a different machine, and an
   *     incognito window that is about to be closed;
   *   · the 600 ms between the last keystroke and the debounced write.
   * ⚠ AND IT IS NOT A SAVE. The store holds ONE buffer, one put-back and a
   * camera — not a record in the drawings list, not something the CNC tab can
   * cut, and not something that leaves this browser. The prompt is still the
   * only thing standing between an unsaved model and a closed tab.
   *
   * ⚠ WHAT IT DOES NOT COVER, stated because the footnote used to claim it did:
   * `Ctrl+S`. Save Page does not unload the document. That key is bound above
   * instead, which is a fix rather than a caveat.
   *
   * ⚠ It is registered only while there ARE unsaved changes. A page that always
   * asks "are you sure you want to leave" is a page everyone learns to dismiss.
   * ⚠ And it is the WHOLE app's dialog, not this tab's: a dirty CAD editor will
   * also prompt on a reload the operator wanted for the CNC tab. That is the
   * cost, and it is the operator's own unsaved work that buys it.
   */
  useEffect(() => {
    if (!dirty || typeof window === 'undefined') return;
    const onLeave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty]);

  return (
    <div
      data-testid="cad-tab"
      ref={shell}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        padding: 12,
        minHeight: 0,
        height: '100%',
        boxSizing: 'border-box',
      }}
    >
      {/* ---- toolbar ------------------------------------------------------ */}
      <div
        data-testid="cad-toolbar"
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          marginBottom: 8,
        }}
      >
        {/* 🔴 NO `2bee.cad` LABEL — the tab header already says it (founder,
            2026-08-11: *"no need 2bee.cad there, it is already in the header"*),
            and no `parses on every keystroke` either: that explains a design
            decision to a reader who did not ask and names nothing they can act
            on. It is in this file's header, where it belongs. */}
        <MenuBar menus={menus} onCommand={runCommand} />

        {/* 🔴 SILENT WHEN CLEAN, MARKED WHEN DIRTY — the same cut as the audit
            verdict. `no unsaved changes` fires when things are fine, which is
            most of the time, so it carried nothing.

            🔴 AND THE HALF THAT STAYS GOT MORE IMPORTANT, NOT LESS. With the
            two-press confirms gone this marker is the ONLY signal, before the
            click, that `New`, `Example` or an open would displace something
            nobody has stored — so it is rendered at warn weight rather than as
            a note, and it is deliberately to the LEFT of the put-back and the
            reset, which are the controls it is about.
            ⚠ Three things key on `dirty`: this, the `beforeunload` guard below,
            and the `File → New` menu note. */}
        {dirty ? (
          <span className="warn" style={{ margin: 0, fontWeight: 600 }} data-testid="cad-dirty">
            unsaved changes
          </span>
        ) : null}
        {/* 🔴 WHICH TEXT YOU ARE LOOKING AT, WHEN IT CAME BACK FROM A STORE. The
            danger this names is not the refresh — it is `File → Save`, which on
            a named model writes silently. A restored buffer under the name
            `bracket` is not what `bracket` contains, and `unsaved changes` alone
            does not say that: it says the same thing about a model you opened
            thirty seconds ago and can still remember. */}
        {restored ? (
          <span
            className="warn"
            style={{ margin: 0, fontWeight: 600 }}
            data-testid="cad-restored"
            title={
              'This source was put back from your last session in THIS browser when the page loaded. ' +
              'It has not been saved anywhere' +
              (savedName ? `, and it is NOT what is stored under “${savedName}” — saving REPLACES that record.` : '.') +
              ' One put-back step came back with it; the rest of the undo history and any mounted ' +
              'library folder did not, so an include/use may report as unread until you mount the ' +
              'folder again.'
            }
          >
            restored{savedName ? ` · not the stored “${savedName}”` : ''}
          </span>
        ) : null}
        {/* ⚠ AND THE OTHER DIRECTION: the store REFUSED a write, so nothing will
            come back next time. Silence here would be read as "it is being kept",
            which is the belief that makes somebody stop saving. */}
        {!sessionKept ? (
          <span
            className="bad"
            style={{ margin: 0, fontWeight: 600 }}
            data-testid="cad-session-not-kept"
            title={
              'This browser refused to store the session — usually because the source is larger than ' +
              'the storage quota, or because site data is disabled. The stale copy has been DELETED ' +
              'rather than left to come back as if it were your work. A refresh will lose what is in ' +
              'this editor: save it into the drawings list.'
            }
          >
            not being remembered
          </span>
        ) : null}
        {/* 🔴 THE PUT-BACK. It is the whole of what replaced three confirms, so
            it appears ONLY when there is genuinely something to put back — a
            control that is always there and usually reverses nothing is the
            same defect as a confirm that always says yes.

            ⚠ ITS LABEL NAMES THE ACTION, NEVER "undo". This tab has no history
            of keystrokes; it holds ONE string, the text the last replacement
            displaced. `title` says so, at the control, rather than in a
            paragraph at the top of the tab. */}
        {canUndo(ed) ? (
          <button
            type="button"
            data-testid="cad-put-back"
            onClick={() => setEd(undoEditor)}
            title={
              'Puts back exactly the source that action replaced. It is the same history as ' +
              'Edit → Undo, reached from here — not a second one. It is NOT an undo for your ' +
              'typing: nothing here records keystrokes, and Ctrl+Z is deliberately left to the ' +
              'browser, which does. Whatever this displaces becomes the next Redo.'
            }
          >
            {undoLabel(ed)}
          </button>
        ) : null}
        {/* ⚠ REDO APPEARS ONLY WHEN THERE IS ONE, like the undo beside it. A
            permanently-present Redo that usually does nothing is the dead
            control this tab keeps removing — and this one would be dead most of
            the time, because any new replacement or keystroke clears it. */}
        {canRedo(ed) ? (
          <button
            type="button"
            data-testid="cad-redo"
            onClick={() => setEd(redoEditor)}
            title={
              'Steps forward again through the same document history. Typing clears it: once you ' +
              'have edited, the state a Redo would restore is one you have moved away from, and ' +
              'restoring it would discard the work you did instead.'
            }
          >
            {redoLabel(ed)}
          </button>
        ) : null}
        {/* 🔴 `Reset to example` IS GONE (founder, 2026-08-11: *"remove the
            Reset to example"*), AND ITS WIRING WENT WITH IT — there is no
            orphaned handler and no orphaned test. What did NOT go, because it is
            not the button's:
              · `EXAMPLE` — it seeds `initialEditor` on a fresh tab, so the
                constant has a live caller that has nothing to do with the reset;
              · `runCommand('file.example')` — `File → Example` is the command's
                real door and always was. This button was a second, toolbar-level
                door onto the same DESTRUCTIVE act, sitting at `marginLeft: auto`
                where a mis-aimed click lands.
            One act, one control. */}
      </div>

      {/* ---- what a menu command answered, or refused ---------------------- */}
      {report ? (
        <div
          className="block"
          data-testid="cad-menu-report"
          data-tone={report.tone ?? 'note'}
          style={{
            flex: '0 0 auto',
            marginBottom: 8,
            ...(report.tone === 'bad' ? { borderColor: 'var(--bad)' } : null),
          }}
        >
          <strong style={report.tone === 'bad' ? { color: 'var(--bad)' } : undefined}>{report.title}</strong>
          <ul className="notes" style={{ marginTop: 4 }}>
            {report.lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
          <button type="button" data-testid="cad-menu-report-close" onClick={() => setReport(null)}>
            Close
          </button>
        </div>
      ) : null}

      {/* ---- open and save, on demand only --------------------------------- */}
      {/* 🔴 ONE PANEL, TWO SOURCES (founder, 2026-08-11: *"merge the Open … and
          Open library folder … — have just 1 open!"*). The folder mount is
          INSIDE it rather than deleted with the menu item: `open.tsx` reads the
          browser store and has no file input, so the mount is the only route
          from disk into this tab, and the founder's own assemblies import by
          path. See that file's header for what the merge had to preserve. */}
      {openShowing ? (
        <div style={{ flex: '0 0 auto' }} ref={openPanel}>
          <CadOpen
            onOpen={openModel}
            onClose={() => setOpenShowing(false)}
            library={library}
            onLibrary={setLibrary}
            onOpenFile={(path, source) => {
              /* A replacement like any other — so it stashes, so the toolbar
               * can put back whatever it displaced. `selfPath` is what makes
               * `../` in that file mean the directory it actually sits in. */
              setSelfPath(path);
              replaceEditor(`opening "${path}"`, source);
            }}
          />
        </div>
      ) : null}

      <ImportReport misses={parsed.misses} reads={parsed.reads} />

      {/* 🔴 `File → Settings…` — the surface the Ask pane's preamble and fields
          moved to (founder, 2026-08-11). It is the same idiom as the Open panel
          above and mounted the same way: a `.block` on demand, not a modal and
          not a second dialog concept. `AskSettings` is ONE component rendered
          from two places, so the credential form has no second copy to drift. */}
      {settingsShowing ? (
        <div style={{ flex: '0 0 auto' }} ref={settingsPanel}>
          <div className="block" data-testid="cad-settings" style={{ marginBottom: 8 }}>
            <AskSettings cfg={askCfg} onPatch={patchAsk} onClose={() => setSettingsShowing(false)} />
          </div>
        </div>
      ) : null}

      {saveShowing ? (
        <div style={{ flex: '0 0 auto' }} ref={savePanel}>
          <SaveDialog
            /* 🔴 THE MESHED SOURCE, NOT THE EDITOR'S. They differ for 250 ms
             * after every keystroke and the record stores the meshed one. */
            source={meshSrc}
            parse={meshParse}
            mesh={mesh}
            stale={stale}
            initialName={savedName ?? ''}
            onSaved={onSaved}
            onClose={() => setSaveShowing(false)}
          />
        </div>
      ) : null}

      {/* ---- main row: editor | 3D view ------------------------------------ */}
      <div
        ref={mainRow}
        style={{ flex: 1, minHeight: 120, display: 'flex', flexDirection: 'row', minWidth: 0 }}
      >
        <div
          style={{
            flex: `0 0 ${(layout.split * 100).toFixed(2)}%`,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <CadEditor ref={editor} value={src} onChange={setSrc} marks={marks} />
        </div>

        <Splitter
          vertical
          label="editor and 3D view split"
          testid="cad-split-main"
          onDelta={(px) => {
            const w = mainRow.current?.clientWidth ?? 0;
            if (w <= 0) return;
            patch({ split: Math.min(0.8, Math.max(0.2, layout.split + px / w)) });
          }}
        />

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <CadPreview
              result={mesh}
              stale={stale}
              showAxes={layout.axes}
              showScaleMarkers={layout.scaleMarkers}
              projection={layout.projection}
              /* 🔴 THE BOOT VALUE, NOT `cameraRef.current`. This prop is read
               * once, in a `[]` effect; feeding it a ref that later updates
               * would be a value that looks live and is not, and would read as
               * a camera that can be pushed in from here — which it cannot, on
               * purpose. See its note in `preview.tsx`. */
              initialCamera={opened?.camera ?? null}
              onCameraChange={onCameraChange}
            />
          </div>
          {/* 🔴 THE SAVE PANEL IS NO LONGER PARKED HERE. It was a permanent
              block under the preview taking up to 40% of that column on every
              model; it is now the dialog `File → Save…` and `Save as…` bring up
              — see {@link SaveDialog}. The picture got the space back. */}
        </div>
      </div>

      <Splitter
        vertical={false}
        label="bottom pane height"
        testid="cad-split-dock"
        onDelta={(px) => patch({ dock: Math.min(600, Math.max(0, layout.dock - px)) })}
      />

      {/* ---- bottom dock, full width, tabbed (OpenSCAD area 8) -------------
       *
       * 🔴 THE ROLES ARE NOW BACKED BY THE BEHAVIOUR THEY ANNOUNCE (2026-08-12).
       * This strip declared `role="tablist"` over `role="tab"` buttons and did
       * NONE of the rest: no `role="tabpanel"` on the pane, no `aria-controls`,
       * no roving tabindex (every dock tab sat in the page tab order), no arrow
       * keys. **Half a widget is worse than plain buttons** — a screen reader
       * announces "tab 1 of 3" and tells the operator to press an arrow key, and
       * the arrow key did nothing. `Tabs.tsx` implements the whole pattern and
       * states the reason: a shop is a place where somebody's other hand is on
       * the machine, and a control that can only be reached with a mouse is a
       * control that is not there for everyone. The alternative was to DROP the
       * roles; it was rejected because this is a real tab widget — one region,
       * several panes, one showing — and dropping the roles would also drop the
       * `aria-selected` that says which.
       *
       * ⚠ TWO THINGS ARE DELIBERATELY UNLIKE `Tabs.tsx`, and both follow from
       * that file's OWN reasoning rather than departing from it:
       *
       *  1. **ACTIVATION IS MANUAL** — an arrow key moves focus, `Enter`/`Space`
       *     selects. `Tabs.tsx` chose AUTOMATIC activation and gave the reason:
       *     *"every panel is already mounted, so selecting one costs a `display`
       *     change and nothing else"*. The opposite is true here. These panes are
       *     CONDITIONALLY RENDERED, so a tab change UNMOUNTS the pane — and
       *     `AskPanel` holds its conversation, its pending request and its
       *     proposal in its own `useState`. Automatic activation would let an
       *     operator arrowing along the strip discard a model reply they were
       *     reading. Same rule, opposite premise, opposite answer.
       *  2. **THE ARROW KEYS REACH ONLY THE RENDERED TABS**, which is not all of
       *     them: `Scene tree` is unpinned and has a button only while it IS the
       *     showing pane (see {@link BOTTOM_TABS}). That is a property of the
       *     strip's filter, not of the keyboard handler — a tab that is not on
       *     screen cannot be arrowed to by a mouse user either, and the pane's
       *     ways in are `View → Scene tree` and `Design → Display CSG Tree`.
       *     Naming it here so nobody reads the roving index as broken.
       *
       * ⚠ ONE PANEL ELEMENT, so every tab's `aria-controls` names the SAME id.
       * The panes swap inside one container rather than each having its own
       * hidden element (that is what makes the unmount above true), and pointing
       * a non-showing tab at an id that is not in the document would be a
       * dangling IDREF — an attribute that reads as wired and resolves to
       * nothing. The panel is labelled by whichever tab is selected. */}
      <div
        data-testid="cad-dock"
        style={{ flex: `0 0 ${layout.dock}px`, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      >
        <div role="tablist" aria-label="bottom pane" style={{ flex: '0 0 auto', display: 'flex', gap: 4 }}>
          {/* Pinned panes always; an unpinned one only while it is showing —
              see the note on {@link BOTTOM_TABS}. */}
          {dockTabs.map((t, i) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={dockTabDomId(t.id)}
              aria-selected={layout.tab === t.id}
              aria-controls={DOCK_PANEL_ID}
              /* ROVING TABINDEX: exactly one dock tab is in the page's tab order.
               * Without it, a keyboard user tabbing through the CAD tab hit every
               * dock button in turn — the thing the arrow keys exist to replace.
               * The selected tab is the one that stays reachable, so `Tab` lands
               * on the strip and `Enter` re-selects what is already showing,
               * which is a no-op rather than a surprise. */
              tabIndex={layout.tab === t.id ? 0 : -1}
              ref={(el) => {
                dockTabRefs.current.set(t.id, el);
              }}
              onKeyDown={(e) => onDockKeyDown(e, i)}
              data-testid={`cad-dock-tab-${t.id}`}
              /* ⚠ THE SPLIT BY CLASS, WHICH A SINGLE NUMBER CANNOT CARRY.
               * `badge.label` is the pane's own header sentence verbatim, so the
               * hover and the pane cannot describe the same diagnostics
               * differently. `undefined` rather than `''` when there is nothing
               * to say — an empty title attribute is still a title. */
              title={t.id === 'console' && badge.count > 0 ? badge.label : undefined}
              onClick={() => patch({ tab: t.id })}
              style={{
                font: '11.5px var(--mono)',
                padding: '2px 8px',
                background: layout.tab === t.id ? 'var(--panel)' : 'transparent',
                color: layout.tab === t.id ? 'var(--ink)' : 'var(--muted)',
                border: '1px solid var(--line)',
                borderBottom: 'none',
                borderRadius: 'var(--radius) var(--radius) 0 0',
                cursor: 'pointer',
              }}
            >
              {t.label}
              {t.id === 'console' && badge.count > 0 ? ` (${badge.count})` : ''}
            </button>
          ))}
        </div>

        <div
          role="tabpanel"
          id={DOCK_PANEL_ID}
          aria-labelledby={dockTabDomId(layout.tab)}
          /* NO `tabIndex` — the APG asks for a tab stop on the panel only when it
           * holds nothing focusable, or when its first element with content is
           * not focusable. Every pane here opens with its own controls (the
           * console's rows are buttons, the tree's rows are buttons, Ask opens on
           * its prompt box), which is the same condition `Tabs.tsx` applies to
           * decide the CAD and CNC panels get no stop and `Run` does. An extra
           * stop in front of a pane changes a keyboard order operators learn. */
          style={{ flex: 1, minHeight: 0 }}
        >
          {layout.tab === 'console' ? (
            <CadConsole parse={result} mesh={mesh} meshStale={stale} onGoToLine={goToLine} />
          ) : layout.tab === 'ask' ? (
            /* 🔴 `replaceEditor` IS THE ONLY THING THIS PANE CAN REACH, and it
             * reaches it through one callback that `ask.tsx`'s reducer fires
             * from exactly one action. It is deliberately NOT given a baseline
             * reset: accepting a model's proposal leaves the editor UNSAVED,
             * because that is what it is — text nobody has stored anywhere.
             *
             * 🔴 AND THIS IS WHERE ASK'S OWN PUT-BACK WENT. `ask.tsx` used to
             * hold its own one-step restore and render its own button for it.
             * That mechanism was right and it is now the tab's, for all four
             * replacements rather than one — two buttons doing the same job to
             * two different stashes is how an operator presses the one that
             * puts back the wrong thing. */
            <AskPanel
              source={src}
              onApply={(next) => replaceEditor('the model proposal', next)}
              cfg={askCfg}
              onPatch={patchAsk}
              onOpenSettings={openSettings}
            />
          ) : (
            <div
              style={{
                height: '100%',
                overflow: 'auto',
                padding: 8,
                border: '1px solid var(--line)',
                borderRadius: '0 var(--radius) var(--radius) var(--radius)',
                background: 'var(--panel)',
              }}
            >
              {/* The tree is the only unpinned pane, so this is the only branch
                  that needs a way out — the strip's own button toggles it, and
                  `View → Console` is the other. */}
              <p className="note" style={{ marginTop: 0 }}>
                What the evaluator understood, and nothing more. Refused constructs are absent from this
                tree, so read it as a subset of your source, never as a picture of it. Click a row to go
                to its line.
              </p>
              <Counts result={result} />
              <TreeView lines={lines} onGoToLine={goToLine} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default CadTab;
