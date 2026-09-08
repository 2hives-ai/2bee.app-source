/**
 * HOW MANY READERS OF THE G-CODE DIALECT SHIP, AND DO THEY ALL SAY SO.
 *
 * 🔴 THE PATTERN THIS EXISTS TO CATCH, WHICH REVIEW CAUGHT FOUR TIMES IN ONE DAY
 * AND WHICH NOTHING MECHANISED COULD SEE:
 *
 *   • `job::block_words` required a word's value adjacent to its letter, so
 *     `F 5000` became NaN and the PREVIOUS feed silently governed the run-time
 *     estimate.
 *   • `fixture::hd_words` — the HOLD-DOWN reader — had the same defect and
 *     failed worse: it DROPPED the word, so a block it could not read looked
 *     like a block with fewer words and the check answered confidently.
 *   • `RunTab.words` stripped comments with a regex that cannot nest, so a `Z`
 *     in comment prose could be read as a Z word by gate RUN's R3.
 *   • And the fix for the first re-typed the number scan by hand, introducing a
 *     NEW divergence in the same commit whose stated purpose was closing drift.
 *
 * Every one was found by a person reading the code. The census in
 * `core/src/feeds.rs` was written to stop that being necessary and was itself
 * wrong FOUR TIMES, always understated, always because the miss was outside the
 * grep shape the count had been derived from.
 *
 * ⚠ SO THIS TEST DOES NOT COUNT READERS — a count is the thing that kept being
 * wrong. It asserts the WEAKER, CHECKABLE property: every file that parses
 * G-code words in the browser bundle must SAY it is a reader of the dialect and
 * name where the rule lives. A new one that says nothing is a new one nobody
 * will find, and this is the sweep that finds it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 🔴 WHAT THIS SWEEP CANNOT SEE. Read this before quoting its green.
 *
 * The needle is TEXTUAL and matches ONE SHAPE: a **regex literal (or a regex
 * built from a string literal) that puts a letter character class next to a
 * number pattern** — `([A-Z])\s*([-+]?\d*\.?\d+)`, `[a-zA-Z][0-9.]+`,
 * `(?<letter>[A-Z])(?<value>[-+]?[0-9.]+)` and so on. It does NOT care which
 * method consumes it, so `.exec()`, `.matchAll()`, `.match()` and
 * `.replace(re, fn)` are all covered. It is blind to a reader that pulls the
 * letter and the number apart WITHOUT such a literal:
 *
 *   • an index walk with `indexOf` / `slice` and `parseFloat`;
 *   • a letter class assembled at run time from variables rather than written
 *     out in the source.
 *
 * A reader written any of those ways ships UNSEEN by this file. That is a real
 * hole, it is stated here rather than implied, and the assertion message below
 * says the same thing so the person reading the failure is not told the sweep
 * proved more than it did.
 *
 * It also sees `web/src` only. The Rust readers are held together by
 * `feeds::word_value_at` being the one scan and by
 * `core:feeds::tests::a_value_the_controller_would_reject_is_refused_not_truncated`
 * and `core:feeds::tests::both_readers_of_this_dialect_answer_the_shared_case_table_alike`,
 * which runs BOTH this bundle's reader and the core's against
 * `web/tests/word-scan-cases.json`.
 *
 * ⚠ INDEPENDENCE. The needle and the acknowledgement must not be satisfiable by
 * the SAME bytes. `feeds::strip_comments` is an accepted acknowledgement AND
 * used to be a needle (`/strip_?[Cc]omment/`), so a file that merely MENTIONED
 * the rule in prose matched both at once: it padded the sweep's population, held
 * the vacuity guard green, and never had to be a reader at all. The
 * acknowledgement tokens are therefore DELETED from the text before the needle
 * runs — `looksLikeAWordReader()` can never see a declaration. A locally implemented
 * `stripComments()` still matches; a citation of the core's no longer does.
 * ────────────────────────────────────────────────────────────────────────────
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src', import.meta.url).pathname;

/** The one reader this lane knows it ships. If the sweep stops finding it, the
 * needle has gone blind — that is a broken control, not a clean tree. */
const KNOWN_READER = 'RunTab.tsx';

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(e) && !e.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** The acknowledgement a reader must carry. Written once, used two ways: to
 * TEST a file, and to DELETE itself from the text the needle sees. */
const DECLARATION_SRC =
  'reader of (?:this|the) dialect|READER OF THE DIALECT|feeds::strip_comments|feeds::word_value_at';

function declaresItself(text: string): boolean {
  return new RegExp(DECLARATION_SRC).test(text);
}

/**
 * A letter character class written out in the source, then — across nothing but
 * regex punctuation (`)`, `(`, `\s*`, a named-group opener, a quantifier) — a
 * number pattern. That is a G-code word scan, whatever consumes it.
 *
 * The bridge deliberately admits NO whitespace, so prose that happens to name
 * `[A-Z]` and `[0-9]` in one sentence does not match.
 */
const WORD_SCAN =
  /\[(?:A-Za-z|a-zA-Z|A-Z|a-z)\](?:\)|\(|\\s\*|\?<[A-Za-z_$][A-Za-z0-9_$]*>|\+|\*|\?)*(?:\\d|\\d|\[0-9|\[-\+\]|\[\+-\])/;

/**
 * The OTHER shape, and this file was blind to it for exactly as long as it took
 * one to ship.
 *
 * 🔴 ADDED 2026-08-28, AND THE SWEEP ITSELF IS WHAT FOUND THE GAP. `RunTab`'s
 * `words()` was rewritten from a regex literal to a hand-written character walk
 * — a port of `feeds::word_value_at`, made because a global regex is free to
 * SKIP text it cannot match and so dropped words the core NAMES. The rewrite was
 * right and it made the only known reader INVISIBLE here; the vacuity guard
 * below went red on the same run, which is the whole reason that guard names a
 * file instead of counting one.
 *
 * A character walk over a G-code line compares against a letter bound AND a
 * digit bound. Requiring BOTH is what keeps this off ordinary string code.
 */
const LETTER_BOUND = /(?:>=|<=|>|<)\s*'[A-Za-z]'|'[A-Za-z]'\s*(?:>=|<=|>|<)|charCodeAt\([^)]*\)\s*(?:>=|<=|>|<)\s*(?:65|90|97|122)/;
const DIGIT_BOUND = /(?:>=|<=|>|<)\s*'[0-9]'|'[0-9]'\s*(?:>=|<=|>|<)|charCodeAt\([^)]*\)\s*(?:>=|<=|>|<)\s*(?:48|57)/;

function walksCharacterRanges(code: string): boolean {
  return LETTER_BOUND.test(code) && DIGIT_BOUND.test(code);
}

/** A file that pulls letters-and-numbers out of a G-code line. */
function looksLikeAWordReader(text: string): boolean {
  // Blind the needle to the acknowledgement, so no file can satisfy both checks
  // with one string. See the INDEPENDENCE note in the header.
  const code = text.replace(new RegExp(DECLARATION_SRC, 'g'), '');
  return WORD_SCAN.test(code) || walksCharacterRanges(code) || /strip_?[Cc]omment/.test(code);
}

test('🔴 every G-code word reader in the browser bundle says that it is one', () => {
  const offenders: string[] = [];
  const examined: string[] = [];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, 'utf8');
    if (!looksLikeAWordReader(text)) continue;
    const rel = file.slice(SRC.length + 1);
    examined.push(rel);
    if (!declaresItself(text)) offenders.push(rel);
  }
  /* Vacuity, asserted rather than approximated. `examined > 0` was the old
   * guard and a NON-reader could satisfy it — any file mentioning the rule in
   * prose. This names the file that must be found. */
  assert.ok(
    examined.includes(KNOWN_READER),
    `this sweep did not match ${KNOWN_READER} — the known G-code word reader — so the ` +
      'needle has gone blind, not the tree clean. Matched instead: ' +
      (examined.length ? examined.join(', ') : '(nothing)')
  );
  assert.deepEqual(
    offenders,
    [],
    'a file writes a G-code word scan (a letter class next to a number pattern, or a ' +
      "character walk comparing against both a letter bound and a digit bound) without " +
      'saying it is a reader of the dialect, so nobody grepping for the readers will find ' +
      'it — which is how three of them drifted apart. Name the rule it follows ' +
      '(`feeds::word_value_at` / `feeds::strip_comments`) in a comment. ⚠ This sweep only ' +
      'sees readers written as a regex literal over `web/src`: a `split()`/`charCodeAt` ' +
      'character loop, an `indexOf`/`slice` walk, or a class built at run time is INVISIBLE ' +
      'to it, so a green here is not "there are no other readers".'
  );
});
