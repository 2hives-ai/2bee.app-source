/**
 * THE BROWSER'S READER OF THE DIALECT, AND THE TWO PLACES IT DISAGREED.
 *
 * 🔴 `RunTab`'s `words()` feeds `firstProgramZ`, which is gate RUN's R3 — the
 * check about the first Z a program commands. It stripped comments with
 * `replace(/\([^)]*\)/g, ' ')`, which disagrees with `core/src/feeds.rs`'s
 * depth-counted `strip_comments` on two inputs:
 *
 * ⚠ **NOT inputs THIS POST can produce** — the header of this file said so and
 * it was wrong. `post_grblhal::sanitize` maps `(` and `)` to `_` at every
 * comment site, so our own output carries neither form. The guard's real reason
 * is that a SENDER is pointed at files this lane did not emit, and that the two
 * readers of one dialect must not answer differently about them.
 *
 *   `( a ( b ) c )`   the regex removes `( a ( b )` and leaves `c )` AS CODE
 *   `( unterminated`  the regex removes NOTHING; the core drops the line
 *
 * A `Z` left standing in comment text is then read as a Z word. Two readers of
 * one dialect, and the one that shipped to the browser was not the one whose
 * account of nesting was written down.
 *
 * It also rejected a leading `+`, which grbl's own `read_float` accepts — so
 * `G0 Z+5` yielded no Z word and `firstProgramZ` returned null, and R3 refused
 * a program it could have read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { words } from '../src/RunTab';

const zOf = (line: string): number[] =>
  words(line)
    .filter((w: { letter: string; value: number }) => w.letter === 'Z')
    .map((w: { letter: string; value: number }) => w.value);

test('🔴 a Z inside a NESTED comment is not a Z word', () => {
  assert.deepEqual(zOf('( a ( b ) Z9 )'), [], 'comment text was read as code');
  assert.deepEqual(zOf('G0 Z5 ( note ( inner ) more )'), [5]);
});

test('🔴 an unterminated comment swallows the rest of the LINE', () => {
  assert.deepEqual(zOf('G0 ( unterminated Z9'), [], 'an unclosed comment left a Z standing');
  // …and only the line: comments do not span lines in G-code.
  assert.deepEqual(zOf('G0 Z5'), [5]);
});

test('a `;` counts only outside a comment', () => {
  assert.deepEqual(zOf('G0 Z5 ; Z9'), [5]);
  assert.deepEqual(zOf('( a ; b ) G0 Z5'), [5], 'a `;` inside parens truncated the line');
});

test('a signed word is read, including a leading +', () => {
  /* grbl's own read_float accepts `+`. Rejecting it made `G0 Z+5` yield no Z
   * word, so firstProgramZ returned null and R3 refused a readable program. */
  assert.deepEqual(zOf('G0 Z+5'), [5]);
  assert.deepEqual(zOf('G0 Z-2.5'), [-2.5]);
});

/* ------------------------------------------------------------------------- *
 * THE COMPARISON `feeds.rs`'s CENSUS CLAIMED EXISTED.
 *
 * 🔴 For a day, `core/src/feeds.rs` said the browser restated the rule "with a
 * test comparing the two". There was no such test, and a claim of coverage is
 * exactly what stops the next reader from looking. When one was written the two
 * readers disagreed on five inputs — every one a block grblHAL refuses, and the
 * browser's answer was the confident one each time.
 *
 * The table is `web/tests/word-scan-cases.json` and it is read by BOTH readers:
 * the Rust side runs it in `core::feeds::tests`. Adding a case here tests both.
 * ------------------------------------------------------------------------- */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Case = {
  line: string;
  words: [string, number | null][];
  note?: string;
  wasDivergent?: string;
};

const CASES: Case[] = JSON.parse(
  readFileSync(fileURLToPath(new URL('./word-scan-cases.json', import.meta.url)), 'utf8'),
).cases;

test('🔴 the browser reader answers the SHARED case table exactly as the core does', () => {
  // A table that shrank to nothing would pass every assertion below it.
  assert.ok(CASES.length >= 17, `the shared case table lost cases: ${CASES.length}`);
  assert.ok(
    CASES.some((c) => c.wasDivergent),
    'the table no longer holds a single case the two readers once disagreed on, which is the ' +
      'only kind of case that can catch them drifting apart again',
  );

  for (const c of CASES) {
    const got = words(c.line).map((w) => [w.letter, Number.isFinite(w.value) ? w.value : null]);
    assert.deepEqual(
      got,
      c.words,
      `"${c.line}" — the browser reads it differently from the core.` +
        (c.wasDivergent ? ` This case exists because: ${c.wasDivergent}` : ''),
    );
  }
});
