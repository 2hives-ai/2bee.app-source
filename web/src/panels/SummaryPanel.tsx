/**
 * SummaryPanel — the "Summary" section showing job statistics.
 *
 * Extracted from App.tsx to reduce component size.
 * Displays status, tool count, distances, time estimate, etc.
 */

import { Section } from './SectionPanel';
import type { Report } from '../cam';
import { formatLength } from '../units';
import { useCncStore } from '../store/cncStore';

/** Format a distance in the operator's unit, with the unit on it. Millimetres in. */
function L(mm: number, unit: Parameters<typeof formatLength>[1]): string {
  return formatLength(mm, unit);
}

/** Format seconds as a human-readable duration. */
function fmtDuration(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
}

interface SummaryPanelProps {
  report: Report;
  /**
   * A re-plan is in flight, so `report` describes the PREVIOUS inputs.
   *
   * 🔴 THE STATUS MUST NOT SAY `runnable` WHILE THIS IS TRUE (2026-08-29). The
   * word is about the program on screen, and while a re-plan is running the
   * program on screen was computed from settings the operator has already
   * changed. Saying `runnable` there is a status word rendering a non-action as
   * an action: the panel, the G-code view and the download button all describe a
   * job nobody asked for any more, and the operator can save a `.nc` that does
   * not match the numbers beside it.
   *
   * ⚠ This was always possible and was too FAST to see. The core ran on the main
   * thread, so a plan completed inside one microtask and the stale window was
   * invisible. Moving the core into a worker (TODO #144) turned that window into
   * milliseconds, and two `MOVE`-class e2e tests started failing with
   * *"the datum did not reach the program"* — they were reading the previous
   * program while `status` still read `runnable`. The tests were right and the
   * panel was wrong: **a wait for a condition that is already true is not a
   * wait**, and it had been vacuous for as long as it existed.
   */
  busy?: boolean;
}

/**
 * The largest feed on a cutting or tab move IN THE PLAN.
 *
 * 🔴 **THIS READS THE PLAN, NOT THE EMITTED PROGRAM, AND THAT IS THE DEFECT
 * THIS LANE HAS BEEN BITTEN BY FOUR TIMES** (`ENT`, `P4`, `P3`, the `JobSummary`
 * walked off `path.moves`). `report.render` is built in `core/src/fixtures.rs`
 * from the same `path.moves` the post then walks, so it is the step BEFORE the
 * bytes — and the post does arithmetic of its own between the two.
 * ⚠ The doc comment here said *"Derive the max commanded feed rate (mm/min) from
 * cutting render moves"*; "commanded" is what the emitted `F` words say, and
 * these are not those.
 *
 * 🔴 **IT IS ALSO SHORT BY EVERY DRILLING FEED.** `MoveKind::DrillCycle` renders
 * as `kind: 'drill'` (`fixtures.rs`, `RenderMove::at("drill", …).fed(m.feed)`)
 * and is not in the filter below, so a program whose fastest commanded feed is a
 * canned cycle's — `core/src/drill.rs`'s own worked example is
 * `G98 G83 … F5760.0` — reports a *lower* number under a label that reads as the
 * job's maximum, or no row at all on a drill-only job.
 *
 * ⚠ **NOT FIXED HERE, DELIBERATELY, AND THIS IS THE REASON RATHER THAN AN
 * EXCUSE.** Reading the `F` words back out of `report.gcode` requires deciding
 * which `F` words are cutting feeds, and the rule *"a `G38.2` is not a cut"*
 * lives in `core/src/feeds.rs::feed_role_of_line`, whose own header says it is in
 * the core precisely so a host does not become the second copy. That function is
 * not exported by `wasm/src/lib.rs`, so this panel cannot ask it, and a
 * TypeScript re-derivation would be the duplicate the core forbids — a probe
 * seek (`F200.0`) displayed as the cutting feed on a job whose finishing pass is
 * slower than the seek. The spindle row below moved to the emitted program
 * because an `S` word needs no such classification; this row cannot follow until
 * the core exports one. Until then the number is the plan's, and the gap is
 * written down rather than papered over.
 */
/**
 * The distinct CUTTING feeds the emitted program commands, mm/min.
 *
 * 🔴 THE CORE ANSWERS THIS, AND THAT IS THE POINT. What stood here until
 * 2026-08-28 walked `report.render` — the PLAN, one step before the bytes —
 * which is the "walked off `path.moves`" defect this lane has been bitten by
 * five times. It was also short by every DRILLING feed: a canned cycle renders
 * as `kind: 'drill'` and the filter named only `cut` and `tab`, so a job whose
 * fastest commanded feed was a peck cycle's under-reported, and a drill-only
 * job showed no row at all.
 *
 * ⚠ AND THE OBVIOUS REPAIR WAS REFUSED. Reading the `F` words back here needs
 * the rule for WHICH `F` words are cuts — a `G38.2` probe seek is not one — and
 * that rule lives in `core/src/feeds.rs::feed_role_of_line`, whose own header
 * says it is in the core *precisely so a host does not become the second copy*.
 * A TypeScript re-derivation would have shown `F200.0` as the cutting feed of a
 * job whose finishing pass is slower. So the core computes the whole answer and
 * this file displays it.
 */
export function cuttingFeeds(report: Report): number[] | null {
  /* 🔴 `null` IS A FOURTH STATE AND IT IS NOT "no feeds". The field is optional
   * on the TS type, and the stated reason — "an older stored report" — does not
   * exist: `report` lives in the Zustand store with no `persist`, so no report
   * is ever stored or restored. The one reachable cause of absence is a **STALE
   * WASM** — the core gained this field, and a browser running the previously
   * committed module returns a report without it. That is exactly the case gate
   * K3 exists for, and rendering it as `not commanded` would state a fact about
   * the JOB when the truth is a fact about the BUILD. */
  return report.cutting_feeds_mm_min ?? null;
}


/**
 * What the spindle row reads: the distinct `S` values in the emitted program,
 * and whether there was a program to read at all.
 *
 * Two facts and not one, because "this program commands no spindle speed" and
 * "there is no program" are different sentences and only the first is about the
 * spindle. A single nullable number could not tell them apart.
 */
export interface SpindleReading {
  /** `false` when `report.gcode` is empty — a refused job emits no bytes. */
  hasProgram: boolean;
  /** Distinct `S` values, in the order the program commands them. */
  values: number[];
}

/**
 * Every distinct spindle speed THE EMITTED PROGRAM COMMANDS, read from the bytes
 * a sender will stream.
 *
 * 🔴 **The standing rule of this lane: assert on the emitted program, never on
 * the setting that was supposed to produce it.** What stood here until
 * 2026-08-27 reconstructed the operator-facing RPM by regex over PROSE:
 *
 *     /** Try to extract the planner-settled RPM from the report notes.
 *      *  The core emits notes like "Spindle capped at 12000 rpm" or similar.
 *      *  Returns null when no RPM is found in the notes. *\/
 *     function rpmFromNotes(report: Report): number | null {
 *       for (const n of report.notes) {
 *         const m = n.match(/(\d{3,6})\s*rpm/i);
 *         if (m) return Number(m[1]);
 *       }
 *       return null;
 *     }
 *
 * The doc comment was the first defect: **no such note has ever existed.**
 * `grep -rn "capped" core/src/*.rs` finds `uncapped_feed_mm_min` and prose, and
 * no note. The rpm-bearing notes that DO exist are `core/src/job.rs:1353`
 * — *"{op}: spindle reduced from {A} to {B} rpm — above that, {material} welds
 * to the flutes"* — and `core/src/drill.rs:230`'s `unvouched_speed_note`, whose
 * figure the note itself says is not a drilling figure. So the row displayed
 * whichever sentence happened to be worded with an rpm in it.
 *
 * The rest of what that cost:
 *
 *   · **First match wins, across every note and every operation.** rpm belongs
 *     to the operation (`job.rs`: *"rpm belongs to the operation, so the spindle
 *     starts after the change"*), so a job with a tool change commands several.
 *     One of them was shown under a label that reads as the job's.
 *   · **A wording change deletes the row.** It rendered under `rpm != null`, so
 *     "the regex matched nothing" and "this program commands no spindle speed"
 *     looked identical on screen — an absence rendered as reassurance.
 *   · **The `S` word was sitting in `report.gcode` the whole time, unread.**
 *
 * ⚠ **ONE AUDIT CLAIM ABOUT THE OLD CODE IS WRONG, AND IS RECORDED RATHER THAN
 * REPEATED.** The audit that found this said the "reduced from A to B rpm" note
 * would display **A**, the value the core REJECTED. It would not: `\s*` matches
 * whitespace only, so in `24000 to 12000 rpm` the only match is `12000` — the
 * commanded one. The defect is real; that particular consequence is not, and a
 * fix justified by a consequence nobody checked is the next wrong comment.
 *
 * ⚠ **WHAT THIS STILL DOES NOT KNOW.** It reads `S` words, not intent: an `S` on
 * a machine with no spindle PWM is a word the controller accepts and cannot act
 * on (`post_grblhal.rs` warns about exactly that, and the warning is in
 * `report.warnings`, not here). And an `S0` is reported as commanded zero rather
 * than dropped — dropping it would render a spindle commanded to stop as "not
 * commanded", which is the one direction that hides a defect.
 */
export function spindleSpeedsFromProgram(gcode: string | null | undefined): SpindleReading {
  const text = typeof gcode === 'string' ? gcode : '';
  if (text.trim() === '') return { hasProgram: false, values: [] };

  const values: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const v of spindleWordsOnLine(line)) {
      if (!values.includes(v)) values.push(v);
    }
  }
  return { hasProgram: true, values };
}

/**
 * The `S` values on one line, with comments removed first.
 *
 * 🔴 **THE COMMENT STRIP IS THE POINT.** This post writes `( … )` comments —
 * `post_grblhal.rs`'s `comment!` macro, and the preamble alone emits the program
 * name and the tool line through it — so a naive `/S(\d+)/` over the file reads
 * a program named `( PART S1234 )` as a spindle speed. `sanitize()` maps `(` and
 * `)` inside comment TEXT to `_`, so our own output never nests; the depth count
 * below is for programs this app did not write.
 *
 * An unterminated `(` swallows the rest of the line. That is deliberate: it
 * loses an `S` word rather than reading a comment as code, and a lost `S` shows
 * as the stated "not commanded" rather than as a wrong number.
 *
 * `;` to end-of-line is stripped too. This post does not emit that form, but
 * grblHAL accepts it, and this function is fed whatever `report.gcode` holds.
 */
function spindleWordsOnLine(line: string): number[] {
  let code = '';
  let depth = 0;
  for (const ch of line) {
    if (ch === '(') {
      depth += 1;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth > 0) continue;
    if (ch === ';') break;
    code += ch;
  }

  const out: number[] = [];
  // A G-code word is a letter followed by a number, and whitespace between the
  // two is legal (`S 18000`). Matching the letter as its own group is what keeps
  // `G38.2` from being read as an `S`-less number floating on the line.
  const WORD = /([A-Za-z])[ \t]*([+-]?(?:\d+\.?\d*|\.\d+))/g;
  let m: RegExpExecArray | null;
  while ((m = WORD.exec(code)) !== null) {
    if (m[1] !== 'S' && m[1] !== 's') continue;
    const v = Number(m[2]);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

/**
 * The spindle row's text. Never empty — the row is always rendered, because an
 * absent row reads as "no spindle setting" and that is a claim nobody made.
 *
 * A job that commands several speeds says so and names them all. One number for
 * a multi-speed program is a lie, and it is the lie the old note-scraper told.
 *
 * Numbers are printed as the program prints them — no thousands separator, so
 * the operator can search the G-code for the string on screen. (`toLocaleString`
 * stood here; it rendered `18,000`, which appears nowhere in the file.)
 */
export function formatSpindle(reading: SpindleReading): string {
  if (!reading.hasProgram) return 'no program';
  if (reading.values.length === 0) return 'not commanded';
  const shown = reading.values.map((v) => String(v));
  if (shown.length === 1) return shown[0];
  return `${shown.length} speeds: ${shown.join(', ')}`;
}

/**
 * The Feed row's text.
 *
 * Three states and not two, matching the spindle row's: no program at all (a
 * refused job emits no bytes), a program that commands no cutting feed, and one
 * or more commanded feeds. A LIST rather than a maximum, because "the fastest
 * number in the file" and "the feed this job cuts at" are different claims and
 * one figure cannot say which is being given.
 */
/**
 * What the Feed row says when the report has no `cutting_feeds_mm_min`.
 *
 * 🔴 EXPORTED BECAUSE IT WAS HAND-KEYED IN THREE PLACES — here, and twice in
 * `web/tests/summary-panel.test.ts`, and again in `web/e2e/cad-to-cnc.spec.ts`.
 * Renaming it in this file would have left every one of those tests green while
 * the row on screen said something else: four copies of one string, and the
 * three that check it all comparing against their own copy rather than against
 * this one. Import it.
 */
export const STALE_WASM_FEED = 'unknown — rebuild the wasm';

export function formatFeeds(report: Report, feeds: number[] | null): string {
  if (feeds === null) return STALE_WASM_FEED;
  if (!report.gcode || report.gcode.trim() === '') return 'no program';
  if (feeds.length === 0) return 'not commanded';
  /* 🔴 NOT ROUNDED, for the reason the spindle row beside it already states:
   * printed as the program prints it, so the operator can search the G-code for
   * the string on screen. `Math.round` turned a clamped or typed `F1234.5` into
   * `1235` — a string that appears nowhere in the file — and could render two
   * feeds 0.2 apart as "2 feeds: 1201, 1201", which is a list that contradicts
   * its own count.
   *
   * ⚠ NOT A COMPLETE MATCH, AND SAYING SO: the post writes one decimal
   * (`fmt(m.feed, 1)`), so the file holds `F3600.0` where this shows `3600`. A
   * search for the digits still lands; a search for the exact token does not. */
  const shown = feeds.map((f) => String(f));
  if (shown.length === 1) return `${shown[0]} mm/min`;
  return `${shown.length} feeds: ${shown.join(', ')} mm/min`;
}

export function SummaryPanel({ report, busy = false }: SummaryPanelProps) {
  const feeds = cuttingFeeds(report);
  const spindle = spindleSpeedsFromProgram(report.gcode);
  const unit = useCncStore((s) => s.unit);

  return (
    <Section title="Summary" testid="panel-summary">
      <div className="grid2">
        <span>Status</span>
        <b
          data-testid="status"
          className={busy ? 'warn' : report.ok ? 'ok' : 'bad'}
        >
          {busy ? 'planning…' : report.ok ? 'runnable' : 'refused'}
        </b>
        <span>Tools</span>
        <b>{report.tools_used.length}</b>
        <span>Tool changes</span>
        <b data-testid="tool-changes">{report.tool_changes}</b>
        <span>Cutting</span>
        <b>{L(report.cutting_distance_mm, unit)}</b>
        <span>Rapids</span>
        <b>{L(report.rapid_distance_mm, unit)}</b>
        <span>Est. time</span>
        <b data-testid="est-time">{fmtDuration(report.estimated_seconds)}</b>
        <span>Deepest Z</span>
        <b data-testid="deepest">{L(report.deepest_z_mm, unit)}</b>
        <span>Tabs</span>
        <b data-testid="tab-count">{report.tab_lifts}</b>
        <span>Corner reliefs</span>
        <b data-testid="dogbones">{report.dogbones}</b>
        {/* Always rendered, for the reason the RPM row below is: a conditional
            row made "this program commands no feed" and "the derivation missed
            it" the same blank space, and only one of those is about the job. */}
        <span>Feed</span>
        <b data-testid="summary-feed">{formatFeeds(report, feeds)}</b>
        {/* Always rendered. The old row appeared only when a regex matched a
            note, so a job that commands no spindle speed and a job whose note
            wording had moved were the same blank space. */}
        <span>RPM</span>
        <b data-testid="summary-rpm">{formatSpindle(spindle)}</b>
      </div>
    </Section>
  );
}
