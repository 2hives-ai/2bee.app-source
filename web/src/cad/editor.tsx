// 2bee.cad — the source editor: a gutter, a highlight layer, and a textarea.
//
// 🔴 WHY THE GUTTER IS NOT COSMETIC. Every refusal and every error this tab
// produces is reported BY NAME WITH ITS LINE — `Unsupported { name, line }`,
// `ScadError { line, message }`, `MeshIssue { line }`. That is the contract the
// whole tab is built on. An editor with no usable line numbers tells the user
// *"minkowski() at line 42, refused, contributed nothing"* and then makes them
// count to 42. The refusal is the product; a refusal nobody can act on is most
// of the way back to no refusal.
//
// 🔴 AND THE NUMBERS HAVE TO BE THE PARSER'S NUMBERS. `tokenize` starts at
// `line = 1` and increments on '\n', so line 1 is the first line and the gutter
// counts from 1. An off-by-one here is worse than no gutter at all: the user
// goes confidently to the wrong line and concludes the tool is lying about the
// refusal. `lineStartOffset` below is the one place that mapping is written and
// it is unit-tested against real parser output.
//
// 🔴 THE HIGHLIGHTER IS DRIVEN BY THE LEXER, NEVER BY A REGEX. `highlightSpans`
// calls the same `tokenize` the parser calls. A second, approximate idea of
// what a token is would agree for a week and then colour something the parser
// reads differently — and the user believes the colour. See the header on
// `SpanSink` in `scad.ts`.
//
// ⚠ ALIGNMENT IS A CORRECTNESS PROPERTY, NOT A LOOK. The highlight layer sits
// UNDERNEATH a transparent textarea. If the two ever disagree about where a
// character sits, the caret lands somewhere other than where it appears to be.
// So: identical font, identical padding, identical line-height, identical
// tab-size, `white-space: pre` on both (no wrapping, so one logical line is
// always exactly one visual row — which is also what keeps the gutter honest),
// and the text itself comes from the SAME string via spans that are asserted to
// reproduce it character for character.
//
// 🔴 AND THE GUTTER NOW CARRIES THE DIAGNOSTICS, WHICH CLOSES THE OTHER HALF OF
// THE SAME LOOP. Founder, 2026-08-11: *"when there is an error like
// `<2bee_hive_brood_panel_wcnc.scad> — no library folder is mounted…` show it in
// the editor as well"*. Every refusal already names its line, and the console
// takes you FROM a diagnostic TO a line. The reverse direction did not exist:
// sitting on line 12 there was nothing to say line 12 was the problem, so the
// operator had to hold the list in their head and count. That is the same gap
// the line numbers closed one level up.
//
// 🔴 THREE MARKS, NOT ONE RED. This parser distinguishes an ERROR (not
// understood — a syntax or evaluation failure) from a REFUSAL (understood,
// named, contributing nothing — the tree is a proper subset and that is the
// design working) from a WARNING (implemented, behaves as OpenSCAD behaves, and
// OpenSCAD prints `WARNING:` about it). An operator who cannot tell *"I used a
// construct you do not implement"* from *"you have a typo"* will read both as
// the tool's fault. So the glyph answers **whose the problem is**:
//
//   `!`  error    — the source is not understood.       var(--bad)
//   `x`  refused  — the tool DECLINED this construct.   a quieter red
//   `?`  warning  — it worked, not necessarily as you expect. var(--warn)
//
// The founder's own example is a refusal, and the sentence names the fix — so
// the mark must say the tool declined, not that the source is broken.
//
// ⚠ THE FULL SENTENCE IS ON HOVER, NOT INLINE. The example is a whole sentence
// with a menu path in it; rendering that per-line would destroy the editor. The
// gutter gets one character, the `title` gets the whole thing, and the console
// keeps it at full length with a button that jumps to the line.
// ⚠ NO SEPARATE UNDERLINE WAS ADDED. `highlightSpans` already draws refused
// constructs with `underline wavy` on exactly their span, and `text-decoration`
// does not move a glyph. A second overlay would risk the one property the caret
// depends on for no new information.
// ⚠ THE GUTTER IS `aria-hidden`, so these marks are NOT the accessible channel —
// the console is, and every row there is a real button. A mark is a locator for
// something already said in full somewhere reachable.
//
// This file adds no CSS to the shared sheet and no dependency to the lockfile,
// per `CadTab.tsx`'s standing rule. Every colour is a brand token or a
// `color-mix()` of one — there is no syntax palette here to drift from the app.

import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react';
import { highlightSpans, type HighlightKind } from './scad';

/** 12px at 1.5 → 18px per row. Written ONCE and used by the gutter, the
 *  highlight layer, the textarea and the scroll-into-view maths, because four
 *  copies of a line height is four chances to misalign. */
const FONT_PX = 12;
const LINE_RATIO = 1.5;
const ROW_PX = FONT_PX * LINE_RATIO;
const PAD_Y = 8;
const PAD_X = 10;
/** Both layers must agree, or a tab moves the caret away from its glyph. */
const TAB_SIZE = 2;

/**
 * Character offset of the first character of 1-based `line`.
 *
 * Clamped rather than throwing: a diagnostic can name a line past the end of
 * the text after an edit, and putting the caret at the end of the document is a
 * better answer than an exception in a click handler. Returns 0 for anything
 * at or below line 1, which is the same clamp in the other direction.
 */
export function lineStartOffset(src: string, line: number): number {
  if (!Number.isFinite(line) || line <= 1) return 0;
  let at = 0;
  for (let n = 1; n < line; n++) {
    const nl = src.indexOf('\n', at);
    if (nl === -1) return src.length;
    at = nl + 1;
  }
  return at;
}

/** `[start, end)` of 1-based `line`, excluding its newline. */
export function lineRange(src: string, line: number): [number, number] {
  const start = lineStartOffset(src, line);
  const nl = src.indexOf('\n', start);
  return [start, nl === -1 ? src.length : nl];
}

/** How many lines the gutter must number. A trailing newline opens a new,
 *  empty line in a textarea, and `split` counts it — which is what we want. */
export function lineCount(src: string): number {
  let n = 1;
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') n++;
  return n;
}

/**
 * Colour per token class. All from brand tokens or a `color-mix()` of them —
 * this app deliberately keeps no palette of its own, and a syntax theme copied
 * out of another editor would be exactly the second copy of a value the rest of
 * the file avoids.
 *
 * 🔴 `refused` IS THE ONE THAT DOES WORK. It is the app's own error colour, on
 * exactly the constructs the diagnostics list is about to refuse — the same
 * fact, arriving as you type instead of a keystroke later.
 */
const STYLE: Record<HighlightKind, React.CSSProperties> = {
  plain: {},
  ident: {},
  op: { color: 'var(--muted)' },
  comment: { color: 'var(--muted)', fontStyle: 'italic' },
  number: { color: 'color-mix(in srgb, var(--accent) 55%, var(--ink))' },
  string: { color: 'var(--ok)' },
  keyword: { fontWeight: 700 },
  builtin: { color: 'var(--accent)' },
  special: { color: 'var(--accent)', fontWeight: 700 },
  refused: { color: 'var(--bad)', textDecoration: 'underline wavy' },
};

/** Background wash on the bracket the caret sits on and its match. */
const BRACKET_HIGHLIGHT: React.CSSProperties = {
  background: 'color-mix(in srgb, var(--accent) 22%, transparent)',
  borderRadius: 2,
};

/* ══════════════════════════════════════════════════════════════════════════
   THE GUTTER MARKS
   ══════════════════════════════════════════════════════════════════════════ */

/** The parser's own three channels. Never collapsed into one. */
export type MarkSeverity = 'error' | 'refused' | 'warning';

/** One diagnostic, placed on one line. */
export interface EditorMark {
  /** 1-based, and it is the PARSER's number — see {@link marksFromConsole}. */
  line: number;
  severity: MarkSeverity;
  /** The whole sentence. It goes in a `title`, so it may be long. */
  text: string;
}

/** What one gutter row shows once everything on that line is folded together. */
export interface LineMark {
  severity: MarkSeverity;
  /** Every sentence on this line, newline-separated, for the `title`. */
  title: string;
  count: number;
}

/**
 * The shape of a console row this needs. Structural rather than an import of
 * `ConsoleLine`, so the editor does not depend on the console pane to render a
 * mark — they answer to the same producer, not to each other.
 */
export interface DiagnosticRow {
  line: number;
  severity: MarkSeverity;
  channel?: string;
  name?: string;
  text: string;
  /** `parse` rows are of the editor's current text; `mesh` rows may lag it. */
  from: 'parse' | 'mesh';
}

/**
 * Console rows → marks.
 *
 * 🔴 MESH ROWS ARE DROPPED WHILE THE MESH IS STALE, and this is the whole
 * correctness argument. The parse runs on every keystroke, so a parse row's line
 * is a line of the text on screen. The mesh lags by up to 250 ms, so a mesh row
 * names a line of the PREVIOUS source — and after one pressed Return that line
 * has moved. A mark on the wrong line is worse than no mark: it points
 * confidently at innocent code, and the operator concludes the tool is lying.
 * The console can group its mesh rows and say they may lag; a one-character
 * gutter mark has nowhere to put that sentence, so it does not make the claim.
 *
 * ⚠ A ROW OUTSIDE THE TEXT IS DROPPED, not clamped. Clamping would pile a
 * diagnostic about a line that no longer exists onto the last real line, which
 * is the same wrong-line failure wearing a plausible number.
 */
export function marksFromConsole(
  rows: readonly DiagnosticRow[],
  opts: { meshStale: boolean; src: string },
): EditorMark[] {
  const rowCount = lineCount(opts.src);
  const out: EditorMark[] = [];
  for (const r of rows) {
    if (opts.meshStale && r.from === 'mesh') continue;
    if (!Number.isFinite(r.line) || r.line < 1 || r.line > rowCount) continue;
    const head = [r.channel, r.name].filter(Boolean).join(' ');
    out.push({ line: r.line, severity: r.severity, text: head ? `${head} — ${r.text}` : r.text });
  }
  return out;
}

/** Worst-first, so one line carrying two things shows the one that stops work. */
const SEVERITY_RANK: Record<MarkSeverity, number> = { error: 0, refused: 1, warning: 2 };

/**
 * Fold the marks onto their lines.
 *
 * ⚠ ONE MARK PER LINE, AT THE WORST SEVERITY ON IT — the same ordering the
 * console sorts by. A line with a typo and a refusal is a line with a typo:
 * showing the refusal's quieter glyph there would understate it. Every sentence
 * still reaches the `title`, in that order, so nothing is hidden by the fold.
 */
export function marksByLine(marks: readonly EditorMark[], rows: number): Map<number, LineMark> {
  const byLine = new Map<number, EditorMark[]>();
  for (const m of marks) {
    if (m.line < 1 || m.line > rows) continue;
    const at = byLine.get(m.line);
    if (at) at.push(m);
    else byLine.set(m.line, [m]);
  }
  const out = new Map<number, LineMark>();
  for (const [line, list] of byLine) {
    const sorted = [...list].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    out.set(line, {
      severity: sorted[0].severity,
      title: sorted.map((m) => m.text).join('\n'),
      count: sorted.length,
    });
  }
  return out;
}

/** See the header: the glyph answers whose problem this is. */
const MARK_GLYPH: Record<MarkSeverity, string> = { error: '!', refused: 'x', warning: '?' };

/**
 * ⚠ A REFUSAL IS DELIBERATELY QUIETER THAN AN ERROR, and it is a different
 * colour rather than the same red with a different letter. A refusal is the
 * design working — the construct was understood, named, and left out — so
 * drawing it in the full error colour would tell the operator their source is
 * broken when the tool is the one that declined.
 */
const MARK_TONE: Record<MarkSeverity, string> = {
  error: 'var(--bad)',
  refused: 'color-mix(in srgb, var(--bad) 55%, var(--muted))',
  warning: 'var(--warn)',
};

export interface CadEditorHandle {
  /** Put the caret at the start of 1-based `line`, focus, and scroll to it. */
  goToLine(line: number): void;
  /** The current text, read from the DOM. For a caller that needs it inside an
   *  event handler without threading state back down. */
  value(): string;
}

export interface CadEditorProps {
  value: string;
  onChange(next: string): void;
  /** Accessible name for the textarea. */
  label?: string;
  testid?: string;
  /**
   * What the parser and the audit have to say about this text, per line.
   *
   * ⚠ THEY MUST BE MARKS OF THIS `value`. The caller owns that — see
   * {@link marksFromConsole}, which is where the staleness cut is made. This
   * component places what it is given and asserts nothing about its freshness.
   */
  marks?: readonly EditorMark[];
}

/**
 * ⚠ TAB IS DELIBERATELY NOT TRAPPED. Capturing Tab to insert an indent is the
 * usual next request and it makes the editor a keyboard trap: a person who
 * reached this textarea by keyboard would have no way out of it. The other
 * panels in this app take focus seriously and so does this one — Tab moves
 * focus, as it does everywhere else. Indentation is typed with spaces.
 */
export const CadEditor = forwardRef<CadEditorHandle, CadEditorProps>(function CadEditor(
  { value, onChange, label = '2bee.cad source', testid = 'cad-source', marks = [] },
  ref,
) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => lineCount(value), [value]);
  const spans = useMemo(() => highlightSpans(value), [value]);
  const marked = useMemo(() => marksByLine(marks, rows), [marks, rows]);

  /** Bracket matching — the caret is on (or just past) a `(` / `)` / `[` / `]` /
   *  `{` / `}`, and the lexer already tokenises every bracket as its own span,
   *  so scanning the spans for the match is a bracket-counting walk. */
  const [caretPos, setCaretPos] = useState<number | null>(null);
  const trackCaret = useCallback(() => {
    const el = ta.current;
    if (!el || el.selectionStart !== el.selectionEnd) { setCaretPos(null); return; }
    setCaretPos(el.selectionStart);
  }, []);
  const bracketPair = useMemo((): readonly [number, number] | null => {
    if (caretPos === null) return null;
    const findSpan = (pos: number): number => {
      for (let i = 0; i < spans.length; i++) {
        if (pos >= spans[i].start && pos < spans[i].end) return i;
      }
      return -1;
    };
    const tryMatch = (idx: number): readonly [number, number] | null => {
      if (idx === -1) return null;
      const s = spans[idx];
      if (s.end - s.start !== 1) return null;
      const ch = value[s.start];
      const OPEN = '([{', CLOSE = ')]}';
      const oi = OPEN.indexOf(ch), ci = CLOSE.indexOf(ch);
      if (oi === -1 && ci === -1) return null;
      const target = oi !== -1 ? CLOSE[oi] : OPEN[ci];
      const dir = oi !== -1 ? 1 : -1;
      let depth = 0;
      for (let i = idx; i >= 0 && i < spans.length; i += dir) {
        if (spans[i].end - spans[i].start !== 1) continue;
        const c = value[spans[i].start];
        if (c === ch) depth++;
        if (c === target) depth--;
        if (depth === 0) return [idx, i] as const;
      }
      return null;
    };
    return tryMatch(findSpan(caretPos)) ?? (caretPos > 0 ? tryMatch(findSpan(caretPos - 1)) : null);
  }, [caretPos, spans, value]);

  /**
   * The gutter's children: one string per unbroken run of unmarked lines, and a
   * `<span>` for each marked one.
   *
   * 🔴 EVERY ROW GETS THE SAME ONE-CHARACTER MARK COLUMN, marked or not. A
   * leading space on the clean rows is what keeps the numbers in one column —
   * widening only the marked rows would move their digits and make the gutter
   * look like it had lost count.
   *
   * ⚠ THE RUNS ARE NOT AN OPTIMISATION FOR ITS OWN SAKE. This renders on every
   * keystroke; a file with no diagnostics produces exactly one text node, which
   * is what it produced before this feature existed.
   * ⚠ AND THE MARK CANNOT OUTLIVE ITS DIAGNOSTIC — it is derived from `marks` on
   * every render and held nowhere, so a cleared diagnostic clears the mark by
   * construction rather than by a reset somebody has to remember to call.
   */
  const gutterRows = useMemo(() => {
    const out: ReactNode[] = [];
    let run: string[] = [];
    const flush = () => {
      if (run.length) {
        out.push(run.join(''));
        run = [];
      }
    };
    for (let n = 1; n <= rows; n++) {
      const nl = n < rows ? '\n' : '';
      const m = marked.get(n);
      if (!m) {
        run.push(` ${n}${nl}`);
        continue;
      }
      flush();
      out.push(
        <span
          key={n}
          data-testid="cad-gutter-mark"
          data-line={n}
          data-severity={m.severity}
          data-count={m.count}
          title={m.title}
          style={{ color: MARK_TONE[m.severity], fontWeight: 700 }}
        >
          {`${MARK_GLYPH[m.severity]}${n}${nl}`}
        </span>,
      );
    }
    flush();
    return out;
  }, [rows, marked]);

  useImperativeHandle(
    ref,
    () => ({
      goToLine(line: number) {
        const el = ta.current;
        if (!el) return;
        const at = lineStartOffset(value, line);
        el.focus();
        el.setSelectionRange(at, at);
        // Put the target line a third of the way down rather than at the very
        // top, so the lines around it — the ones that explain it — are visible
        // too. Clamped at 0 so an early line does not scroll to a negative.
        const want = (line - 1) * ROW_PX - el.clientHeight / 3;
        el.scrollTop = Math.max(0, want);
        sync();
      },
      value: () => ta.current?.value ?? value,
    }),
    [value],
  );

  /** One scroll position, three layers. The textarea is the one the user
   *  actually scrolls; the other two follow it. */
  const sync = () => {
    const el = ta.current;
    if (!el) return;
    if (pre.current) {
      pre.current.scrollTop = el.scrollTop;
      pre.current.scrollLeft = el.scrollLeft;
    }
    if (gutter.current) gutter.current.scrollTop = el.scrollTop;
  };

  /** Shared by the highlight layer and the textarea. Any divergence between
   *  these two objects is a caret that lies, so there is one object. */
  const metrics: React.CSSProperties = {
    margin: 0,
    padding: `${PAD_Y}px ${PAD_X}px`,
    border: 'none',
    font: `${FONT_PX}px/${LINE_RATIO} var(--mono)`,
    letterSpacing: 'normal',
    tabSize: TAB_SIZE,
    whiteSpace: 'pre',
    overflowWrap: 'normal',
    wordBreak: 'normal',
  };

  return (
    <div
      data-testid="cad-editor"
      style={{
        display: 'flex',
        flex: 1,
        minHeight: 0,
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
        background: 'var(--panel)',
      }}
    >
      {/* 🔴 `white-space: pre` IS THE WHOLE FIX ON THIS ELEMENT. It renders a
          string of newline-separated numbers, and a <div> collapses newlines to
          spaces by default — so before this the gutter drew
          "1 2 3 4 5 6 7 8 9 10 11 …" wrapped as a paragraph of digits. The line
          numbers were in the DOM the entire time and were unreadable, which is
          indistinguishable from not having them. */}
      <div
        ref={gutter}
        data-testid="cad-gutter"
        aria-hidden="true"
        style={{
          ...metrics,
          padding: `${PAD_Y}px 6px`,
          overflow: 'hidden',
          textAlign: 'right',
          color: 'var(--muted)',
          background: 'var(--bg)',
          borderRight: '1px solid var(--line)',
          userSelect: 'none',
          flex: '0 0 auto',
          minWidth: 42,
        }}
      >
        {gutterRows}
      </div>

      <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
        {/* The colours. `aria-hidden` because it is a second copy of the text
            the textarea already exposes, and `pointer-events: none` because
            every click belongs to the textarea underneath — a click that landed
            here would move focus nowhere and read as a dead editor. */}
        <pre
          ref={pre}
          data-testid="cad-highlight"
          aria-hidden="true"
          style={{
            ...metrics,
            position: 'absolute',
            inset: 0,
            overflow: 'hidden',
            pointerEvents: 'none',
            color: 'var(--ink)',
            background: 'transparent',
          }}
        >
          {(() => {
            const a = bracketPair?.[0] ?? -1;
            const b = bracketPair?.[1] ?? -1;
            return spans.map((s, i) => (
              <span
                key={i}
                style={i === a || i === b ? { ...STYLE[s.kind], ...BRACKET_HIGHLIGHT } : STYLE[s.kind]}
              >
                {value.slice(s.start, s.end)}
              </span>
            ));
          })()}
          {'\n'}
        </pre>

        <textarea
          ref={ta}
          data-testid={testid}
          aria-label={label}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setCaretPos(e.target.selectionStart);
          }}
          onKeyUp={trackCaret}
          onClick={trackCaret}
          onScroll={sync}
          style={{
            ...metrics,
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            boxSizing: 'border-box',
            resize: 'none',
            outline: 'none',
            overflow: 'auto',
            background: 'transparent',
            // The glyphs come from the layer underneath; this one contributes
            // the caret and the selection rectangle only.
            color: 'transparent',
            caretColor: 'var(--ink)',
          }}
        />
      </div>
    </div>
  );
});

export default CadEditor;
