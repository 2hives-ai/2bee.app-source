// 2bee.cad — the console pane.
//
// Modelled on OpenSCAD's own bottom dock (`consoleDock`, dock area 8 = bottom,
// in `src/gui/MainWindow.ui` of OpenSCAD 2026.08.07), which is where its
// `ERROR:`, `WARNING:` and `echo()` output lands.
//
// 🔴 THE REASON THIS PANE EXISTS IS NOT THE RESEMBLANCE. `ScadResult.warnings`
// has been produced, counted into `GroupNode.diagnostics` and asserted by tests
// since 2026-08-11, and rendered by NOTHING. Nine OpenSCAD `WARNING:` classes
// were invisible in this tab — the parser knew, the tests knew, and the user
// could not be told. `scad.ts` says so in its own header rather than implying
// it. This pane is the channel that was missing; the layout it happens to match
// is a bonus.
//
// 🔴 TWO SOURCES, AND THE PANE SAYS WHICH. The parse diagnostics are of the
// text in the editor RIGHT NOW (the parse runs on every keystroke). The mesh
// diagnostics are of the text the mesh was built from, which lags by up to
// 250 ms. Printing them in one undifferentiated list would let a mesh refusal
// about the previous source sit under a line number that has since moved. So
// the mesh rows are grouped, and while the two disagree the group says so.
//
// Every row is a BUTTON, not a styled div: a diagnostic that names a line
// should take you to that line, and it should do it for a keyboard too.

import { useMemo, useState } from 'react';
import type { ScadResult } from './scad';
import type { MeshResult } from './mesh';

export type ConsoleSeverity = 'error' | 'refused' | 'warning' | 'info';

export interface ConsoleLine {
  /** 1-based source line, as the producer reported it. */
  line: number;
  severity: ConsoleSeverity;
  /** OpenSCAD-style channel word, so the pane reads like the tool it mirrors. */
  channel: 'ERROR' | 'WARNING' | 'REFUSED' | 'ECHO';
  /** The construct by name where there is one — `minkowski()`, `$fa`. */
  name?: string;
  text: string;
  /** `parse` rows are of the editor's current text; `mesh` rows may lag it. */
  from: 'parse' | 'mesh';
}

/**
 * Everything the tab knows that is worth saying, in one ordered list.
 *
 * Pure and exported so it can be tested without a DOM — the rendering below is
 * a `map` over this and nothing else, so a test of this function is a test of
 * what the pane says.
 *
 * ⚠ ORDER IS BY SEVERITY THEN LINE, NOT BY LINE ALONE. An error discarded a
 * span of the source, so everything after it is a report about a tree that is
 * already missing something; burying it between two warnings at lines 3 and 9
 * is how it gets read last.
 */
export function consoleLines(parse: ScadResult, mesh: MeshResult | null): ConsoleLine[] {
  const out: ConsoleLine[] = [];

  for (const e of parse.errors) {
    out.push({ line: e.line, severity: 'error', channel: 'ERROR', text: e.message, from: 'parse' });
  }
  for (const u of parse.unsupported) {
    out.push({
      line: u.line,
      severity: 'refused',
      channel: 'REFUSED',
      name: u.name,
      text: u.detail,
      from: 'parse',
    });
  }
  /* 🔴 THE LIST THAT WAS RENDERED BY NOTHING. `parse.warnings` is a construct
   * that IS implemented and behaves exactly as OpenSCAD behaves, about which
   * OpenSCAD itself prints `WARNING:`. Not an error and not a refusal — the
   * third thing, and until this pane it had no home in the UI. */
  for (const w of parse.warnings) {
    out.push({ line: w.line, severity: 'warning', channel: 'WARNING', text: w.message, from: 'parse' });
  }
  for (const e of parse.console) {
    out.push({ line: e.line, severity: 'info', channel: 'ECHO', text: e.message, from: 'parse' });
  }

  if (mesh) {
    for (const i of mesh.issues) {
      out.push({
        line: i.line,
        severity: i.severity === 'refused' ? 'refused' : 'warning',
        channel: i.severity === 'refused' ? 'REFUSED' : 'WARNING',
        name: i.name,
        text: i.detail,
        from: 'mesh',
      });
    }
  }

  const rank: Record<ConsoleSeverity, number> = { error: 0, refused: 1, warning: 2, info: 3 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.line - b.line);
}

export interface ConsoleCounts {
  error: number;
  refused: number;
  warning: number;
  info: number;
}

/** The split by class, over the rows the pane will render and nothing else. */
export function consoleCounts(lines: ConsoleLine[]): ConsoleCounts {
  return {
    error: lines.filter((l) => l.severity === 'error').length,
    refused: lines.filter((l) => l.severity === 'refused').length,
    warning: lines.filter((l) => l.severity === 'warning').length,
    info: lines.filter((l) => l.severity === 'info').length,
  };
}

/** The one sentence that says which — shared by the pane's header and the tab's
 *  tooltip, so the two cannot say different things about the same source. */
export function consoleSummary(c: ConsoleCounts): string {
  return (
    `${c.error} error${c.error === 1 ? '' : 's'} · ` +
    `${c.refused} refused · ` +
    `${c.warning} warning${c.warning === 1 ? '' : 's'} · ` +
    `${c.info} echo${c.info === 1 ? '' : 'es'}`
  );
}

/**
 * 🔴 THE NUMBER THE DOCK TAB SHOWS. Exported because it is a decision, not an
 * expression, and a decision that lives inline at a call site gets re-made
 * differently at the next one — which is exactly what happened.
 *
 * 🔴 MEASURED DEFECT, 2026-08-11 (recorded in `453786fe2e`). `CadTab.tsx`
 * totalled `errors + unsupported + warnings` — the PARSE
 * diagnostics — while this pane lists parse AND mesh. Re-measured today by
 * running it, not by reading it: `difference() { cube(10); circle(3); }` gives
 * that sum **0** and one REFUSED row in the pane. With any other pane showing,
 * a construct the operator wrote had contributed NOTHING to the model and the
 * screen said so nowhere. A refusal with no signal is indistinguishable from a
 * clean parse, and the viewport cannot tell them apart either: a tree missing a
 * subtree still renders, and still looks like a model.
 *
 * 🔴 WHAT THE NUMBER PROMISES, stated because a single number cannot say which:
 * **`count` is how many things the console has to say — every row it holds,
 * errors and refusals and warnings, from the parser and from the mesher.** It
 * promises nothing about class. That is deliberate:
 *
 *   · It is the only total that cannot disagree with the pane, because it is
 *     `lines.length` of the very list the pane maps over — one producer, not a
 *     second sum that drifts. The defect above WAS a second sum.
 *   · A refusal is understood, named, and contributing nothing — so it needs
 *     attention under either reading of "what the badge is for", and both
 *     candidate definitions include it. The only class the two readings disagree
 *     about is `warning`, and excluding warnings would restore, one level up,
 *     precisely the invisibility this pane was built to end: nine OpenSCAD
 *     `WARNING:` classes that were produced, counted and rendered by nothing.
 *   · This lane already settled the same question in `record.ts`, which counts
 *     `unsupported` and the mesher's refused `issues` together into one
 *     `complete` verdict. The tab was the one place that disagreed.
 *
 * ⚠ AND THE PANE SAYS THE REST. `worst` lets the tab tone the number without
 * pretending it is a class, and `label` is the pane's own header sentence
 * verbatim — the split by class, for the tab's `title`. An operator who needs to
 * know WHICH gets it from the pane, which is one click away and is where the
 * line numbers are.
 *
 * ✅ WIRED 2026-08-11 — and this line replaces the 🔴 that said it was not,
 * removed in the same change that wired it rather than before. `CadTab.tsx`
 * renders `consoleBadge(jumpTargets).count` on the console tab, from the very
 * list it hands `CadConsole`, so the badge and the pane are one producer.
 *
 * ⚠ THE BADGE RENDERS WHATEVER PANE IS SHOWING, deliberately, and the obvious
 * tidy-up is to suppress it while the console is open. **Do not.** `layout.dock`
 * is clamped to zero in two places and is PERSISTED, so `{ tab: 'console',
 * dock: 0 }` is reachable in one drag — a guard keyed on the tab alone gives that
 * state no pane AND no badge, reinstating the exact no-signal condition this
 * whole thing was built to end. A redundant number while the pane is open is the
 * cheaper of the two failures.
 */
export interface ConsoleBadge {
  /** Rows the pane will render. `0` ⇒ the pane renders its empty note. */
  count: number;
  counts: ConsoleCounts;
  /** The most serious class present, for tone only. `null` when there is none. */
  worst: ConsoleSeverity | null;
  /** {@link consoleSummary} of {@link ConsoleBadge.counts}. */
  label: string;
}

export function consoleBadge(lines: ConsoleLine[]): ConsoleBadge {
  const counts = consoleCounts(lines);
  const worst: ConsoleSeverity | null = counts.error
    ? 'error'
    : counts.refused
      ? 'refused'
      : counts.warning
        ? 'warning'
        : counts.info
          ? 'info'
          : null;
  /* `lines.length`, NOT the sum of the three — the promise is "what the pane
   * holds", and a fourth severity added later must widen the badge whether or
   * not anyone remembers to widen `consoleCounts`. The tests assert the two
   * agree, so that day shows up as a red rather than as a quietly low number. */
  return { count: lines.length, counts, worst, label: consoleSummary(counts) };
}

const TONE: Record<ConsoleSeverity, string> = {
  error: 'var(--bad)',
  refused: 'var(--bad)',
  warning: 'var(--warn)',
  info: 'var(--muted)',
};

export interface CadConsoleProps {
  parse: ScadResult;
  mesh: MeshResult | null;
  /** The mesh is of a previous source, so its line numbers may have moved. */
  meshStale: boolean;
  /** Take the caret to a line. Undefined disables the jump entirely rather than
   *  rendering buttons that do nothing — a dead control is worse than none. */
  onGoToLine?: (line: number) => void;
}

export function CadConsole({ parse, mesh, meshStale, onGoToLine }: CadConsoleProps) {
  const lines = useMemo(() => consoleLines(parse, mesh), [parse, mesh]);
  const counts = useMemo(() => consoleCounts(lines), [lines]);

  /** Severities currently shown in the pane. The badge counts the TOTAL;
   *  the filter only affects what the pane renders, so the operator can
   *  suppress the noisiest class and scan the rest. */
  const [activeSev, setActiveSev] = useState<Set<ConsoleSeverity>>(
    () => new Set<ConsoleSeverity>(['error', 'refused', 'warning', 'info']),
  );
  const filteredLines = useMemo(
    () => lines.filter((l) => activeSev.has(l.severity)),
    [lines, activeSev],
  );

  return (
    <div
      data-testid="cad-console"
      data-errors={counts.error}
      data-refused={counts.refused}
      data-warnings={counts.warning}
      data-echoes={counts.info}
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        height: '100%',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius)',
        background: 'var(--panel)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          padding: '5px 8px',
          borderBottom: '1px solid var(--line)',
        }}
      >
        {/* 🔴 NO `Console` HEADING HERE. The dock tab immediately above this row
            IS the word `Console`, so a heading under it was the panel saying its
            own name twice — the `Machine / Machine` shape the founder named on
            2026-08-11. What stays is the part the tab cannot carry: the counts
            split by CLASS.

            🔴 AND IT IS NOW ONE PRODUCER WITH THE TAB'S BADGE, not two sums
            over two different inputs — see {@link consoleBadge}. This row is
            `consoleSummary(consoleCounts(lines))` and the badge is
            `consoleBadge(lines)` of that same list, so the tab cannot say `0`
            while this row says `1 refused`. ⚠ THE TAB IS NOT WIRED TO IT YET —
            `CadTab.tsx` still hand-rolls the parse-only sum; see the 🔴 on
            {@link consoleBadge}. */}
        <span className="note" data-testid="cad-console-summary" style={{ margin: 0 }}>
          {consoleSummary(counts)}
        </span>
        {(['error', 'refused', 'warning'] as const).map((sev) => {
          const on = activeSev.has(sev);
          return (
            <button
              key={sev}
              type="button"
              data-testid={`cad-console-filter-${sev}`}
              onClick={() =>
                setActiveSev((prev) => {
                  const next = new Set(prev);
                  if (next.has(sev)) next.delete(sev);
                  else next.add(sev);
                  return next;
                })
              }
              style={{
                background: on
                  ? 'transparent'
                  : 'color-mix(in srgb, var(--muted) 15%, transparent)',
                color: on ? TONE[sev] : 'var(--muted)',
                border: `1px solid ${on ? TONE[sev] : 'var(--line)'}`,
                borderRadius: 'var(--radius)',
                padding: '1px 6px',
                fontSize: 11,
                cursor: 'pointer',
                fontWeight: on ? 700 : 400,
                opacity: on ? 1 : 0.5,
              }}
            >
              {counts[sev]} {sev === 'error' ? 'errors' : sev === 'refused' ? 'refused' : 'warnings'}
            </button>
          );
        })}
        {onGoToLine ? (
          <span className="note" style={{ margin: 0, marginLeft: 'auto' }}>
            click a line to go to it
          </span>
        ) : null}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 4 }}>
        {filteredLines.length === 0 ? (
          <p className="note" data-testid="cad-console-empty" style={{ margin: 6 }}>
            {lines.length === 0
              ? 'Nothing to report about this source. That is a statement about the LANGUAGE used — every ' +
                'construct is inside the 2bee.cad subset and the mesher refused nothing. It is not a statement ' +
                'about the geometry being what you meant.'
              : 'All lines hidden by filters. Toggle a severity above to show them.'}
          </p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {filteredLines.map((l, i) => {
              const body = (
                <>
                  <span style={{ color: TONE[l.severity], fontWeight: 700 }}>{l.channel}</span>{' '}
                  <span style={{ color: 'var(--muted)' }}>line {l.line}</span>
                  {l.name ? (
                    <>
                      {' · '}
                      <strong>{l.name}</strong>
                    </>
                  ) : null}
                  {/* 🔴 The mesh rows are of the source the MESH was built from.
                      While that differs from the editor, the line number below
                      is a number in a text the user is no longer looking at. */}
                  {l.from === 'mesh' && meshStale ? (
                    <span style={{ color: 'var(--warn)' }}> · from the PREVIOUS source</span>
                  ) : null}
                  <br />
                  <span style={{ color: 'var(--muted)' }}>{l.text}</span>
                </>
              );
              return (
                <li key={`${l.from}-${l.channel}-${l.line}-${i}`} style={{ marginBottom: 2 }}>
                  {onGoToLine ? (
                    <button
                      type="button"
                      data-testid="cad-console-row"
                      data-line={l.line}
                      onClick={() => onGoToLine(l.line)}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        font: '11.5px/1.45 var(--mono)',
                        padding: '3px 6px',
                        background: 'transparent',
                        color: 'var(--ink)',
                        border: '1px solid transparent',
                        borderRadius: 'var(--radius)',
                        cursor: 'pointer',
                      }}
                    >
                      {body}
                    </button>
                  ) : (
                    <div
                      data-testid="cad-console-row"
                      data-line={l.line}
                      style={{ font: '11.5px/1.45 var(--mono)', padding: '3px 6px' }}
                    >
                      {body}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export default CadConsole;
