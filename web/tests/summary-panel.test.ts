// The Summary panel's spindle row — `web/src/panels/SummaryPanel.tsx`.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 WHAT THIS FILE CANNOT SEE, SAID FIRST
// ═══════════════════════════════════════════════════════════════════════════
//
// **NOTHING HERE RENDERS THE PANEL.** There is no DOM below; the two functions
// under test are pure and are tested as pure functions. That a `<b>` with
// `data-testid="summary-rpm"` reaches the screen carrying this string is asserted
// only as SOURCE TEXT at the bottom of this file, and a source-text assertion
// goes BLIND rather than red when the code it reads is rewritten — so each one
// asserts its needle was FOUND before it asserts anything about it.
//
// **AND NOTHING HERE HAS RUN THE CORE.** The programs below are text. Two are
// verbatim captures of real emitted output (named where they are used); the
// multi-speed one is ASSEMBLED from the post's own tool-change emission order
// (`core/src/post_grblhal.rs`: retract → `M5` → `( TOOL CHANGE -> … )` → `M0`,
// then the caller emits `SpindleOn` so the rpm belongs to the NEW tool). No
// fixture in `target/` commands two speeds, so no capture of one exists to
// paste. If the post's tool-change order changes, this file keeps passing
// against a shape that is no longer emitted — that is what gate `I1` and the
// Rust suite are for, not this.
//
// ⚠ **THE FEED ROW IS NOT COVERED, AND ITS DEFECT IS STILL LIVE.**
// `maxCuttingFeed` walks `report.render` — the PLAN — and omits every drilling
// feed. It is left as it was, on the reason written into its doc comment (the
// cutting/probing classification lives in `core/src/feeds.rs::feed_role_of_line`
// and is not exported to wasm, so a TypeScript version would be the second copy
// the core forbids). Nothing below would go red if that row printed a wrong
// number, and no test is added that would make it look covered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatSpindle, spindleSpeedsFromProgram } from '../src/panels/SummaryPanel';

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = join(HERE, '..', 'src', 'panels', 'SummaryPanel.tsx');

/**
 * Verbatim from `target/probe-gate/xyz-turned.nc` (2026-08-27) — the preamble
 * comments, the modal block, and the tail from the spindle start onward. Real
 * emitted bytes, including the `_` that `sanitize()` leaves where the comment
 * text had parentheses.
 */
const ONE_SPEED = `( 2bee.app )
( post: grblHAL dialect. Cutter comp is NOT used _G41/G42 absent from grblHAL core_; )
( all tool-radius offsets are already applied to these coordinates. )
( tool: End Mill 6mm D6.00mm F2 )
G17 G21 G90 G54 G94 G40
G0 Z5.000
M3 S18000
G4 P2.00
G0 X10.000 Y10.000 Z5.000
G1 X60.000 Z-3.000 F1200.0
M5
G0 Z5.000
M30
`;

// ─────────────────────────────────────────────────────────────────────────────
// THE GREEN PATH FIRST — a clean, real program.
// ─────────────────────────────────────────────────────────────────────────────

test('a real one-tool program reports the one speed it commands', () => {
  const r = spindleSpeedsFromProgram(ONE_SPEED);
  assert.equal(r.hasProgram, true);
  assert.deepEqual(r.values, [18000]);
  // Printed as the program prints it, so the operator can search the file for
  // the string on screen. `18,000` appears nowhere in any emitted program.
  assert.equal(formatSpindle(r), '18000');
});

// ─────────────────────────────────────────────────────────────────────────────
// ABSENCE — and the two different absences, which must not print the same.
// ─────────────────────────────────────────────────────────────────────────────

test('a program with no S word says NOT COMMANDED, not nothing', () => {
  // Real shape: a probe-only run. Every line below is a form the post emits, and
  // not one of them is an S word.
  const noSpindle = `( 2bee.app )
G17 G21 G90 G54 G94 G40
M5
G49
G0 Z5.000
G38.2 Z-30.000 F200.0
G10 L20 P1 Z1.600
M30
`;
  const r = spindleSpeedsFromProgram(noSpindle);
  assert.equal(r.hasProgram, true);
  assert.deepEqual(r.values, []);
  assert.equal(formatSpindle(r), 'not commanded');
});

test('no program at all is a different sentence from no S word', () => {
  // A refused job emits no bytes. "This program commands no spindle speed" would
  // be a claim about a program that does not exist.
  for (const empty of ['', '   ', '\n\n']) {
    const r = spindleSpeedsFromProgram(empty);
    assert.equal(r.hasProgram, false, JSON.stringify(empty));
    assert.equal(formatSpindle(r), 'no program', JSON.stringify(empty));
  }
  // The panel is handed `report.gcode`, typed as a required string — but a
  // locally-constructed placeholder report is a real thing in this app, so the
  // missing case is answered rather than thrown.
  assert.equal(formatSpindle(spindleSpeedsFromProgram(null)), 'no program');
  assert.equal(formatSpindle(spindleSpeedsFromProgram(undefined)), 'no program');
});

// ─────────────────────────────────────────────────────────────────────────────
// SEVERAL SPEEDS — the case the old note-scraper answered with one number.
// ─────────────────────────────────────────────────────────────────────────────

test('a two-tool program names BOTH speeds and never picks one', () => {
  const twoSpeeds = `( 2bee.app )
G17 G21 G90 G54 G94 G40
M3 S18000
G4 P2.00
G1 X60.000 Z-3.000 F1200.0
G0 Z5.000
M5
( TOOL CHANGE -> 3mm Down Cut )
M0
M3 S12000
G4 P2.00
G1 X20.000 Z-2.000 F800.0
M5
M30
`;
  const r = spindleSpeedsFromProgram(twoSpeeds);
  // In the order the program commands them — the first tool's speed first.
  assert.deepEqual(r.values, [18000, 12000]);
  assert.equal(formatSpindle(r), '2 speeds: 18000, 12000');
  // 🔴 The specific lie the old code told: the FIRST match, shown alone, under a
  // label that reads as the job's.
  assert.notEqual(formatSpindle(r), '18000');
});

test('the same speed commanded twice is one speed, not two', () => {
  // The post re-emits M3 after every tool change — deliberately, so the rpm
  // belongs to the new tool rather than being inherited. Two tools that happen
  // to run at the same speed is ONE spindle setting, and "2 speeds: 18000,
  // 18000" would be a defect wearing the fix's clothes.
  const same = `M3 S18000
G1 X10.000 F1000.0
M5
( TOOL CHANGE -> 3mm Down Cut )
M0
M3 S18000
G1 X20.000 F1000.0
M30
`;
  const r = spindleSpeedsFromProgram(same);
  assert.deepEqual(r.values, [18000]);
  assert.equal(formatSpindle(r), '18000');
});

// ─────────────────────────────────────────────────────────────────────────────
// COMMENTS — this post writes `( … )`, and a naive /S(\d+)/ reads them as code.
// ─────────────────────────────────────────────────────────────────────────────

test('an S inside a ( comment ) is not a spindle speed', () => {
  // The program name is operator-supplied text and goes through the preamble
  // comment verbatim. `S1234` here is a part number.
  const commented = `( PART S1234 REV S2 )
( tool: End Mill 6mm D6.00mm F2 )
( set the VFD to S24000 by hand )
G17 G21 G90 G54 G94 G40
M3 S18000
M30
`;
  const r = spindleSpeedsFromProgram(commented);
  assert.deepEqual(r.values, [18000], 'a comment was read as G-code');
});

test('a program whose ONLY S words are in comments commands no speed', () => {
  // The direction that matters: reading the comment would print a confident
  // 24000 for a program that never commands the spindle at all.
  const r = spindleSpeedsFromProgram(`( PART S1234 )
( set the VFD to S24000 by hand )
G17 G21 G90 G54 G94 G40
M30
`);
  assert.deepEqual(r.values, []);
  assert.equal(formatSpindle(r), 'not commanded');
});

test('an inline comment does not hide the code around it', () => {
  // grblHAL accepts a comment mid-line. Stripping it must not take the words on
  // either side with it.
  const r = spindleSpeedsFromProgram('M3 (spin up S9999) S18000\n');
  assert.deepEqual(r.values, [18000]);
});

test('a ; comment runs to end of line', () => {
  // This post does not emit that form; grblHAL accepts it, and this function is
  // handed whatever `report.gcode` holds.
  const r = spindleSpeedsFromProgram('M3 S18000 ; was S24000 before the material cap\n');
  assert.deepEqual(r.values, [18000]);
});

test('an unterminated ( loses the line rather than reading it as code', () => {
  // Deliberate direction: a lost S word shows as the stated "not commanded"; the
  // other direction shows a number that was never commanded.
  const r = spindleSpeedsFromProgram('( TOOL CHANGE -> S9000\nM30\n');
  assert.deepEqual(r.values, []);
  assert.equal(formatSpindle(r), 'not commanded');
});

// ─────────────────────────────────────────────────────────────────────────────
// WORD SHAPES — S is a G-code word, not a letter that appears in text.
// ─────────────────────────────────────────────────────────────────────────────

test('S is matched as a word, and neighbouring words are not', () => {
  // `G38.2` must not contribute a number, `G4 P2.00` must not, and an `S`
  // separated from its number by a space is still an S word.
  const r = spindleSpeedsFromProgram(`G38.2 Z-30.000 F200.0
G4 P2.00
S 15000
G1 X10.000 F1200.0
`);
  assert.deepEqual(r.values, [15000]);
});

test('S0 is reported as commanded zero, never as not commanded', () => {
  // A spindle commanded to stop while cutting moves follow is exactly the defect
  // an operator needs to see. Dropping it would render it as the reassuring
  // "not commanded".
  const r = spindleSpeedsFromProgram('M3 S0\nG1 X10.000 F1000.0\nM30\n');
  assert.deepEqual(r.values, [0]);
  assert.equal(formatSpindle(r), '0');
});

// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT THAT WAS THERE — asserted as behaviour, not as a memory.
// ─────────────────────────────────────────────────────────────────────────────

test('the notes are not a source of spindle speed', () => {
  // Verbatim shapes of the only two rpm-bearing notes the core actually emits —
  // `core/src/job.rs:1353` and `core/src/drill.rs:230`. The old code read these;
  // the program below commands no spindle speed at all, so the honest answer is
  // "not commanded" and any number here came from prose.
  const notes = [
    'outer profile: spindle reduced from 24000 to 12000 rpm — above that, aluminium welds to the flutes',
    '🔴 THIS IS A DRILL RUN AT ROUTER-BIT NUMBERS. 24000rpm comes from the material’s router-cutter ceiling',
  ];
  const gcode = 'G17 G21 G90 G54 G94 G40\nG0 Z5.000\nM30\n';
  const r = spindleSpeedsFromProgram(gcode);
  assert.deepEqual(r.values, []);
  assert.equal(formatSpindle(r), 'not commanded');
  // The notes exist and say numbers; the function does not take them, and that
  // is the point. (Named here so the reader sees WHICH strings were rejected.)
  assert.ok(notes.every((n) => /\d{3,6}\s*rpm/i.test(n)), 'the note shapes stopped carrying an rpm');
});

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE TEXT — needle found first, or the assertion is looking at nothing.
// ─────────────────────────────────────────────────────────────────────────────

test('the panel reads the emitted program and not the notes', () => {
  const src = readFileSync(PANEL, 'utf8');
  // Found first: the call must be there before its absence means anything.
  assert.match(src, /spindleSpeedsFromProgram\(report\.gcode\)/);
  // The body, with the doc comments (which quote the old code on purpose)
  // removed — otherwise this assertion fires on the correction it asked for.
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(body, /report\.notes/, 'the spindle row is scraping prose again');
});

test('the RPM row is unconditional', () => {
  const src = readFileSync(PANEL, 'utf8');
  assert.match(src, /data-testid="summary-rpm"/);
  // An absent row reads as "no spindle setting". The old row rendered under
  // `rpm != null`, so a missed regex and a spindle-less program were the same
  // blank space.
  const row = src.slice(src.indexOf('<span>Corner reliefs</span>'));
  assert.doesNotMatch(row, /\{\s*rpm\s*!=\s*null\s*&&/);
  assert.match(row, /<span>RPM<\/span>\s*\n\s*<b data-testid="summary-rpm">\{formatSpindle\(spindle\)\}<\/b>/);
});

/* ───────────────────────────────────────────────────────────────────────────
 * THE FEED ROW — closed 2026-08-28, and this file's header said it was open.
 *
 * `maxCuttingFeed` walked `report.render` — the PLAN, one step before the bytes
 * — and was short by every DRILLING feed, because a canned cycle renders as
 * `kind: 'drill'` and the filter named only `cut` and `tab`. The repair was
 * REFUSED in the round that found it, on the grounds that reading `F` words
 * back needs the which-F-words-are-cuts rule, which lives in
 * `core/src/feeds.rs` precisely so a host does not become the second copy.
 *
 * That was the right refusal and the wrong conclusion: the answer did not need
 * exporting, it needed COMPUTING IN THE CORE. `Report.cutting_feeds_mm_min` is
 * now filled from the same string `gcode` carries, and this panel displays it.
 * The rule itself is tested where it lives (`core:feeds::tests`, six tests
 * including one driven through the real emitted fixture); what is tested here
 * is only the RENDERING of the three states.
 * ─────────────────────────────────────────────────────────────────────────── */

import { STALE_WASM_FEED, cuttingFeeds, formatFeeds } from '../src/panels/SummaryPanel';

const withGcode = (gcode: string, feeds?: number[]) =>
  ({ gcode, cutting_feeds_mm_min: feeds } as unknown as Parameters<typeof formatFeeds>[0]);

test('a refused job has no program, and that is not the same as commanding no feed', () => {
  assert.equal(formatFeeds(withGcode('', []), []), 'no program');
  assert.equal(formatFeeds(withGcode('   ', []), []), 'no program');
});

test('a program that commands no cutting feed says so rather than vanishing', () => {
  /* The old row rendered under `feed != null`, so "commands no feed" and "the
   * derivation missed it" were the same blank space on screen. */
  assert.equal(formatFeeds(withGcode('G0 X1\nM30\n', []), []), 'not commanded');
});

test('one commanded feed prints as the program prints it', () => {
  assert.equal(formatFeeds(withGcode('G1 X1 F3600\n', [3600]), [3600]), '3600 mm/min');
});

test('several distinct feeds are LISTED, never collapsed to the fastest', () => {
  /* "The fastest number in the file" and "the feed this job cuts at" are
   * different claims, and a single figure cannot tell a reader which it got.
   * `plate` really does command three — measured, not supposed. */
  assert.equal(
    formatFeeds(withGcode('x', [300, 1800, 3600]), [300, 1800, 3600]),
    '3 feeds: 300, 1800, 3600 mm/min'
  );
});

test('🔴 the ABSENT-field mapping is tested WHERE IT LIVES — the last version was not', () => {
  /* ⚠ THE TEST BELOW CONDEMNED THE OLD ONE FOR EXACTLY WHAT IT THEN DID. It
   * says the old version "passed `[]` alongside the `undefined` field, so the
   * `??` it claimed to exercise was never reached" — and then asserted on
   * `formatFeeds(…, null)`, which takes `feeds` as a PARAMETER. The `?? null`
   * lives in `cuttingFeeds`, which was not exported and had no test at all.
   *
   * So: tidy `?? null` back to `?? []` — the natural edit, since the TS type is
   * `number[] | undefined` — and the stale-wasm case renders "not commanded", a
   * false statement about the JOB, for every job at once, with the whole suite
   * green. This test is the one that goes red. */
  assert.equal(cuttingFeeds({ gcode: 'x' } as never), null, 'absent must map to null, not []');
  assert.deepEqual(cuttingFeeds({ gcode: 'x', cutting_feeds_mm_min: [] } as never), []);
  assert.deepEqual(cuttingFeeds({ gcode: 'x', cutting_feeds_mm_min: [3600] } as never), [3600]);
});

test('🔴 an ABSENT field is a fact about the BUILD, not about the job', () => {
  /* ⚠ THIS TEST ASSERTED THE WRONG THING UNTIL 2026-08-28, and its stated reason
   * was fiction. It said the field is optional "because a stored session can
   * hold an older report" — but `report` lives in the Zustand store with no
   * `persist`, so no report is ever stored or restored. The one reachable cause
   * of absence is a **STALE WASM**: the core gained this field, and a browser
   * running the previously committed module returns a report without it. That is
   * the case gate K3 exists for.
   *
   * Rendering it as `not commanded` stated a fact about the JOB when the truth
   * was a fact about the BUILD — and it would have said it for every job at
   * once, which is the shape somebody investigates the planner over.
   *
   * ⚠ The old test also could not fail: it passed `[]` for `feeds` alongside the
   * `undefined` field, so the `??` it claimed to exercise was never reached. */
  assert.equal(formatFeeds(withGcode('G1 X1 F3600\n', undefined), null), STALE_WASM_FEED);
  // …and it outranks the other states: a build you cannot trust is not a job
  // that commands nothing.
  assert.equal(formatFeeds(withGcode('', undefined), null), STALE_WASM_FEED);
});

test('a commanded feed is printed as the program prints it, not rounded', () => {
  /* The spindle row states this rule for itself: the operator searches the
   * G-code for the string on screen. `Math.round` turned F1234.5 into "1235",
   * a string in no file, and could render two feeds 0.2 apart as
   * "2 feeds: 1201, 1201" — a list contradicting its own count. */
  assert.equal(formatFeeds(withGcode('x', [1234.5]), [1234.5]), '1234.5 mm/min');
  assert.equal(
    formatFeeds(withGcode('x', [1200.6, 1200.8]), [1200.6, 1200.8]),
    '2 feeds: 1200.6, 1200.8 mm/min'
  );
});
