// The 2026-08-11 UI text sweep, held in place.
//
// Founder: *"be tidy, no unnecessary text, make it clean end to end."* The
// failure mode of that instruction is deleting a REASON, so most of what follows
// asserts that a sentence a tidiness pass would reach for is STILL THERE — and
// only then that the duplicate of it is gone. Findings and their numbering:
// `docs/audit/2026-08-11-ui-text-sweep.md`.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 WHAT THIS FILE CANNOT SEE, SAID FIRST
// ─────────────────────────────────────────────────────────────────────────────
//
//  1. **THERE IS NO BROWSER HERE.** Everything below is server-rendered markup
//     or source text. It can show that two expressions no longer produce the
//     same sentence; it cannot show that the surviving one is legible, in view,
//     or above the fold. Five of the sweep's findings are tagged `[text-only]`
//     for exactly that reason and the ones acted on are named in the report.
//
//  2. **CO-OCCURRENCE, NOT LAYOUT.** `renderToStaticMarkup` proves both strings
//     are in one document. Whether they land in one visual field is a question
//     for `web/e2e/` and a screen.
//
//  3. **NOTHING HERE GUARDS THE `report.notes` DUPLICATION AT THE PANEL THAT
//     CLAIMS IT.** §3.1–3.3 were deliberately NOT actioned — see the invariant
//     below, which asserts the opposite of the audit's recommendation and says
//     why in its own comment. If that decision is revisited, this file goes red
//     first, which is the point.
//
// ⚠ `createElement` rather than JSX: `npm run test:node` globs `tests/*.test.ts`
// and a `.tsx` here would simply not be collected — a test that is not collected
// is indistinguishable from one that passes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import ObjectPicker, { SectionHeadingContext } from '../src/ObjectPicker.tsx';
import { RunTab, StopPanel } from '../src/RunTab.tsx';
import { initialTrackedState, refusalsFor, type TrackedState } from '../src/run/protocol.ts';

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string) => readFileSync(join(here, '..', 'src', p), 'utf8');

/** React escapes; the needles in this file are written as a human reads them. */
function unescape(html: string): string {
  return html
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * The text nodes, with the tags gone.
 *
 * 🔴 ATTRIBUTES ARE NOT TEXT, and this distinction is the whole point of the
 * finding it serves. `Control` puts every reason in a `title` AND in a rendered
 * span, deliberately — its own comment says a reason living only in a tooltip is
 * a control that fails silently for anyone on a touch screen or a keyboard. A
 * counter that read the `title` would report every refusal as a duplicate of
 * itself and would push somebody to delete the visible half.
 */
function textOf(html: string): string {
  return unescape(html.replace(/<[^>]*>/g, ' '));
}

/** How many times a plain sentence appears in rendered TEXT. */
function occurrences(html: string, needle: string): number {
  const hay = textOf(html);
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) n += 1;
  return n;
}

/** The markup of the element carrying `data-testid`, balanced by tag depth. */
function section(html: string, testid: string): string {
  const i = html.indexOf(`data-testid="${testid}"`);
  assert.notEqual(i, -1, `no element with data-testid="${testid}"`);
  const start = html.lastIndexOf('<', i);
  const tag = /^<([a-zA-Z][-a-zA-Z0-9]*)/.exec(html.slice(start))?.[1];
  assert.ok(tag, 'could not read the tag name');
  const open = new RegExp(`<${tag}[\\s>/]`, 'g');
  const close = new RegExp(`</${tag}>`, 'g');
  let depth = 0;
  let cursor = start;
  for (let guard = 0; guard < 10_000; guard++) {
    open.lastIndex = cursor;
    close.lastIndex = cursor;
    const o = open.exec(html);
    const c = close.exec(html);
    if (!c) return html.slice(start);
    if (o && o.index < c.index) {
      depth += 1;
      cursor = o.index + 1;
      continue;
    }
    depth -= 1;
    cursor = c.index + 1;
    if (depth <= 0) return html.slice(start, c.index + `</${tag}>`.length);
  }
  return html.slice(start);
}

const connected = (over: Partial<TrackedState> = {}): TrackedState => ({
  ...initialTrackedState(),
  tab: 'Idle',
  controllerState: 'Idle',
  ...over,
});

/* ═══════════════════════════════════════════════════════════════════════════
   §9.1 — THE RUN TAB'S DOUBLE REFUSALS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The invariant, as a function, so it can be run against a PLANTED document.
 *
 * Two halves, and they pull in opposite directions on purpose:
 *  (a) no refusal's sentence stands twice — that is the tidiness half;
 *  (b) every id that appears in the index has its `fact` and `why` under a
 *      control on the same page — that is the safety half, and it is the one
 *      that would go quiet if somebody deleted the per-button reason instead.
 */
function refusalCopyProblems(html: string): string[] {
  const out: string[] = [];
  const s = connected();
  for (const r of refusalsFor('start-job', s)) {
    const n = occurrences(html, r.fact);
    if (n === 0) out.push(`${r.id}: its fact reached no surface at all`);
    if (n > 1) out.push(`${r.id}: its fact is on screen ${n} times`);
  }
  // (b) Every indexed id is explained at a control.
  const index = html.includes('data-testid="run-refusal-index"')
    ? section(html, 'run-refusal-index')
    : '';
  for (const id of index.match(/R\d+/g) ?? []) {
    const explained = [...html.matchAll(/data-testid="run-refused-[^"]*"[^>]*>([^<]*)/g)].some(
      (m) => m[1].includes(id) && m[1].replace(id, '').trim().length > 4
    );
    if (!explained) out.push(`${id} is indexed with no reason beside any control`);
  }
  return out;
}

test('§9.1 — a refusal reaches the operator ONCE, and the copy that survives is the one at the control', () => {
  const html = renderToStaticMarkup(h(RunTab, { tracked: connected(), now: 0 }));
  assert.deepEqual(refusalCopyProblems(html), []);

  // The per-button reason is the survivor, in full.
  const start = section(html, 'run-refused-start');
  assert.match(start, /R1/);
  assert.match(unescape(start), /\$H/);

  /* And the list is now an INDEX for those, not a second copy. `Refused right
   * now, and why` keeps its own argument — completeness — so every id is still
   * named there. */
  const index = section(html, 'run-refusal-index');
  assert.match(index, /R1/, 'a refusal answered at a control vanished from the list entirely');
  assert.match(index, /start-job/, 'the index drops which action the id belongs to');
});

test('§9.1 — `auto-resume` and `console-gcode` have no control, so they print IN FULL', () => {
  const html = renderToStaticMarkup(h(RunTab, { tracked: connected(), now: 0 }));
  const refusals = section(html, 'run-refusals');

  /* R11 (auto-resume) has no button anywhere.
   *
   * ⚠ R5/console-gcode is an orphan TOO, and the audit's §9.1 table said it was
   * answered under the console input. Measured: `ConsolePanel` is handed
   * `consoleRefusals`, which is the refusal set of a bare `?` — the link rule
   * and nothing else. `console-gcode`'s R5 only ever renders as a transcript
   * entry, after somebody has typed g-code. */
  for (const [action, needle] of [
    ['auto-resume', 'automatic resumption is never offered'],
    ['console-gcode', 'the console accepts $ commands and realtime bytes only'],
  ] as const) {
    assert.ok(
      unescape(refusals).includes(needle),
      `${action} has no control of its own and lost its full text from the list`
    );
  }
});

test('🔴 PLANT §9.1 — a refusal that lost its reason goes RED', () => {
  const clean = renderToStaticMarkup(h(RunTab, { tracked: connected(), now: 0 }));
  assert.deepEqual(refusalCopyProblems(clean), [], 'precondition: the tab is clean');

  /* The defect: `Control` stops rendering its reason span and the operator is
   * left with a greyed-out button, an id in a list, and nothing that says what
   * to do. Applied to a COPY of the markup; nothing is written to the tree. */
  const planted = clean.replace(
    /<span class="note" data-testid="run-refused-start"[^>]*>[\s\S]*?<\/span>/,
    ''
  );
  assert.notEqual(planted, clean, 'the plant did not apply — the assertion below would be vacuous');
  const problems = refusalCopyProblems(planted);
  assert.ok(
    problems.some((p) => /R1/.test(p)),
    `a refusal with no reason anywhere was not caught: ${JSON.stringify(problems)}`
  );
});

test('🔴 PLANT §9.1 — the list printing the sentence a second time goes RED', () => {
  const clean = renderToStaticMarkup(h(RunTab, { tracked: connected(), now: 0 }));
  const r1 = refusalsFor('start-job', connected()).find((r) => r.id === 'R1')!;

  /* The state this sweep found: `RefusalList` restating what `Control` already
   * says. Simulated by appending one more copy of R1's fact to the list. */
  const planted = clean.replace(
    'data-testid="run-refusal-index"',
    `data-testid="run-refusal-index" data-plant="${r1.fact.replace(/"/g, '')}"`
  ).replace('</p></div>', `${r1.fact}</p></div>`);
  assert.notEqual(planted, clean, 'the plant did not apply');
  assert.ok(
    refusalCopyProblems(planted).some((p) => /on screen 2 times/.test(p)),
    'a refusal restated in the list was not caught'
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
   §9.4 — "Seven things Stop does not guarantee", and the Abort bullet in it
   ═══════════════════════════════════════════════════════════════════════════ */

/** A heading that states a number the list under it does not produce. */
function countDriftProblems(html: string): string[] {
  const out: string[] = [];
  const limits = section(html, 'run-stop-limits');
  const stated = /\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+things\b/i.exec(
    unescape(limits)
  );
  if (stated) out.push(`the heading states "${stated[0]}" and nothing keeps it in step`);
  if (/does not decelerate/i.test(limits)) out.push('an Abort limit sits under a Stop heading');
  return out;
}

test('§9.4 — the Stop list is scoped to Stop and states no count', () => {
  const html = renderToStaticMarkup(h(StopPanel, { stopRefusals: [], abortRefusals: [] }));
  assert.deepEqual(countDriftProblems(html), []);

  /* 🔴 THE BULLET WAS MOVED, NOT DELETED. It is safety-bearing and it now leads
   * the Abort paragraph, which is where Abort lives. */
  assert.match(section(html, 'run-abort-cost'), /does not decelerate/i);
});

test('🔴 PLANT §9.4 — a hardcoded count beside a literal list goes RED', () => {
  const clean = renderToStaticMarkup(h(StopPanel, { stopRefusals: [], abortRefusals: [] }));
  assert.deepEqual(countDriftProblems(clean), [], 'precondition: the panel is clean');

  // (a) The count comes back and immediately disagrees with the list.
  const counted = clean.replace('What Stop does not guarantee:', 'Seven things Stop does not guarantee:');
  assert.notEqual(counted, clean, 'the plant did not apply');
  assert.ok(countDriftProblems(counted).some((p) => /Seven things/.test(p)));

  // (b) The Abort bullet is put back under the Stop heading.
  const rescoped = clean.replace(
    '<li><strong>Nothing here stops the spindle at the wall.</strong>',
    '<li><strong>Abort does not decelerate.</strong> It kills the steppers.</li>' +
      '<li><strong>Nothing here stops the spindle at the wall.</strong>'
  );
  assert.notEqual(rescoped, clean, 'the second plant did not apply');
  assert.ok(countDriftProblems(rescoped).some((p) => /Abort limit/.test(p)));
});

/* ═══════════════════════════════════════════════════════════════════════════
   §2.1 / §2.2 — the founder's `Machine / Machine`
   ═══════════════════════════════════════════════════════════════════════════ */

const picker = (heading: string, label: string) =>
  renderToStaticMarkup(
    h(
      SectionHeadingContext.Provider,
      { value: heading },
      h(ObjectPicker, {
        label,
        testid: 'p',
        mode: 'single' as const,
        placeholder: 'choose a machine…',
        items: [],
        selectedIds: [],
        onChange: () => {},
      })
    )
  );

/** Text an operator can actually SEE — spans carrying `op-label-quiet` are
 *  clipped to a 1px box and read only by assistive technology. */
function visibleText(html: string): string {
  return textOf(html.replace(/<span[^>]*op-label-quiet[^>]*>[\s\S]*?<\/span>/g, ''));
}

/**
 * The founder's complaint, as a check: under a heading that already says the
 * noun, how many times does the trigger's ACTION print that noun on screen?
 *
 * ⚠ SCOPED TO THE ACTION SPAN, not to the whole trigger, and that is §2.2's
 * finding rather than a convenience. With nothing chosen the trigger also shows
 * the placeholder — `choose a machine…` — and that one STAYS: it is the empty
 * state's only visible naming surface once both halves of TODO #77 hold, and a
 * check that counted it would push somebody to delete it.
 */
function headingRepeatProblems(html: string, noun: string): string[] {
  const out: string[] = [];
  const action = section(html, 'p-action');
  const seen = visibleText(action).toLowerCase().split(noun.toLowerCase()).length - 1;
  if (seen > 0) out.push(`the trigger prints "${noun}" ${seen} time(s) under a heading that says it`);
  // The safety half: it must still be ANNOUNCED.
  if (!textOf(action).toLowerCase().includes(noun.toLowerCase())) {
    out.push('the accessible name lost the noun — the button announces a bare verb');
  }
  return out;
}

test('§2.1 — under a matching heading the trigger shows the verb and announces the noun', () => {
  const html = picker('Machine', 'Machine');
  assert.deepEqual(headingRepeatProblems(html, 'Machine'), []);

  // Visible: the verb. Announced: both.
  const action = section(html, 'p-action');
  assert.match(visibleText(action), /Choose/);
  assert.doesNotMatch(visibleText(action), /Machine/);
  assert.match(textOf(action), /Choose\s*Machine/);
  assert.match(action, /data-quiet="true"/);

  /* And `aria-labelledby` still points at that span, which is what makes the
   * clipped noun the button's name rather than decoration. */
  const trigger = section(html, 'p-trigger');
  const id = /id="([^"]*)"[^>]*data-testid="p-action"/.exec(html)?.[1];
  assert.ok(id, 'the action span lost its id');
  assert.ok(trigger.includes(`aria-labelledby="${id}"`), 'the trigger no longer names itself from it');
});

test('§2.2 — the empty state puts the noun on screen ONCE, not three times', () => {
  const visible = visibleText(section(picker('Machine', 'Machine'), 'p-trigger'));
  /* Three renderings used to co-occur: the heading (outside this markup), the
   * placeholder, and `Choose Machine`. What is left inside the control is the
   * placeholder alone — which is legible and is the empty state's only visible
   * naming surface, exactly as `App.tsx`'s comment beside it now claims. */
  assert.equal(visible.toLowerCase().split('machine').length - 1, 1, visible);
  assert.match(visible, /choose a machine…/);
});

test('§2.1 — a picker with no provider is UNCHANGED, so `web/src/cad/` is untouched', () => {
  const html = renderToStaticMarkup(
    h(ObjectPicker, {
      label: 'Machine',
      testid: 'p',
      mode: 'single' as const,
      placeholder: 'choose a machine…',
      items: [],
      selectedIds: [],
      onChange: () => {},
    })
  );
  assert.match(visibleText(section(html, 'p-action')), /Choose\s*Machine/);
  assert.match(section(html, 'p-action'), /data-quiet="false"/);
  assert.match(textOf(section(html, 'p-action')), /Choose\s*Machine/);
});

test('🔴 PLANT §2.1 — the `Machine / Machine` repeat coming back goes RED', () => {
  const clean = picker('Machine', 'Machine');
  assert.deepEqual(headingRepeatProblems(clean, 'Machine'), [], 'precondition: clean');

  // The defect: the noun is printed rather than clipped.
  const planted = clean.replace(/class="op-label-quiet"/g, 'class=""');
  assert.notEqual(planted, clean, 'the plant did not apply');
  assert.ok(
    headingRepeatProblems(planted, 'Machine').some((p) => /prints "Machine"/.test(p)),
    'a visible heading repeat was not caught'
  );
});

test('🔴 PLANT §2.1 — the accessible name lost from the trigger goes RED', () => {
  const clean = picker('Machine', 'Machine');

  /* The tidy-looking fix that must never ship: delete the noun instead of
   * clipping it. The button then announces "Choose, button". */
  const planted = clean.replace(/<span class="op-label-quiet"[^>]*>[\s\S]*?<\/span>/, '');
  assert.notEqual(planted, clean, 'the plant did not apply');
  assert.ok(
    headingRepeatProblems(planted, 'Machine').some((p) => /accessible name/.test(p)),
    'a trigger announcing a bare verb was not caught'
  );
});

/* ═══════════════════════════════════════════════════════════════════════════
   §3.1–3.3 — `report.notes`, AND THE DECISION NOT TO FILTER IT
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THIS ASSERTS THE OPPOSITE OF THE AUDIT'S RECOMMENDATION, DELIBERATELY.
 *
 * The audit proposed that `Notes and warnings` render `report.notes` minus the
 * notes a specialist panel has already claimed. Two properties it did not weigh
 * make that a safety regression rather than a tidy-up:
 *
 *  1. **`Section` COLLAPSE IS STICKY AND A SHUT SECTION RENDERS NOTHING.**
 *     `panel-spoilboard` had no `badge`, so an operator who collapsed it once
 *     saw no sign that a board note existed — and with the notes filtered out of
 *     `panel-notes` there would be no other always-on surface. `panel-notes` was
 *     the only one of the two whose header states a count while shut, which is
 *     the exact hole the `badge` prop was added to close.
 *  2. **`estimate-why` IS A `<details>` THAT IS SHUT BY DEFAULT.** Moving a
 *     run-time caveat there hides it behind a disclosure triangle.
 *
 * ✅ **HALF OF (1) WAS DISCHARGED ON 2026-08-12 AND THE ANSWER DID NOT CHANGE —
 * left visible, because a reason that has quietly stopped being true reads
 * exactly like one that still is.** `panel-spoilboard` NOW CARRIES A BADGE
 * (`spoilboardFindings`, `tests/spoilboard-badge.test.ts`), measured in a browser:
 * a planned job with no board declared shows `1 warning · 2 PENDING` on the shut
 * header. So the specific hole this paragraph named — a collapsed board panel
 * with no signal at all — is closed.
 *
 * 🔴 **THE UNFILTERED RECORD STILL STAYS, AND (2) IS WHY, PLUS A FORK THAT IS THE
 * FOUNDER'S.** The badge is what makes the filter question ASKABLE; it does not
 * answer it. Filtering `panel-notes` is a behaviour change — which sentence an
 * operator can no longer reach in one place — and `docs/plan-2026-08-12` lists it
 * as blocked on him with two live options. **If this test goes red, someone has
 * taken that decision without him.**
 */
function notesPanelProblems(source: string): string[] {
  const out: string[] = [];
  const i = source.indexOf('testid="panel-notes"');
  if (i === -1) return ['`panel-notes` is gone'];
  const body = source.slice(i, source.indexOf('</Section>', i));
  if (!body.includes('report.notes.map(')) out.push('`Notes and warnings` no longer renders the notes');
  if (/report\.notes[\s\S]{0,80}\.filter\(/.test(body)) {
    out.push('`Notes and warnings` filters the array — a note can now be hidden by a collapsed panel');
  }
  return out;
}

test('§3.1–3.3 — `Notes and warnings` stays the complete record, and the specialist copies stay too', () => {
  const app = src('App.tsx');
  assert.deepEqual(notesPanelProblems(app), []);

  /* The three surfaces the spoilboard PENDING sentence reaches, each asserted
   * where it is, so a later pass has to argue with a named test rather than
   * with an absence. The Simulation/Notes pair is DOCUMENTED in the code —
   * *"It also appears in Notes; both exist because either alone can be missed —
   * the flag by a human, the note by a gate"* — and the audit misattributed
   * that comment to the Spoilboard/Simulation pair. Read at the code.
   *
   * ⚠ The Simulation copy moved with the panel to `panels/SimulationPanel.tsx`
   * (`9a435b20a7`) — and the extraction DROPPED the documenting comment, which
   * is exactly the silent-drift failure this assertion exists to catch. The
   * comment was restored with the move rather than the assertion deleted. */
  assert.match(app, /data-testid="spoilboard-pending"/);
  const simPanel = src('panels/SimulationPanel.tsx');
  assert.match(simPanel, /data-testid="sim-spoil-pending"/);
  assert.match(simPanel, /It also appears in Notes; both\s*\n?\s*\*?\s*exist because either alone can be missed/);
});

test('🔴 PLANT §3.1 — a note filtered out of every panel, and so shown nowhere, goes RED', () => {
  const clean = src('App.tsx');
  assert.deepEqual(notesPanelProblems(clean), [], 'precondition: the panel is clean');

  /* The audit's own proposal, applied. Nothing is written to the tree — the
   * plant is a string. */
  const planted = clean.replace(
    '{report.notes.map((n, i) => (',
    "{report.notes.filter((n) => !n.startsWith('SPOILBOARD')).map((n, i) => ("
  );
  assert.notEqual(planted, clean, 'the plant did not apply');
  assert.ok(
    notesPanelProblems(planted).some((p) => /filters the array/.test(p)),
    'a filtered notes list was not caught'
  );

  // And the other direction: the panel stops rendering them at all.
  const emptied = clean.replace('{report.notes.map((n, i) => (', '{[].map((n: string, i: number) => (');
  assert.ok(notesPanelProblems(emptied).some((p) => /no longer renders/.test(p)));
});

/* ═══════════════════════════════════════════════════════════════════════════
   §10.2 — EIGHT LIVE OPERATOR STRINGS THAT CARRIED A RETIRED TERM
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Four files, pinned string by string.
 *
 * ⚠ **THIS BLOCK'S REASON CHANGED ON 2026-08-27 AND IS CORRECTED HERE RATHER
 * THAN LEFT TO ROT.** It read *"the four files `tests/terminology.test.ts`
 * explicitly does NOT cover — it says so in its own §5"*. That is no longer
 * true: `terminology.test.ts` now DISCOVERS its scope from `web/src` and sweeps
 * all four. A stale reason reads as an open gap and keeps a finished job open,
 * and the next reader would have gone looking for a §5 that says the opposite.
 *
 * These assertions still earn their place, and for two reasons neither of which
 * is the one they were written with. ① `terminology.test.ts` needles only
 * `sheet` and `bed`, and **six of the nine rows below are `table`** — the term
 * measured at 37.5% precision and deliberately left unmechanised there;
 * deleting these would drop `table` out of every check in the tree. ② It
 * asserts only that a retired form is ABSENT. These rows also assert the
 * CORRECTED form is PRESENT, which is the half that catches a sentence
 * deleted rather than fixed — a tidiness pass reaching for a reason.
 * (⚠ The §10.2 heading above says EIGHT and the list holds NINE. That
 * mismatch predates this note; the list is the artefact, the heading is prose.)
 *
 * ⚠ PINNED BY THE CORRECTED TEXT, not by a needle scan. `table` was hand-measured
 * at 37.5% precision across this tree and a gate that fires four times per real
 * defect gets switched off; these eight were adjudicated individually, so they
 * are asserted individually.
 */
const CORRECTED: { file: string; gone: string; now: string }[] = [
  { file: 'jobMaterial.ts', gone: 'the sheet "${workpiece!.name}"', now: 'the workpiece "${workpiece!.name}"' },
  { file: 'jobMaterial.ts', gone: 'the sheet "${workpiece.name}" states none', now: 'the workpiece "${workpiece.name}" states none' },
  { file: 'jobMaterial.ts', gone: 'the sheet was typed rather than picked', now: 'the workpiece was typed rather than picked' },
  { file: 'cam.ts', gone: 'drawing(s) are on the table', now: 'drawing(s) are in the job' },
  { file: 'cam.ts', gone: 'drawing(s) on the table (${empty.join', now: 'drawing(s) in the job (${empty.join' },
  /* ⚠ \ re-pinned 2026-09-09: the referent 'this lane' became 'this app' when fleet-internal
     vocabulary was taken out of operator-facing strings. The GUARD is unchanged — the retired
     word 'table' must still be gone and the corrected sentence still present — only the quoted
     text moved with the source. A guard that pins prose punishes improving it. */
  { file: 'materials.ts', gone: 'Longer than any AU table this', now: 'Longer than any AU machine travel this app' },
  { file: 'materials.ts', gone: 'Exceeds most hobby-class table travel', now: 'Exceeds most hobby-class travel' },
  { file: 'samples/index.ts', gone: 'lands outside the table until the datum is moved — ', now: 'lands outside the travel until the datum is moved — ' },
  { file: 'samples/index.ts', gone: 'It also lands outside the table', now: 'It also lands outside the travel' },
];

/** The check itself, over arbitrary source so a plant can be run through it. */
function terminologyProblems(file: string, text: string): string[] {
  const out: string[] = [];
  for (const { file: f, gone, now } of CORRECTED) {
    if (f !== file) continue;
    if (!text.includes(now)) out.push(`${file}: the corrected string is missing — ${now}`);
    if (text.includes(gone)) out.push(`${file}: the retired form is back — ${gone}`);
  }
  return out;
}

const TERM_FILES = [...new Set(CORRECTED.map((c) => c.file))];

test('§10.2 — no retired term is left in the live operator strings of the four unguarded files', () => {
  for (const file of TERM_FILES) assert.deepEqual(terminologyProblems(file, src(file)), []);
});

test('🔴 PLANT §10.2 — a retired term put back into any of the eight goes RED', () => {
  for (const { file, gone, now } of CORRECTED) {
    const clean = src(file);
    assert.deepEqual(terminologyProblems(file, clean), [], `precondition: ${file} is clean`);
    /* The plant is a STRING. Nothing is written to the tree — the four files
     * this covers are live operator surfaces and a half-restored one would ship
     * the defect the check exists to catch. */
    const planted = clean.replace(now, gone);
    assert.notEqual(planted, clean, `${file}: the plant did not apply`);
    const problems = terminologyProblems(file, planted);
    assert.ok(
      problems.some((p) => p.includes(gone)),
      `${file}: a reintroduced retired term was not caught — ${JSON.stringify(problems)}`
    );
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   §10.3 — THE ONE COMMENT THAT WROTE THE COLLAPSE OUT AS A DESIGN RULE
   ═══════════════════════════════════════════════════════════════════════════ */

test('§10.3 — no comment states the three-rectangle collapse as a rule', () => {
  const app = src('App.tsx');
  /* `docs/terminology.md` S1: the workpiece, the spoilboard and the machine are
   * three different rectangles, and a sentence naming two of them cannot say
   * which one a number is measured from. This comment sat over `Part X`/`Part Y`
   * — the one pair of fields whose whole point is which frame they are in. */
  assert.ok(
    !app.includes('the part is on the sheet and the sheet'),
    'the S1 collapse is back in a comment, where the next reader will take it as design intent'
  );
  assert.match(app, /THREE RECTANGLES, THREE WORDS/);
});

/* ═══════════════════════════════════════════════════════════════════════════
   §1.1, §2.3, §8.1 — THREE CONTRADICTIONS, AND §4.2's UNREACHABLE STRING
   ═══════════════════════════════════════════════════════════════════════════ */

test('§1.1 — the `focusable` reason names the APG condition the Run panel actually meets', () => {
  const app = src('App.tsx');
  assert.ok(
    !app.includes('this panel is text with nothing in it to focus'),
    'the Run panel is described as holding nothing focusable; it draws twelve controls'
  );
  assert.match(app, /FIRST ELEMENT WITH CONTENT IS NOT FOCUSABLE/);
  // The PROP is unchanged — dropping a tab stop moves an operator's hands.
  assert.match(app, /<TabPanel id="run" tab=\{tab\} focusable>/);
  // And `Tabs.tsx`'s note about the call site is no longer a live 🔴.
  assert.ok(!src('Tabs.tsx').includes('NO LONGER MEETS THAT CONDITION'));
});

test('§8.1 — the hidden-layer uniqueness claim is gone; both boxes survive', () => {
  const vp = src('Viewport.tsx');
  /* ⚠ THE NEEDLE IS THE HEADING, NOT THE PHRASE. The corrected comment QUOTES
   * the old claim so the next reader meets the argument rather than the empty
   * space where it was — and a scanner that matched the phrase would match the
   * text discussing it. So: the phrase must not open a comment, and it must
   * appear exactly once, inside the retraction. */
  assert.ok(
    !/\u{1F534} THE ONE HIDDEN LAYER THAT GETS ITS OWN LINE/u.test(vp),
    'a stale uniqueness claim is what makes the next reader delete the second box'
  );
  assert.equal(
    vp.split('THE ONE HIDDEN LAYER THAT GETS ITS OWN LINE').length - 1,
    1,
    'the retired claim appears somewhere other than in its own retraction'
  );
  assert.match(vp, /A HIDDEN LAYER THAT GETS ITS OWN LINE/);
  /* And the fact only the second box carries — there is no bare-reach member of
   * `Layer`, so `hidden-indicator` can never name it. */
  assert.match(vp, /so is the bare reach beside it/);
  assert.match(vp, /clamps-hidden/);
  assert.match(vp, /spoilboard-hidden/);
});

test('§4.2 — the unreachable `why` is empty, the branch and its guard both stand', () => {
  const app = src('App.tsx');
  assert.match(app, /return \{ state: 'none', board: null, why: '' \};/);
  // The guard that made it unreachable is the RIGHT half and stays.
  assert.match(app, /spoilboardDrawn\.state !== 'none'/);
  // The sentence that actually reports the state, and it names the consequence.
  assert.match(app, /No board is declared, so the position check reports UNCHECKED\./);
});

/* ═══════════════════════════════════════════════════════════════════════════
   §6.1, §6.2, §8.2 — REASONS THAT MOVED, AND THE SURFACE THAT KEPT THEM
   ═══════════════════════════════════════════════════════════════════════════ */

test('§6.1 — the Feed cell carries the state and the panel note still carries the reason', () => {
  const app = src('App.tsx');
  assert.match(app, />\s*not shown\s*<\/b>/);
  assert.ok(!app.includes('not shown — the core does not export it'));
  /* 🔴 THE CELL IS ONLY SAFE TO SHORTEN WHILE THE NOTE CANNOT BE COLLAPSED AWAY.
   * It is a bare `<p className="note">` inside `panel-tools`, with the rows. */
  assert.match(app, /The core knows the number and does not export it/);
  assert.match(app, /<p className="note">\s*\n?\s*Every value above is the core's answer/);
});

test('§6.2 — the Ø6 mm substitution keeps the copy that states its SCOPE', () => {
  const app = src('App.tsx');
  // The report column: the substitution WITH the scope caveat.
  assert.match(app, /This refusal is in the browser only/);
  assert.match(app, /the gates still behave the old way/);
  // The Tooling panel: the fact only it can state, and no second Ø6 clause.
  assert.match(app, /The trigger\s*\n?\s*above says <em>choose…<\/em>/);
  assert.ok(!app.includes('came back as a full program cut with a'));
});

test('§8.2 — the walls caption keeps its own fact and drops the pointer at its neighbour', () => {
  const vp = src('Viewport.tsx');
  assert.match(vp, /Square inside corners no cutter\s*\n?\s*can make and no dogbones\./);
  // The claim it pointed at, stated by the layer that owns it, with its cells.
  assert.match(vp, /the stock the machine would\s*\n?\s*leave, not the part\./);
});

/* ═══════════════════════════════════════════════════════════════════════════
   §2.6 — A BADGE COUNTING A LIST THE OPERATOR IS LOOKING AT
   ═══════════════════════════════════════════════════════════════════════════ */

test('§2.6 — the section badge renders only while the body is shut', () => {
  /* `Section` was extracted to `panels/SectionPanel.tsx` by `e076313391`; the
   * rule and the prop's doc block moved with the component. */
  const sectionPanel = src('panels/SectionPanel.tsx');
  assert.match(sectionPanel, /\{!open && badge \? \(/);
  /* The prop's own doc block already claimed this is what it does. Nothing reads
   * the badge back, so this changes no behaviour beyond the header text. */
  assert.match(sectionPanel, /WHAT THE HEADER SAYS WHILE THE BODY IS SHUT/);
});
