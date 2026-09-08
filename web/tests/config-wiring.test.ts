// What `App.tsx` SENDS, and what comes back for it to read.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS AND WHAT IT CANNOT REACH
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 `App.tsx` CANNOT BE IMPORTED IN NODE — the loader stops at the sample
// asset imports (`Unknown file extension ".dxf"`), measured again while writing
// this file and recorded twice before. So nothing here renders JSX, nothing
// clicks a checkbox, and no assertion below observes a React re-render.
//
// That boundary splits this file in two, and the split is stated rather than
// blurred, because the two halves carry very different weight:
//
// ✅ PART A — THE WASM, EXERCISED. The browser's own bundle is loaded and
//    driven exactly as the page drives it (`plan(job, plant, configJson, …)`).
//    These assertions are about behaviour: a config field reaching the emitted
//    program, a report field carrying the number the estimate charged. If the
//    core stops honouring a key the UI sends, this goes red.
//
// ⚠ PART B — THE SOURCE, READ AS TEXT. A React dependency array cannot be
//    observed without React, so the one thing that makes a control LIVE is
//    checked by reading `App.tsx`. **A text guard proves "unchanged", never
//    "correct":** it proves the identifier is listed in the dep array, not that
//    the memo actually re-runs when it changes. It is here because the
//    alternative is nothing at all, and because the defect it guards — a
//    setting that reaches the config object and not the dep list — has shipped
//    in this file before and is invisible to every other check we own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import * as nodeFs from 'node:fs';
const require_fs = () => nodeFs;

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', 'src', 'App.tsx');
const GLUE = join(HERE, '..', 'src', 'wasm', 'twobee_cam_wasm.js');
const BG = join(HERE, '..', 'src', 'wasm', 'twobee_cam_wasm_bg.wasm');

/* ════════════════════════════════════════════════════════════════════════════
   PART A — THE BROWSER'S OWN WASM BUNDLE
   ════════════════════════════════════════════════════════════════════════════

   🔴 THIS IS THE ARTEFACT THE PAGE LOADS, not the CLI and not a fresh cargo
   build. `web/src/wasm/` is what Vite bundles, so a field that works in the
   CLI and was never rebuilt into this file would be a green everywhere except
   where the operator is. (Whether it is CURRENT is gate K3's question, not
   this file's — K3 compares its `build_id()` against the CLI's.) */

const wasm: any = await import(pathToFileURL(GLUE).href);
wasm.initSync({ module: readFileSync(BG) });

/** `plan` as the page calls it, with the JSON parsed. */
function plan(job: string, config: unknown): any {
  return JSON.parse(wasm.plan(job, '', JSON.stringify(config), 0.6, undefined));
}

/* `plate` drawn at (60,60); dragging it (-60,-60) puts two of its four edges ON
 * the workpiece edge and leaves the other two 397mm and 780mm inside — so a
 * change that skipped every edge and one that skipped none both fail. The
 * workpiece sits at (10,10) so the OFF program, which cuts one tool radius
 * outside the material, still fits the travel envelope and can be compared
 * rather than refused. Plunge entry because the core refuses a ramp on the open
 * path a skipped edge creates — which is asserted on its own below. */
const FLUSH_IN_THE_CORNER = {
  drawing_offset: [-60, -60],
  stock: { origin_x_mm: 10, origin_y_mm: 10 },
  op: { entry: 'Plunge' },
};

test('the workpiece-edge switch this app sends reaches the emitted program', () => {
  const off = plan('plate', FLUSH_IN_THE_CORNER);
  const on = plan('plate', {
    ...FLUSH_IN_THE_CORNER,
    use_workpiece_edge: true,
    workpiece_edge_tolerance_mm: 0.1,
  });

  assert.equal(off.ok, true, `the OFF program did not post: ${JSON.stringify(off.errors)}`);
  assert.equal(on.ok, true, `the ON program did not post: ${JSON.stringify(on.errors)}`);

  // 🔴 THE EMITTED PROGRAM, never the setting that was supposed to produce it.
  assert.notEqual(
    off.gcode,
    on.gcode,
    'the switch reached no coordinate — a setting that changes nothing'
  );
  assert.ok(
    on.cutting_distance_mm < off.cutting_distance_mm,
    `turning it on did not cut LESS: ${on.cutting_distance_mm} vs ${off.cutting_distance_mm}`
  );
  assert.ok(
    on.gcode.includes('( workpiece edge: 2 of 4 outline edges cut'),
    'the emitted program does not name the edges it skipped'
  );
  assert.ok(
    !off.gcode.includes('workpiece edge:'),
    'the OFF program carries the rule commentary, so the flag is not being read'
  );
});

test('the switch on the DEFAULT entry is refused, and the refusal is the first experience', () => {
  /* ⚠ NOT A DEFECT AND NOT SPECIAL-CASED AWAY. `Ramp` is this app's default
   * entry, so an operator ticking the box meets this refusal before they meet
   * the feature. A ramped pass finishes what it cut with a second lap from the
   * start; on an open path that lap begins at the far end and would feed at
   * full depth across the finished part. The panel warns before export and the
   * core refuses at plan time — two places, one fact. */
  const ramped = plan('plate', {
    drawing_offset: [-60, -60],
    stock: { origin_x_mm: 10, origin_y_mm: 10 },
    use_workpiece_edge: true,
    workpiece_edge_tolerance_mm: 0.1,
  });
  assert.equal(ramped.ok, false, 'a ramp entry on an open profile produced a program');
  assert.ok(
    ramped.refusals.some((r: string) => r.includes('ramp entry on an open path')),
    `the refusal does not name the ramp: ${JSON.stringify(ramped.refusals)}`
  );
});

test('a tolerance that is not a distance is refused in words, never clamped', () => {
  const bad = plan('plate', { use_workpiece_edge: true, workpiece_edge_tolerance_mm: -1 });
  assert.equal(bad.ok, false, 'a negative tolerance produced a program');
  assert.ok(
    bad.refusals.some((r: string) => r.includes('is not a distance')),
    `the refusal does not name what is wrong: ${JSON.stringify(bad.refusals)}`
  );
});

test('the tool-change rate is ON the report, so no host has to invent one', () => {
  /* 🔴 THE FIELD THAT LET `const TOOL_CHANGE_SECONDS = 60` BE DELETED (#90).
   * The core charged 120 while this app charged 60, so the playback clock
   * under-read by a minute per change against the estimate printed beside it.
   * The number is now read; this asserts there is something to read. */
  const r = plan('plate', {});
  assert.equal(r.ok, true, `plate did not post: ${JSON.stringify(r.errors)}`);
  assert.ok(r.tool_changes > 0, 'this fixture no longer changes tools — pick another');
  assert.equal(typeof r.tool_change_seconds, 'number', 'no per-change rate on the report');
  assert.ok(r.tool_change_seconds > 0, 'the rate is zero, so nothing would be charged');

  // ⚠ UNDECLARED, and that is the fact the flag exists to carry: `plate`'s
  // machine states no rate, so the core used its own default. "Somebody chose
  // 120" and "nobody said, so we used 120" are different facts.
  assert.equal(r.tool_change_rate_declared, false, 'an undeclared rate reported as declared');

  const declared = plan('plate', { machine: { tool_change_seconds: 300 } });
  assert.equal(declared.tool_change_seconds, 300, 'a declared rate did not reach the report');
  assert.equal(declared.tool_change_rate_declared, true, 'a declared rate reported as assumed');
  assert.ok(
    declared.estimated_seconds > r.estimated_seconds,
    'a slower operator did not make the estimate longer, so the rate is decorative'
  );
});

test('the board-depth verdict and the catalogue thickness are shaped as cam.ts now says', () => {
  /* Item 4: `SimCounts` gained `board_depth` / `through_board` /
   * `board_depth_pending_reason`, and `SpoilboardSpec.thickness_mm` became
   * nullable. Both are TYPE changes, which TypeScript erases — so the shape is
   * asserted against the real payload rather than trusted to a declaration. */
  const r = plan('plate', {});
  assert.equal(
    r.sim.board_depth,
    'board-depth-unknown',
    'no board is declared on this job, so the depth verdict must be PENDING'
  );
  assert.equal(r.sim.through_board, 0);
  assert.ok(
    typeof r.sim.board_depth_pending_reason === 'string' &&
      r.sim.board_depth_pending_reason.length > 0,
    'PENDING with no reason — the operator is told nothing'
  );

  const cat = JSON.parse(wasm.spoilboards());
  assert.ok(cat.spoilboards.length > 0, 'the catalogue is empty');
  for (const s of cat.spoilboards) {
    // `null` is a legal thickness — an entry whose cited page states none. What
    // must never appear is a number nobody read off a source.
    assert.ok(
      s.thickness_mm === null || typeof s.thickness_mm === 'number',
      `thickness_mm on ${s.id} is neither a number nor null: ${JSON.stringify(s.thickness_mm)}`
    );
  }
});

test('a catalogue id and a thickness together install NOTHING, rather than one winning', () => {
  /* ⚠ The reason `cam.ts` documents `SpoilboardCfg.thickness_mm` as
   * measured-form-only. A host that sends both does not override the sourced
   * figure — it loses the whole board, and the core says so in `notes`. */
  const r = plan('plate', {
    machine: {
      spoilboard: { catalogue_id: 'mdf-au-bunnings-2400x1200-16', x_mm: 0, y_mm: 0, thickness_mm: 9 },
    },
  });
  assert.ok(
    r.notes.some((n: string) => n.includes('SPOILBOARD NOT INSTALLED')),
    `the board was installed anyway: ${JSON.stringify(r.notes.slice(0, 4))}`
  );
});

/* ════════════════════════════════════════════════════════════════════════════
   PART B — THE DEPENDENCY ARRAY, READ AS TEXT
   ════════════════════════════════════════════════════════════════════════════

   🔴 WHAT MAKES A CONTROL LIVE. `App.tsx`'s own comment beside `spoilboardCfg`
   says it: *"A setting that reaches the config object but not this list is a
   control the operator can move while the plan never changes — which this app
   has shipped before."* Nothing checked that comment until now.

   ⚠ NOT ENUMERATED, DELIBERATELY. A list of settings-to-check goes blind to
   whatever is added after it is written, which is the same failure one level
   up. So the state names are DISCOVERED from the file — every
   `const [x, setX] = useState(…)` AND, since the Zustand migration
   (`e8f19e24d6` onward), every value destructured from a store hook
   (`const { travelX, setTravelX, … } = useCncStore()`), with the `setX`
   setters dropped. A destructured store value is a plain render-scope
   binding, so the useMemo below it goes stale for it exactly as it did for a
   useState value — the migration changed where state LIVES, not whether a
   memo can freeze it. Every discovered name that appears inside the config
   object must appear in the array below it. A new control is covered the
   moment it is declared, without anyone remembering to add it here. */

const src = readFileSync(APP, 'utf8');

test('every piece of state the config object reads is in the dependency array', () => {
  const start = src.indexOf('const config: JobConfig = useMemo(');
  assert.notEqual(start, -1, 'the config useMemo was renamed — this guard cannot see it');

  /* The memo ends at the first `]\n  );` after it: the close of the dep array
   * at the component's indentation. Asserted rather than assumed, because a
   * boundary that silently lands in the wrong place would make this pass over
   * an empty string. */
  const end = src.indexOf('\n    ]\n  );', start);
  assert.notEqual(end, -1, 'the config useMemo does not close in the expected shape');
  const memo = src.slice(start, end);

  const depsAt = memo.lastIndexOf('\n    [');
  assert.notEqual(depsAt, -1, 'no dependency array found inside the config useMemo');
  /* 🔴 COMMENTS STRIPPED FROM THE BODY, KEPT IN THE DEPS. This file's comments
   * are long and discursive — "still sent for the FIXTURE jobs", "leave the job
   * alone" — and a word-boundary scan over prose reported `jobs` and `job` as
   * missing controls on its first run. A guard whose false reds have to be
   * explained away is a guard people learn to skip. The deps side keeps its
   * comments because a name appearing there in prose cannot mask an absence:
   * the test would only ever pass more easily, and the negative control below
   * is what stops that mattering. */
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const body = strip(memo.slice(0, depsAt));
  /* 🔴 THE DEPS ARE STRIPPED TOO SINCE 2026-08-11, AND THE COMMENT THAT STOOD
   * HERE WAS WRONG ABOUT WHY THEY WERE NOT. It said a name appearing in prose on
   * the deps side "cannot mask an absence: the test would only ever pass more
   * easily" — which IS masking an absence, and it was doing so live. Planted:
   * delete `material` from the dependency array and leave it in the config
   * object, and this guard stayed GREEN, because the dep-array comment beside
   * `useWorkpieceEdge` contains the word *material*. The operator could then
   * change the material and the emitted program would not move — the exact
   * defect this test exists for, vouched for by the test. */
  const deps = strip(memo.slice(depsAt));
  assert.ok(body.length > 500, `the memo body did not parse out (${body.length} chars)`);

  const stateNames = [...src.matchAll(/const \[(\w+), set\w+\] = useState/g)].map((m) => m[1]);
  /* 🔴 THE ZUSTAND HALF OF THE DISCOVERY. `43135c6fec` and its siblings moved
   * most of this state into `useCncStore()`, destructured as one big
   * `const { … } = useCncStore()` block — the useState-only scan found 12
   * names and this guard's own "parse broke" tripwire fired. Any store-hook
   * destructure counts; setters and aliases (`report: reportStore`) are
   * reduced to the bound value name. */
  const storeNames = [...src.matchAll(/const \{([\s\S]*?)\} = use\w+\(/g)]
    .flatMap((m) => m[1].split(','))
    .map((s) => s.trim().split(':')[0].trim())
    .filter((n) => /^\w+$/.test(n) && !/^set[A-Z]/.test(n));
  const allState = [...new Set([...stateNames, ...storeNames])];
  assert.ok(
    allState.length > 30,
    `only ${allState.length} state names found (${stateNames.length} useState, ${storeNames.length} from store hooks) — parse broke`,
  );

  const word = (name: string, hay: string) => new RegExp(`\\b${name}\\b`).test(hay);
  const missing = allState.filter((n) => word(n, body) && !word(n, deps));
  assert.deepEqual(
    missing,
    [],
    `state read by the config object and absent from its dependency array — the operator can ` +
      `move these and the emitted program will not change: ${missing.join(', ')}`
  );

  // ⚠ A negative control for the guard itself. If the discovery found nothing
  // in the body, `missing` would be empty for the wrong reason and this file
  // would be a green that compared nothing.
  const seen = allState.filter((n) => word(n, body));
  assert.ok(seen.length > 15, `only ${seen.length} state names found in the memo body`);
  assert.ok(
    seen.includes('useWorkpieceEdge') && seen.includes('workpieceEdgeTol'),
    'the workpiece-edge controls are not in the config object at all'
  );
});

test('the depth verdict is handed to the viewport, not merely typed', () => {
  /* 🔴 A PROP THE COMPONENT READS AND THE PAGE NEVER PASSED. `Viewport` takes
   * `boardDepth` and renders an absent one as PENDING — the honest default, and
   * the reason nothing was ever going to look broken. Typing `board_depth` /
   * `through_board` / `board_depth_pending_reason` onto `SimCounts` in `cam.ts`
   * does not by itself put a verdict on the canvas; this line does.
   *
   * ⚠ WHAT THIS PROVES AND WHAT IT DOES NOT. It proves the prop is written in
   * the JSX with the report's own `sim` object behind it. It does NOT prove the
   * canvas paints anything — no browser here — and it never will from node. The
   * painting is I1's leg. */
  assert.ok(
    /boardDepth=\{report\?\.sim/.test(src),
    'the viewport is not handed report.sim, so its depth verdict is PENDING forever'
  );
});

test('no hand-copied tool-change constant has come back', () => {
  /* 🔴 THE DELETION, GUARDED. `#90` was not a re-sync: the number is on the
   * report now, and a literal here would disagree with it the first time a
   * machine declares its own rate. The comment left in `App.tsx` where the
   * constant stood is deliberately not a match for this pattern. */
  assert.equal(
    /const\s+TOOL_CHANGE_SECONDS\s*=/.test(src),
    false,
    'a tool-change constant is declared in App.tsx again — read Report.tool_change_seconds'
  );
  assert.ok(
    src.includes('report?.tool_change_seconds ?? 0'),
    'the playback clock no longer reads the report’s own per-change rate'
  );
  assert.equal(
    src.includes('report?.tool_change_seconds ?? 120'),
    false,
    'absence is being filled with a guessed rate — the defect #90 removed, one number along'
  );
});

/* ────────────────────────────────────────────────────────────────────────────
   THE SPOILBOARD DECLARATION — #88, #89, and the eye
   ────────────────────────────────────────────────────────────────────────────

   ⚠ PART B RULES APPLY IN FULL: these read `App.tsx` AS TEXT. They prove the
   call is written, never that React runs it. The behaviour they stand in for is
   tested properly in `spoilboard-session.test.ts`, against the pure functions
   the product calls; what cannot be reached from node is the wiring between the
   two, and this is the only instrument that reaches it at all. Say "written",
   not "works". */

test('#89 — the spoilboard declaration is written into the session, all seven fields', () => {
  /* 🔴 THE DEFECT, GUARDED. `SessionValues` carried no spoilboard field at all,
   * so a reload reverted the board to UNDECLARED and every below-the-workpiece
   * cut went back to being judged on DEPTH ALONE — over the sacrificial board
   * and into the machine frame read identically. It failed in the SAFE
   * direction, which is exactly why nothing on screen showed it. */
  /* ⚠ THE ANCHORS MOVED ON 2026-08-11 AND THE GUARD MOVED WITH THEM — TODO
   * #108. The object was `const v: SessionValues = { … }` inside the write
   * effect; it is now a `useMemo` because `File → Save job…` writes the SAME
   * gathering to a file, and two gatherings would be two lists of fields that
   * drift. What is guarded is unchanged: every spoilboard key is IN it. And
   * because the job file is built from this same object, this test now also
   * covers what a saved job carries. */
  const start = src.indexOf('const sessionValues: SessionValues = useMemo(');
  assert.notEqual(start, -1, 'the session write object was renamed — this guard cannot see it');
  const end = src.indexOf('writeSession(sessionValues)', start);
  assert.notEqual(end, -1, 'the session write does not close in the expected shape');
  const obj = src.slice(start, end);
  for (const f of [
    'spoilboardId',
    'spoilboardX',
    'spoilboardY',
    'spoilboardSizeX',
    'spoilboardSizeY',
    'spoilboardName',
    'spoilboardPos',
    'spoilboardTravels',
  ]) {
    assert.ok(
      new RegExp(`\\b${f}\\b`).test(obj),
      `"${f}" is not written into the stored session — the board will not survive a refresh`
    );
  }
});

test('#88 — the machine picker RECONCILES the board instead of ignoring it', () => {
  /* 🔴 THE MEASURED DEFECT. The preset branch set `setTravelX/Y/Z` and returned:
   * zero spoilboard references in the handler. A 2400×1200 board fitted for a
   * 1250×670 machine then reported "none — the board covers the whole reach" on
   * a 6090, where the honest declaration gives 2204 frame-strike cells.
   *
   * ⚠ The needle is the CALL, not a comment. `strip` removes both comment forms
   * first, so the long note beside the call cannot satisfy this on its own —
   * which is the failure mode of every text guard and the one worth spending
   * four lines to avoid. */
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const start = src.indexOf("const parsed = parseRowId(ids[0] ?? '', ['preset', 'saved']);");
  assert.notEqual(start, -1, 'the machine picker onChange was rewritten — this guard cannot see it');
  /* Bounded by the NEXT prop rather than by a character count: a window sized to
   * a number silently shrinks past the branch it is supposed to cover the moment
   * a comment above it grows, and reports the code as missing. */
  const end = src.indexOf('onRemoveItem={(it) => {', start);
  assert.notEqual(end, -1, 'the machine picker onChange does not close in the expected shape');
  const handler = strip(src.slice(start, end));
  assert.ok(handler.length > 400, `the handler did not parse out (${handler.length} chars)`);
  assert.ok(
    /reconcileSpoilboardWithMachine\(\s*\[/.test(handler),
    'picking a machine preset does not ask the travel-fingerprint guard anything — a board fitted ' +
      'for one machine follows the operator onto another and reports it covers the whole reach'
  );
  assert.ok(
    /spoilboardForMachine\(/.test(handler),
    'loading a SAVED machine does not go through the guard either — a record is written from ' +
      'whatever is on the panels when Save is pressed, so its travels and its corner can describe ' +
      'two different machines'
  );
});

test('#88 — the guard has production callers at all, which is the whole finding', () => {
  /* `readSpoilboard` shipped correct and unreachable: a definition, four test
   * call sites, and a `spoilboards` store nothing wrote or read. A guard armed
   * only by its own test. This asserts the import exists in the product file,
   * because the definition passing its unit tests proved nothing about that. */
  assert.ok(
    /\breadSessionSpoilboard\b/.test(src) && /\bspoilboardForMachine\b/.test(src),
    'App.tsx does not import the spoilboard guard — it is back to being armed only by its tests'
  );
});

test('the hand-over control is DISABLED while the Run tab is streaming, not merely confirmed', () => {
  /* 🔴 `StreamingSignal`'s contract names exactly one duty for the tab that owns
   * the hand-over control: *"While `streaming` is true, DISABLE the hand-over
   * control (`data-testid="handover-run"`) — disable it, do not merely confirm.
   * The `window.confirm` there is a speed bump and says so; this signal is what
   * turns it into a refusal."*
   *
   * ⚠ TEXT, NOT BEHAVIOUR (Part B). It proves the signal reaches `disabled` and
   * the click path, never that React re-renders. */
  const start = src.indexOf('data-testid="handover-run"');
  assert.notEqual(start, -1, 'the hand-over control was renamed — this guard cannot see it');
  const end = src.indexOf('data-testid="handover-state"', start);
  assert.notEqual(end, -1, 'the hand-over control does not close in the expected shape');
  const region = src.slice(start, end);

  assert.ok(
    /disabled=\{[^}]*streamSignal\?\.streaming === true[^}]*\}/.test(region),
    'the hand-over control is not disabled while the Run tab is streaming — a re-plan can replace ' +
      'the program under a job that is being fed to a controller'
  );
  /* Belt as well as braces: `disabled` is the control an operator sees; the
   * early return is the one a driver or a stale render goes through. */
  assert.ok(
    /if \(streamSignal\?\.streaming\) return;/.test(region),
    'the refusal exists only as an attribute, so it has one door'
  );
  assert.ok(
    /onStreaming=\{setStreamSignal\}/.test(src),
    'nothing subscribes to RunTab’s streaming signal, so the refusal above can never fire'
  );
});

test('`streaming === false` is not rendered as “the machine is stopped”', () => {
  /* 🔴 THE SENTENCE THE SIGNAL CARRIES BECAUSE A CONSUMER WOULD OTHERWISE GET IT
   * WRONG. `streaming === false` means this tab is not feeding lines. The
   * controller still holds everything already sent — up to a full RX buffer —
   * and keeps executing it with the spindle turning; after a lost link it is
   * *especially* not stopped, because nothing was told to stop.
   *
   * So the signal's own `why` is rendered UNCHANGED and rendered whether or not
   * it is streaming — an enabled button is exactly what invites the wrong
   * inference. */
  assert.ok(
    /data-testid="handover-streaming"/.test(src),
    'the streaming sentence is not rendered beside the control it qualifies'
  );
  assert.ok(
    /\{streamSignal\.why\}/.test(src),
    'the signal’s own sentence is paraphrased or dropped rather than rendered verbatim'
  );
  /* ✅ THE STALE CLAIM, GUARDED AGAINST COMING BACK. The confirm dialog used to
   * say "This app cannot tell whether the machine is running." It can tell
   * whether this TAB is streaming; it still cannot tell whether the MACHINE is
   * moving, and the two are different sentences. The false one must not return. */
  assert.equal(
    /cannot tell whether the machine is running/.test(src),
    false,
    'the corrected claim came back — the app CAN observe the stream now; what it cannot observe ' +
      'is the machine, and those are different statements'
  );
});

test('the canvas is fed the board, and NOT by a bare `??` — the eye bug and its trap', () => {
  /* 🔴 FOUNDER, 2026-08-11: *"I did choose a spoilboard but the eye did not come
   * up."* `scene.spoilboard` was `report?.spoilboard ?? null` while every other
   * field in the same literal falls back to the DECLARATION. `spoilLive =
   * !!s.spoilboard`, so with no report the layer was not live and — correctly,
   * by the dead-control rule — no eye was rendered.
   *
   * ⚠ AND THE OBVIOUS FIX IS THE TRAP. `report?.spoilboard ?? <declaration>`
   * would draw a board the CORE REFUSED — measured: a refused declaration echoes
   * `null` and pushes `SPOILBOARD NOT INSTALLED`. So this asserts BOTH: that the
   * canvas is fed something other than the raw echo, and that the refusal state
   * is still separated out. */
  assert.equal(
    /spoilboard:\s*report\?\.spoilboard\s*\?\?/.test(src),
    false,
    'the canvas is back on a bare `??` for the board — either no eye at all, or an eye for a board ' +
      'the core threw away'
  );
  assert.ok(
    /spoilboard:\s*spoilboardDrawn\.board/.test(src),
    'the canvas is not fed the five-state board — see `spoilboardDrawn`'
  );
  assert.ok(
    src.includes("startsWith('SPOILBOARD NOT INSTALLED')"),
    'nothing separates a REFUSED declaration from an unplanned one, so the canvas can assert a ' +
      'board the core rejected'
  );
});

/* ════════════════════════════════════════════════════════════════════════════
   THE MATERIAL MOVED HOUSE — founder, 2026-08-11: *"merge the material into the
   Workpiece list … remove the Material selection"*
   ════════════════════════════════════════════════════════════════════════════

   🔴 THE STANDING TEST FOR THAT CHANGE IS THAT NOTHING CHANGES. `material` is a
   field of `Job`, and `core/src/tools.rs` derives the chipload factor, the
   depth-of-cut ratio and the rpm cap from it — so a job configured with a
   material must emit the SAME program before and after the control moved. If a
   feed moves, the material was LOST and replaced rather than moved.

   ⚠ WHAT WAS ACTUALLY RUN, said plainly. A true before-vs-after G-code diff is
   not available on this box: the "before" is a UI state nobody can render here
   (`App.tsx` does not import in node — see this file's header). What runs is the
   defensible reduction: CONFIG-IN → CONFIG-OUT, through the browser's own wasm.
   The config is asserted to still carry `material`, the same config is asserted
   to emit byte-identical bytes, and a DIFFERENT material is asserted to emit
   different bytes — so a change that dropped the field would be caught by the
   third even though the first two would still pass. */

test('the material this app sends reaches the emitted program — and an ABSENT one is silently Plywood', () => {
  const ply = plan('plate', { ...FLUSH_IN_THE_CORNER, material: 'Plywood' });
  const again = plan('plate', { ...FLUSH_IN_THE_CORNER, material: 'Plywood' });
  const alu = plan('plate', { ...FLUSH_IN_THE_CORNER, material: 'Aluminium' });
  const absent = plan('plate', { ...FLUSH_IN_THE_CORNER });

  assert.equal(ply.ok, true, `plywood did not post: ${JSON.stringify(ply.errors)}`);
  assert.equal(alu.ok, true, `aluminium did not post: ${JSON.stringify(alu.errors)}`);

  // CONFIG-IN → CONFIG-OUT, byte-identical. The reduction named above.
  assert.equal(ply.gcode, again.gcode, 'the same config emitted two different programs');

  // 🔴 The material is LIVE: it is not decoration on the panel.
  assert.notEqual(
    ply.gcode,
    alu.gcode,
    'the material reached no coordinate — it has stopped scaling the program, which is what ' +
      'losing it in the move would look like'
  );

  /* 🔴 MEASURED, AND IT IS THE REASON THE UI MUST NEVER SEND `undefined`. With
   * the key absent the core plans PLYWOOD and says nothing: byte-for-byte the
   * same program. So a workpiece record with no stored material, loaded into the
   * job as `undefined`, would have produced a plywood program behind a blank
   * control — a default nobody chose, invisible in the output. `App.tsx` keeps
   * the job's existing material instead, and the agreement line says the record
   * neither confirmed nor contradicted it. */
  assert.equal(
    absent.gcode,
    ply.gcode,
    'an absent material no longer defaults to Plywood in the core — the note in App.tsx that ' +
      'depends on this measurement needs re-reading'
  );

  /* ⚠ AND NOT EVERY MATERIAL DISCRIMINATES. MDF carries the same chipload
   * factor (1.0), the same depth ratio (0.50) and the same rpm cap (24000) as
   * plywood in `core/src/tools.rs`, so it emits an IDENTICAL program. A guard
   * written on MDF would be a green that proved nothing; aluminium (0.35 /
   * 0.15 / 12000) is the one that moves. Recorded here so the next person to
   * pick a material for a test does not pick the silent one. */
  const mdf = plan('plate', { ...FLUSH_IN_THE_CORNER, material: 'MDF' });
  assert.equal(
    mdf.gcode,
    ply.gcode,
    'MDF and plywood now differ — this comment is stale and a stronger guard is available'
  );
});

/* The three guards below read CODE, NOT PROSE.
 *
 * 🔴 THEY WERE WRITTEN AGAINST `src` FIRST AND BOTH WENT RED IMMEDIATELY — on
 * `App.tsx`'s own comments, which quote the removed expressions in order to
 * record what was removed and why. That is the scanner-matches-the-text-that-
 * discusses-what-it-scans-for failure, committed while writing a guard against
 * it. The comments are the valuable half and are kept; the guard reads a
 * comment-stripped copy instead, exactly as Part B above strips the memo body
 * for the same reason. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
assert.ok(code.length > src.length * 0.4, 'comment stripping ate the file — this guard is blind');

test('the material still reaches the config object — the value moved house, it did not leave', () => {
  /* 🔴 THE ONE THING THE MOVE COULD HAVE BROKEN SILENTLY, and the dep-array
   * guard above CANNOT see it: that guard requires every state name READ by the
   * config body to appear in the deps, so deleting `material` from the body
   * altogether would satisfy it vacuously — the field would simply stop being
   * read, `missing` would stay empty, and the suite would be green over a job
   * planned with no material at all. (Which the core answers with plywood, as
   * measured above: silently, and byte-identically.) */
  const start = code.indexOf('const config: JobConfig = useMemo(');
  assert.notEqual(start, -1, 'the config useMemo was renamed — this guard cannot see it');
  const end = code.indexOf('\n    ]\n  );', start);
  assert.notEqual(end, -1, 'the config useMemo does not close in the expected shape');
  const memo = code.slice(start, end);
  /* 🔴 THE BODY, NOT THE WHOLE MEMO — and the first cut of this guard got that
   * wrong and was caught by its own plant. `material` appears in the DEPENDENCY
   * ARRAY as well, so a check over the memo as a whole stayed green after the
   * field was deleted from the object: the dep list alone was enough to satisfy
   * it. A guard that passes on the defect it names is worse than none, and the
   * only reason this one is not still doing so is that the plant was run and
   * watched. */
  const depsAt = memo.lastIndexOf('\n    [');
  assert.notEqual(depsAt, -1, 'no dependency array found inside the config useMemo');
  const memoBody = memo.slice(0, depsAt);
  assert.ok(memoBody.length > 500, `the memo body did not parse out (${memoBody.length} chars)`);
  assert.ok(
    /\bmaterial,/.test(memoBody),
    'the config object no longer carries `material` — the job would be planned with none, which ' +
      'the core answers with plywood, silently and byte-identically'
  );
});

test('the Material control lives in the Workpiece section, and the old picker is gone', () => {
  /* 🔴 THE NEEDLE IS THE LIVE FORM, NOT THE WORD. `App.tsx` still SAYS
   * `material-picker` — in the comment recording that it was removed and why. A
   * guard on the bare string would go red on the note that explains it, which is
   * the scanner-matches-its-own-subject failure this lane keeps writing down. So
   * it asserts the absence of the TESTID, which only a live control carries. */
  assert.equal(
    /testid=['"]material-picker/.test(code),
    false,
    'the standalone Material picker is back — the founder asked for it to be removed and for the ' +
      'material to be a property of the workpiece'
  );
  assert.ok(
    /data-testid="material"/.test(code),
    'no material control at all — the value moved house, it did not stop existing'
  );

  /* The dropdown's options come from the CORE's list. The old picker fell back
   * to a hardcoded `[{ name: 'Plywood' }]` while the wasm loaded, which is a
   * second copy of `Material::as_str` under another name. */
  assert.equal(
    /\[\{\s*name:\s*'Plywood'\s*\}\]/.test(code),
    false,
    'a hardcoded material list is back in App.tsx — the library is the core’s'
  );
});

test('a saved workpiece that states no material does not write one into the job', () => {
  /* 🔴 THE LINE THAT WAS THERE: `setMaterial(w.material)`, unconditional. For a
   * record saved before this app kept a material that writes `undefined` into
   * the job's material, `JSON.stringify` drops the key, and the core plans
   * plywood — measured in the test above. A feed scaled by a material nobody
   * chose is this lane's worst UI defect wearing a new face. */
  assert.equal(
    /setMaterial\(w\.material\)/.test(code),
    false,
    'the saved-workpiece arm writes the record’s material unconditionally again — an absent one ' +
      'becomes `undefined` and the core silently plans plywood'
  );
  assert.ok(
    /const stated = materialOfWorkpiece\(w\);/.test(code) && /if \(stated\) setMaterial\(stated\);/.test(code),
    'the guarded form is gone — absence must leave the job’s material alone, not overwrite it'
  );
});

test('the verdict guard and the ask that triggers it are ONE object, not two lists', () => {
  /* 🔴 ITEM 3'S REAL HAZARD. The drawing list FILTERS on `fit`, which is computed
   * against the workpiece in `config`. The verdicts arrive asynchronously, so
   * between the workpiece changing and the reply landing the held answer
   * describes the PREVIOUS workpiece — and a cached verdict is confidently wrong
   * rather than obviously broken.
   *
   * `answerFor` returns the reply only while the ask it was requested under is
   * still the ask. What makes that sound is that the SAME memo is the effect's
   * dependency and the stored stamp: a second fingerprint would be a copy, and
   * the failure mode of a copy is omitting the input added last — which would
   * hand back an answer the effect has already decided is stale, while looking
   * checked.
   *
   * ⚠ A TEXT GUARD, so it proves the shape and not the behaviour. What it can
   * see: that the stamp stored is the ask object itself, and that the effect
   * depends on that same identifier. What no node test can see: that React
   * re-runs the effect. */
  for (const ask of ['drawingAsk', 'toolAsk']) {
    assert.ok(
      new RegExp(`ask: ${ask}`).test(code),
      `the ${ask} reply is stored without the question it answers`
    );
    assert.ok(
      new RegExp(`\\}, \\[ready, ${ask}\\]\\);`).test(code),
      `the ${ask} effect no longer depends on the same object it stamps with — the guard and the ` +
        `trigger can now disagree, which is worse than no guard`
    );
    assert.ok(
      new RegExp(`answerFor\\(held\\w+, ${ask}\\)`).test(code),
      `nothing gates the held ${ask} reply, so a stale verdict can be filtered on`
    );
  }

  /* 🔴 AND THE PENDING STATE IS ANNOUNCED. Gating the stale answer turns a wrong
   * verdict into an ABSENT one — which is right, and which the *"outline on the
   * workpiece"* filter then narrows on. A list quietly emptying itself while the
   * core catches up is a filter swallowing its own reason: the recorded failure
   * is that filtering the selection before announcing status silences the
   * warning for whoever narrowed the scope. So the waiting state is printed. */
  assert.ok(
    /data-testid="drawing-verdicts-pending"/.test(code),
    'nothing tells the operator that the setup moved and nothing has been judged against the new ' +
      'one yet, so the fit filter narrows on an answer that does not exist'
  );
});

test('no source file carries a RAW NUL BYTE — it makes grep call the file binary', () => {
  /* 🔴 MEASURED 2026-08-11, and it explains a hazard this lane had recorded as
   * *"grep silently skipped App.tsx"*. Two files held a literal NUL: the
   * drawing-instance separator (`join('\0')`) and `FACET_NOT_STATED`. Both were
   * written as the BYTE rather than the escape, which makes `grep` classify the
   * file as binary and print NOTHING — no matches, no error, no exit code to
   * notice. A search that comes back empty and a file with no matches are
   * identical on screen, and this lane's whole method is grepping this file.
   *
   * The escapes carry the same values, so nothing about the strings changed. */
  const dir = new URL('../src/', import.meta.url);
  const fs = require_fs();
  const bad: string[] = [];
  const walk = (u: URL) => {
    for (const e of fs.readdirSync(u, { withFileTypes: true })) {
      const child = new URL(e.name + (e.isDirectory() ? '/' : ''), u);
      if (e.isDirectory()) {
        if (e.name === 'wasm' || e.name === 'assets' || e.name === 'samples') continue;
        walk(child);
      } else if (/\.(ts|tsx)$/.test(e.name)) {
        if (fs.readFileSync(child).includes(0)) bad.push(e.name);
      }
    }
  };
  walk(dir);
  assert.deepEqual(bad, [], `raw NUL bytes in source: ${bad.join(', ')}`);
});

/* ════════════════════════════════════════════════════════════════════════════
   🔴 ONE TOOL GOES THROUGH THE SAME DOOR AS MANY
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THE DEFECT THIS GUARDS EMITTED G-CODE WITH MATERIAL LEFT STANDING AND SAID
 * NOTHING.
 *
 * `App.tsx` used to send the SINGULAR `tool_id` at exactly one tool and the set
 * only at two or more. They are two different doors into `core/src/job.rs` and
 * they do not agree:
 *
 *   · `tool_id`  — the tool is written onto every operation and `apply_tool_set`
 *     returns immediately on `None`, so `tool_set_refusals` stays EMPTY and the
 *     check at `job.rs:1140` has nothing to refuse. The recommender never runs.
 *   · `tool_ids` — `assign_tools_from_set` → `recommend()` per feature, and the
 *     rejections become `tool_set_refusals`, which is what reaches the planner.
 *
 * MEASURED AT THE CORE, same fixture, same ONE tool
 * (`2bee-slice job pocket --config …`):
 *
 *   `{"tool_id":  "End Mill - Down-cut 6mm 2F"}` → exit 0, **962 lines, zero
 *     refusals**, simulator `Uncut { x: 120.6, y: 90.6, standing_mm: 6.0 }`.
 *   `{"tool_ids":["End Mill - Down-cut 6mm 2F"]}` → exit 1, **no G-code**,
 *     refused *"6mm does not fit inside this loop"*.
 *
 * ⚠ SOURCE-TEXT, and it is the honest limit: `App.tsx` cannot be imported here
 * (the sample `.dxf` imports stop the loader — see this file's header), so this
 * reads the send site rather than observing a config object. It catches the
 * branch coming back, which is the thing that would actually happen; it does not
 * re-prove the core behaviour, which was measured with the CLI and is recorded
 * above and at the send site.
 *
 * ⚠ TYPESCRIPT CANNOT CATCH THE REVERSION. The config literal uses spreads,
 * which switches off excess-property checking, so `tool_id` could come back with
 * a clean `tsc`. That is precisely why this is a test and not a type.
 */
test('the tool set is sent at EVERY count, so one tool cannot skip the recommender', () => {
  const start = src.indexOf('const config: JobConfig = useMemo(');
  assert.notEqual(start, -1, 'the config useMemo was renamed — this guard cannot see it');
  const end = src.indexOf('\n    ]\n  );', start);
  assert.notEqual(end, -1, 'the config useMemo does not close in the expected shape');
  const body = src
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[^\n]*?\/\/[^\n]*$/gm, ' ');

  assert.match(body, /\btool_ids: toolIds,/, 'the config no longer sends the tool set at all');
  assert.doesNotMatch(
    body,
    /\btool_id\b\s*:/,
    'the singular tool_id door is being used again — at one tool it skips the per-feature ' +
      'recommender entirely, and the measured consequence is a 962-line program with 6mm of ' +
      'material standing and refusals: []',
  );
  /* And there is no count-dependent branch left anywhere near it: the whole
   * defect was `toolIds.length > 1 ? … : …`. */
  assert.doesNotMatch(
    body,
    /toolIds\.length\s*[><]/,
    'the tool door branches on how many tools were chosen again',
  );
});

/**
 * ⚠ THE COUNT-ZERO CASE IS HANDLED ELSEWHERE AND MUST STAY THAT WAY. The planner
 * returns before building a config when nothing is selected, so this send site
 * never emits an empty set — which matters because `assign_tools_from_set` takes
 * an empty list as "the user selected nothing" and does nothing at all, which is
 * the singular door's behaviour arriving through the other one.
 */
test('nothing is planned with an empty tool set', () => {
  assert.match(
    src,
    /if \(toolIds\.length === 0\) \{\s*\n\s*setReport\(null\);/,
    'the zero-tool guard is gone, so an empty set can now reach the core and do nothing silently',
  );
});
