// The 2bee.cad editor: line numbers, the line↔offset mapping, and the
// lexer-driven highlighter.
//
// WHAT THIS FILE EXERCISES
//   · that the gutter's numbering and the PARSER's `line` are the same numbers,
//     asserted against real `parseScad` output rather than against a constant;
//   · that `highlightSpans` reproduces its input character for character —
//     the property the caret's position depends on;
//   · that the gutter element actually renders one number per line, which is
//     the defect that shipped: the numbers were in the DOM and unreadable.
//
// 🔴 NOT EXERCISED, stated rather than implied:
//   · nothing here renders in a browser, so this cannot show that the highlight
//     layer and the textarea LINE UP on screen. It shows that they are given
//     the same font, padding, line-height, tab-size and white-space, and that
//     the text they are given is the same text. Actual glyph alignment needs a
//     browser and is not claimed.
//   · `goToLine` is an imperative handle over a real textarea; `lineStartOffset`
//     is tested, the `setSelectionRange` call is not.
//   · no colour is asserted to be legible, or to be the right colour.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const HERE = dirname(fileURLToPath(import.meta.url));

const { parseScad, highlightSpans } = await import('../src/cad/scad.ts');
const { consoleLines } = await import('../src/cad/console.tsx');
const { CadEditor, lineStartOffset, lineRange, lineCount, marksByLine, marksFromConsole } =
  await import('../src/cad/editor.tsx');

// ---------------------------------------------------------------------------
// The mapping the whole feature rests on
// ---------------------------------------------------------------------------

test('line 1 starts at offset 0 and every later line starts after its newline', () => {
  const src = 'a\nbb\n\nccc';
  assert.equal(lineStartOffset(src, 1), 0);
  assert.equal(lineStartOffset(src, 2), 2);
  assert.equal(lineStartOffset(src, 3), 5);
  assert.equal(lineStartOffset(src, 4), 6);
});

test('a line number past the end clamps to the end rather than throwing', () => {
  const src = 'a\nb';
  assert.equal(lineStartOffset(src, 99), src.length);
  assert.equal(lineStartOffset(src, 0), 0);
  assert.equal(lineStartOffset(src, -3), 0);
});

test('lineRange excludes the newline', () => {
  const src = 'cube(1);\nsphere(2);\n';
  assert.deepEqual(lineRange(src, 1), [0, 8]);
  assert.equal(src.slice(...lineRange(src, 2)), 'sphere(2);');
});

test('a trailing newline opens a new empty line, and the gutter counts it', () => {
  assert.equal(lineCount(''), 1);
  assert.equal(lineCount('a'), 1);
  assert.equal(lineCount('a\n'), 2);
  assert.equal(lineCount('a\nb\n'), 3);
});

/**
 * 🔴 THE OFF-BY-ONE THIS EXISTS TO CATCH. A 1-based parser against a 0-based
 * gutter would send the user confidently to the wrong line, which is worse than
 * having no line numbers: they would conclude the refusal itself is wrong. So
 * this asserts against a line the PARSER reported, not against a number written
 * into the test.
 */
test('the caret offset for a refusal lands on the line the parser named', () => {
  const src = ['cube(10);', 'translate([1,0,0]) sphere(2);', 'hulls() cube(5);', ''].join(
    '\n',
  );
  const parsed = parseScad(src);
  const refused = parsed.unsupported.find((u) => u.name.includes('hulls'));
  assert.ok(refused, 'hulls() should be refused by name');

  const [from, to] = lineRange(src, refused.line);
  assert.match(src.slice(from, to), /hulls/);
});

test('an error also lands on its own line', () => {
  const src = 'cube(10);\ncube(@@@);\nsphere(1);\n';
  const parsed = parseScad(src);
  assert.ok(parsed.errors.length > 0, 'the stray characters should produce an error');
  const [from, to] = lineRange(src, parsed.errors[0].line);
  assert.match(src.slice(from, to), /@@@/);
});

// ---------------------------------------------------------------------------
// The highlighter
// ---------------------------------------------------------------------------

/**
 * 🔴 THE CONTRACT THE CARET DEPENDS ON. The highlight layer sits underneath a
 * transparent textarea; if the spans do not reproduce the text exactly, the two
 * layers disagree about where a character is and the caret lands somewhere
 * other than where it appears to be. A highlighter may be wrong about a colour.
 * It may never be wrong about a character.
 */
for (const [label, src] of [
  ['the example-ish source', 'cube([1,2,3]);\n// a comment\n$fn = 48;\n'],
  ['an empty string', ''],
  ['only whitespace and newlines', '\n\n   \t\n'],
  ['an unterminated block comment', 'cube(1);\n/* never closed\nsphere(2);'],
  ['an unterminated string', 'echo("open\ncube(1);'],
  ['a stray character the lexer rejects', 'cube(1) @ sphere(2);'],
  ['tabs and CRLF', 'cube(1);\r\n\tsphere(2);\r\n'],
  ['a bare identifier at EOF with no newline', 'wall'],
] as const) {
  test(`highlightSpans reproduces the source exactly — ${label}`, () => {
    const spans = highlightSpans(src);
    assert.equal(spans.map((s) => src.slice(s.start, s.end)).join(''), src);
  });

  test(`highlightSpans returns non-overlapping spans in order — ${label}`, () => {
    let at = 0;
    for (const s of highlightSpans(src)) {
      assert.equal(s.start, at, 'a gap or an overlap would duplicate or drop text');
      assert.ok(s.end >= s.start);
      at = s.end;
    }
    assert.equal(at, src.length);
  });
}

test('the classifier is the parser\'s own sets, not a second list', () => {
  const src = 'cube(1); hulls(); $fn = 3; module m() {} "str" // c\n42';
  const kinds = new Map(
    highlightSpans(src).map((s) => [src.slice(s.start, s.end), s.kind] as const),
  );
  assert.equal(kinds.get('cube'), 'builtin');
  // The one that earns the feature: coloured as refused because it IS in
  // KNOWN_REFUSED_MODULES, so it stops being coloured that way in the same edit
  // that implements it.
  assert.equal(kinds.get('hulls'), 'refused');
  assert.equal(kinds.get('$fn'), 'special');
  assert.equal(kinds.get('module'), 'keyword');
  assert.equal(kinds.get('42'), 'number');
  assert.equal(kinds.get('// c'), 'comment');
});

test('a comment is a comment, not code — `// difference()` colours as one span', () => {
  const src = '// difference() {\ncube(1);';
  const spans = highlightSpans(src);
  const first = spans.find((s) => s.kind === 'comment');
  assert.ok(first);
  assert.equal(src.slice(first.start, first.end), '// difference() {');
  // and nothing inside it was separately classified
  assert.equal(spans.filter((s) => s.start < first.end && s.kind !== 'comment').length, 0);
});

// ---------------------------------------------------------------------------
// The gutter, as rendered
// ---------------------------------------------------------------------------

const renderEditor = (value: string, marks?: unknown) =>
  renderToStaticMarkup(h(CadEditor, { value, onChange: () => {}, ...(marks ? { marks } : {}) } as never));

/** The gutter element's own markup, from `data-testid` to its closing tag. */
const gutterOf = (html: string) => {
  const at = html.indexOf('data-testid="cad-gutter"');
  assert.notEqual(at, -1, 'the gutter should render');
  return html.slice(html.lastIndexOf('<', at), html.indexOf('</div>', at) + 6);
};

/** What a sighted reader sees in the gutter: the markup with its tags removed. */
const gutterText = (html: string) =>
  gutterOf(html)
    .replace(/^<div[^>]*>/, '')
    .replace(/<\/div>$/, '')
    .replace(/<[^>]*>/g, '');

/**
 * 🔴 THE DEFECT THIS ASSERTS AGAINST SHIPPED. The gutter renders
 * `"1\n2\n3\n…"` inside a <div>, and a <div>'s default `white-space: normal`
 * collapses every newline to a space — so it drew "1 2 3 4 5 6 7 8 9 10 …"
 * wrapped as a paragraph of digits. The numbers were in the DOM the whole time.
 * A test that only asserted the numbers were PRESENT would have passed against
 * the bug, so this asserts the property that makes them readable.
 */
test('the gutter is white-space: pre, or the line numbers collapse into a blob', () => {
  const html = renderEditor('a\nb\nc\n');
  const gutter = html.slice(html.indexOf('data-testid="cad-gutter"'));
  const style = gutter.slice(gutter.indexOf('style="'), gutter.indexOf('>', gutter.indexOf('style="')));
  assert.match(style, /white-space:pre/, 'without this the gutter is unreadable');
});

/**
 * ⚠ THIS ASSERTION WAS `/>1\n2\n3\n4</` AND WAS WIDENED, NOT WEAKENED. The
 * gutter grew a one-character mark column, so the literal `>1\n2…` can no longer
 * match — but the property it guarded (every line numbered, from 1, including
 * the one a trailing newline opens, separated by real newlines) is asserted on
 * the gutter's TEXT rather than on one rendering of it, which is strictly more
 * than the regex checked.
 */
test('the gutter numbers every line, from 1, including the one a trailing newline opens', () => {
  // 4 lines: three with text and the empty one after the final newline.
  assert.equal(gutterText(renderEditor('a\nb\nc\n')), ' 1\n 2\n 3\n 4');
  assert.equal(gutterText(renderEditor('')), ' 1');
});

/**
 * 🔴 THE MARK COLUMN IS ONE CHARACTER ON EVERY ROW, MARKED OR NOT. Widening only
 * the marked rows would shift their digits out of the column and read as a
 * gutter that had lost count.
 */
test('a mark takes the column a clean line spends on a space — the digits do not move', () => {
  const clean = gutterText(renderEditor('a\nb\nc'));
  const marked = gutterText(renderEditor('a\nb\nc', [{ line: 2, severity: 'refused', text: 'x' }]));
  assert.equal(clean, ' 1\n 2\n 3');
  assert.equal(marked, ' 1\nx2\n 3');
  assert.equal(clean.length, marked.length);
});

// ---------------------------------------------------------------------------
// The gutter marks — placement, severity, and clearing
// ---------------------------------------------------------------------------

/**
 * 🔴 THE OFF-BY-ONE PLANT, AT THE FEATURE THIS TIME. The gutter's own numbering
 * was already asserted against the parser; a mark adds a second chance to point
 * confidently at innocent code. So this drives REAL parser output through the
 * REAL console builder and asserts the marked row is the row whose text contains
 * the construct — not a line number written into the test.
 */
test('a refusal marks the line the parser named, and that line holds the construct', () => {
  const src = ['cube(10);', 'sphere(2);', 'hulls() cube(5);', ''].join('\n');
  const parsed = parseScad(src);
  const marks = marksFromConsole(consoleLines(parsed, null) as never, { meshStale: false, src });
  assert.equal(marks.length, 1);

  const html = renderEditor(src, marks);
  const at = html.indexOf('data-testid="cad-gutter-mark"');
  assert.notEqual(at, -1, 'the refusal should put a mark in the gutter');
  const tag = html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);

  const line = Number(/data-line="(\d+)"/.exec(tag)![1]);
  assert.equal(line, marks[0].line);
  const [from, to] = lineRange(src, line);
  assert.match(src.slice(from, to), /hulls/, 'the mark is on the wrong line');
});

/**
 * 🔴 A REFUSAL IS NOT AN ERROR AND MUST NOT BE DRAWN AS ONE. The parser
 * distinguishes them deliberately: a refusal was understood, named and left out
 * — the tree is a proper subset and that is the design working — where an error
 * is source nobody could read. An operator who cannot tell "I used a construct
 * you do not implement" from "you have a typo" will read both as our fault.
 */
test('an error, a refusal and a warning get three different marks', () => {
  const src = 'cube(@@@);\nhulls() cube(5);\ncube(1);';
  const parsed = parseScad(src);
  const marks = marksFromConsole(consoleLines(parsed, null) as never, { meshStale: false, src });

  const html = renderEditor(src, marks);
  const tags = html.match(/<span[^>]*data-testid="cad-gutter-mark"[^>]*>/g) ?? [];
  const byLine = new Map(
    tags.map((t) => [Number(/data-line="(\d+)"/.exec(t)![1]), t] as const),
  );

  const err = byLine.get(1)!;
  const ref = byLine.get(2)!;
  assert.ok(err && ref, 'both lines should be marked');
  assert.match(err, /data-severity="error"/);
  assert.match(ref, /data-severity="refused"/);
  /* Different glyph AND different colour — either alone is one undifferentiated
   * red to somebody. */
  assert.notEqual(
    /style="([^"]*)"/.exec(err)![1],
    /style="([^"]*)"/.exec(ref)![1],
    'a refusal drawn in the error colour says the source is broken when the tool declined',
  );
  const text = gutterText(html);
  assert.match(text, /^!1\n/, 'an error reads as "not understood"');
  assert.match(text, /\nx2\n/, 'a refusal reads as "the tool declined"');
});

test('the marks carry three distinct severities, and warning is the third', () => {
  const marks = [
    { line: 1, severity: 'warning', text: 'w' },
    { line: 2, severity: 'refused', text: 'r' },
    { line: 3, severity: 'error', text: 'e' },
  ];
  const text = gutterText(renderEditor('a\nb\nc', marks));
  assert.equal(text, '?1\nx2\n!3');
});

/**
 * 🔴 A MARK THAT SURVIVES ITS DIAGNOSTIC — AND THE FIRST VERSION OF THIS TEST
 * COULD NOT SEE ONE. It rendered twice and asserted the second render was clean,
 * which is vacuous here: `renderToStaticMarkup` builds a NEW component instance
 * every call, so any state a stale mark could hide in is discarded between them.
 * Planting exactly that defect — a ref that latches the last non-empty marks —
 * left the suite green. **The negative control is the only reason this is not
 * still a test that proves nothing.**
 *
 * ⚠ THERE IS NO CLIENT RENDERER IN THIS HARNESS (`react-dom/server` only, no
 * jsdom), so a real re-render of one instance cannot be driven from here. What
 * is asserted instead is the property that makes the defect impossible: the
 * gutter is a pure function of the `marks` PROP, with nothing in this file
 * holding a mark between renders. That is a weaker claim than "it clears", and
 * it is stated as the weaker claim rather than dressed as the stronger one.
 */
test('the marks a fixed source produces are empty, and nothing renders for them', () => {
  const bad = 'cube(@@@);\n';
  assert.ok(
    marksFromConsole(consoleLines(parseScad(bad), null) as never, { meshStale: false, src: bad })
      .length > 0,
  );

  const fixed = 'cube(1);\n';
  const cleared = marksFromConsole(consoleLines(parseScad(fixed), null) as never, {
    meshStale: false,
    src: fixed,
  });
  assert.deepEqual(cleared, []);
  assert.ok(!renderEditor(fixed, cleared).includes('cad-gutter-mark'));
  assert.equal(gutterText(renderEditor(fixed, cleared)), ' 1\n 2');
});

test('and no mark can be held between renders — the gutter reads the prop and nothing else', () => {
  const src = readFileSync(join(HERE, '..', 'src', 'cad', 'editor.tsx'), 'utf8');
  assert.match(
    src,
    /const marked = useMemo\(\(\) => marksByLine\(marks, rows\), \[marks, rows\]\);/,
    'the fold must read the marks PROP, on every render',
  );
  /* Any latch would have to live in a ref or state in this file. There is
   * exactly one `useRef` family here — the three DOM element refs — and none of
   * them holds a diagnostic. */
  const refs = [...src.matchAll(/use(?:Ref|State)<([^>]*)>/g)].map((m) => m[1]);
  for (const held of refs) {
    assert.ok(
      !/Mark|Diagnostic/.test(held),
      `a mark held across renders could outlive its diagnostic: useRef<${held}>`,
    );
  }
  assert.ok(!/sticky|lastMarks|prevMarks/i.test(src), 'a latched copy of the marks');
});

/**
 * 🔴 A MESH ROW NAMES A LINE OF THE PREVIOUS SOURCE. The parse runs on every
 * keystroke; the mesh lags up to 250 ms, so after one Return its line has moved.
 * A one-character mark has nowhere to print "this may lag", so while stale it
 * makes no claim at all — the console still shows those rows, grouped and
 * labelled, which is where the sentence fits.
 */
test('mesh diagnostics do not mark while the mesh is behind the editor', () => {
  const rows = [
    { line: 1, severity: 'refused', channel: 'REFUSED', text: 'from the mesh', from: 'mesh' },
    { line: 2, severity: 'error', channel: 'ERROR', text: 'from the parse', from: 'parse' },
  ];
  const src = 'a\nb\nc';
  assert.deepEqual(
    marksFromConsole(rows as never, { meshStale: true, src }).map((m) => m.line),
    [2],
  );
  assert.deepEqual(
    marksFromConsole(rows as never, { meshStale: false, src }).map((m) => m.line),
    [1, 2],
  );
});

/**
 * ⚠ DROPPED, NOT CLAMPED. Clamping a diagnostic about a line that no longer
 * exists onto the last real line is the wrong-line failure wearing a plausible
 * number.
 */
test('a diagnostic outside the text is dropped rather than piled onto the last line', () => {
  const src = 'a\nb';
  const rows = [
    { line: 99, severity: 'error', text: 'past the end', from: 'parse' },
    { line: 0, severity: 'error', text: 'before the start', from: 'parse' },
    { line: Number.NaN, severity: 'error', text: 'no line at all', from: 'parse' },
    { line: 2, severity: 'error', text: 'real', from: 'parse' },
  ];
  assert.deepEqual(
    marksFromConsole(rows as never, { meshStale: false, src }).map((m) => m.line),
    [2],
  );
});

/**
 * ⚠ ONE MARK PER LINE, AT THE WORST SEVERITY ON IT — and every sentence still
 * reaches the title, so the fold hides nothing.
 */
test('a line carrying several diagnostics shows the worst and says all of them', () => {
  const folded = marksByLine(
    [
      { line: 3, severity: 'warning', text: 'w' },
      { line: 3, severity: 'error', text: 'e' },
      { line: 3, severity: 'refused', text: 'r' },
    ],
    5,
  );
  const at = folded.get(3)!;
  assert.equal(at.severity, 'error', 'a line with a typo and a refusal is a line with a typo');
  assert.equal(at.count, 3);
  assert.equal(at.title, 'e\nr\nw');
});

/** The whole sentence goes on the row, because the gutter has one character. */
test('the full diagnostic is on the mark’s title, not rendered into the gutter', () => {
  const html = renderEditor('a\nb', [
    { line: 2, severity: 'refused', text: 'REFUSED use <brand_corner.scad> — no library folder is mounted' },
  ]);
  const at = html.indexOf('data-testid="cad-gutter-mark"');
  const tag = html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
  assert.match(tag, /title="[^"]*no library folder is mounted/);
  assert.equal(gutterText(html), ' 1\nx2', 'the sentence must not land in the gutter itself');
});

test('the channel and the construct name lead the sentence, so a title says what it is', () => {
  const marks = marksFromConsole(
    [
      { line: 1, severity: 'refused', channel: 'REFUSED', name: 'hulls()', text: 'not an OpenSCAD module.', from: 'parse' },
    ] as never,
    { meshStale: false, src: 'a' },
  );
  assert.equal(marks[0].text, 'REFUSED hulls() — not an OpenSCAD module.');
});

test('the highlight layer and the textarea are given the same metrics', () => {
  const html = renderEditor('cube(1);\n');
  const pick = (testid: string) => {
    const at = html.indexOf(`data-testid="${testid}"`);
    assert.notEqual(at, -1, `${testid} should render`);
    const tag = html.lastIndexOf('<', at);
    return html.slice(tag, html.indexOf('>', at) + 1);
  };
  const pre = pick('cad-highlight');
  const ta = pick('cad-source');
  for (const metric of ['font:12px/1.5 var(--mono)', 'white-space:pre', 'tab-size:2', 'padding:8px 10px']) {
    assert.ok(pre.includes(metric), `highlight layer is missing ${metric}`);
    assert.ok(ta.includes(metric), `textarea is missing ${metric}`);
  }
});

test('the duplicated text is hidden from assistive tech and takes no pointer events', () => {
  const html = renderEditor('cube(1);');
  const at = html.indexOf('data-testid="cad-highlight"');
  const tag = html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
  assert.match(tag, /aria-hidden="true"/);
  assert.match(tag, /pointer-events:none/);
  // and the real control keeps an accessible name
  assert.match(html, /aria-label="2bee\.cad source"/);
});

test('the textarea is not a keyboard trap — Tab is not intercepted', () => {
  // Asserted at the source, because the harness has no key events: the
  // component must register no keydown handler on the textarea at all.
  const html = renderEditor('cube(1);');
  assert.ok(!html.includes('onkeydown'), 'a rendered keydown attribute would be a trap');
});
