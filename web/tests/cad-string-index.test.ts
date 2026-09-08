// INDEXING A STRING RETURNED `undef`, SILENTLY — AND IT INVERTED A PREDICATE.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS FILE EXISTS FOR
// ═══════════════════════════════════════════════════════════════════════════
//
// `scad.ts`'s index case read `if (Array.isArray(base) && …) return base[idx];
// return undefined;`. A STRING base fell straight through, so `"abc"[0]` was
// `undef` — with **no error and no `unsupported` entry**. Nothing was named, so
// nothing could be looked up.
//
// 🔴 WHAT IT COST, IN `cad`'S OWN TREE, MEASURED 2026-09-02.
// `2bee_sensor_pod_v3/sensor_pod_v3_enclosure_params.scad` implements substring
// search in the language:
//
//     function _enc_sub(s, i, n) = [for (k = [i : i + n - 1]) s[k]];
//     function enc_has(hay, needle) = … _enc_sub(hay, i, n) == _enc_sub(needle, 0, n) …
//
// Every character came back `undef`. `undef == undef` is TRUE, so `enc_has`
// answered **true for every string** — a substring predicate that matches
// everything. `enc_junction`'s comprehension filter then passed every row and
// took `m[0]`, binding the SoC junction to the CAMERA connector:
//
//     ENC_soc_edge_in_io_x   ours 30.734   pcb's independent figure 42.220
//
// `cad` had written an `assert()` against pcb's number precisely to catch a
// wrong placement, and it fired — **on our side only**. OpenSCAD renders the
// same file with `Status: NoError`.
//
// ⚠ A MISSING FEATURE THAT RETURNS A PLAUSIBLE VALUE IS WORSE THAN ONE THAT
// REFUSES. This lane's rule is *refuse rather than approximate*; `undef` for an
// unimplemented operation is neither. It surfaced only because a downstream
// assertion happened to exist — and it surfaced only after `str()` was
// implemented, because until then the assert's own message could not be built
// and the whole file was refused one step earlier.
//
// Every expectation below was measured by running `openscad -o out.csg`
// (OpenSCAD version 2026.08.07, on this box) on 2026-09-02.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScad } from '../src/cad/scad.ts';

/** The single `echo`'d value of `src`. */
function echoOf(src: string): string {
  const r = parseScad(src, {});
  assert.deepEqual(r.errors.map((e) => e.message), [], 'must not error');
  return r.console[0]?.message ?? '';
}

const OPENSCAD: [src: string, expected: string][] = [
  ['echo("abc"[0]);', '"a"'],
  ['echo("abc"[2]);', '"c"'],
  // Out of range and negative are `undef` — the language's own answer.
  ['echo("abc"[3]);', 'undef'],
  ['echo("abc"[-1]);', 'undef'],
  ['echo(""[0]);', 'undef'],
  // A fractional index TRUNCATES toward zero, for strings and vectors alike.
  ['echo("abc"[1.5]);', '"b"'],
  ['echo([10,20,30][1.5]);', '20'],
  ['echo([10,20,30][0.9]);', '10'],
  ['echo([10,20,30][-0.5]);', '10'],
  ['echo([10,20,30][3]);', 'undef'],
];

for (const [src, expected] of OPENSCAD) {
  test(`${src.trim()} matches OpenSCAD`, () => {
    assert.equal(echoOf(src), expected);
  });
}

test('a non-finite index: OpenSCAD says undef, we REFUSE one step earlier', () => {
  /*
   * ⚠ ASSERTED AS A DIVERGENCE, not skipped. OpenSCAD evaluates `[10,20,30][1/0]`
   * to `undef` because `1/0` is `inf` and an `inf` index is out of range. We
   * never reach the index: `scad.ts` refuses division by zero outright —
   * *"OpenSCAD evaluates this to inf/nan and carries it into the geometry; this
   * file has no such value"* — a standing ruling that predates this work.
   *
   * So the `!Number.isFinite(idx)` guard in the index case is UNREACHABLE from
   * source today. It stays, because the ruling above is the only thing making
   * it unreachable and rulings move; and this test records that the guard is
   * defence and not coverage, so nobody reads its existence as a tested path.
   */
  const r = parseScad('echo([10,20,30][1/0]);', {});
  assert.ok(
    r.errors.some((e) => /division by zero/.test(e.message)),
    'the divergence is upstream of indexing and must stay visible as an error',
  );
});

test('indexing is by CODE POINT, not UTF-16 unit', () => {
  // `"héllo"[1]` is `"é"`. A UTF-16 index would agree here and disagree on any
  // astral character, so the property is asserted on the mechanism as well.
  assert.equal(echoOf('echo("héllo"[1]);'), '"é"');
  assert.equal(echoOf('echo("a😀b"[1]);'), '"😀"');
  assert.equal(echoOf('echo("a😀b"[2]);'), '"b"');
});

test('a character is a STRING of length 1, as the language says', () => {
  assert.equal(echoOf('echo(is_string("abc"[0]));'), 'true');
  assert.equal(echoOf('echo(len("abc"[0]));'), '1');
});

test('🔴 THE REGRESSION: an in-language substring predicate must not match everything', () => {
  /*
   * This is `cad`'s `enc_has`, reduced. With string indexing returning `undef`
   * it answered `true` for BOTH cases, because `[undef,…] == [undef,…]`. A
   * filter built on it selects the first row of any table it is given, which is
   * how the SoC junction became the camera connector.
   *
   * ⚠ The `MISS` case is the whole test. A predicate that is right when it
   * should say yes and also right-looking when it should say no is untested by
   * the yes case alone.
   */
  const fns = `
function _enc_sub(s, i, n) = [for (k = [i : i + n - 1]) s[k]];
function enc_has(hay, needle) =
    len(hay) >= len(needle) &&
    len([for (i = [0 : len(hay) - len(needle)])
         if (_enc_sub(hay, i, len(needle)) == _enc_sub(needle, 0, len(needle))) 1]) > 0;
`;
  assert.equal(echoOf(`${fns}echo(enc_has("xx Luckfox Pico Zero J1 yy","Luckfox Pico Zero J1"));`), 'true');
  assert.equal(
    echoOf(`${fns}echo(enc_has("FPC-22P 0.5mm bottom-contact","Luckfox Pico Zero J1"));`),
    'false',
    'a substring predicate that matches everything selects the first row of every table',
  );
});
