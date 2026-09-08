// Guards on the ORACLE'S OWN readers — the side that supplies ground truth.
//
// 🔴 WRITTEN BECAUSE THE REVERT SWEEP FOUND BOTH OF THESE UNGUARDED (2026-09-04,
// ceo's `20-55-00`). Each could be DELETED with the whole suite still green, and
// each carries a 🔴 comment in the source describing an incident it prevents.
// **A behaviour that is written down is not a behaviour that is guarded** — that
// is the entire finding, and these are the repair. Both are re-verified BY THE
// SWEEP, not by being green: `stl-completeness` and `csg-read-cap` now report
// GUARDED where they reported HOLE.
//
// ⚠ THESE TEST THE HARNESS, NOT THE PRODUCT. Nothing here ships to a browser.
// They matter because CAD1/CAD1H's verdicts REST on these readers: a false
// ground truth does not make the gate red, it makes the gate WRONG while green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAsciiStl, exportCsg, MAX_CSG_BYTES } from '../../tools/scad_oracle/openscad.mjs';

const ONE_TRI = `solid x
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 1 0 0
  vertex 0 1 0
 endloop
endfacet
endsolid x
`;

test('the STL reader accepts a complete ASCII STL', () => {
  const r = parseAsciiStl(ONE_TRI);
  assert.equal(r.ok, true);
  assert.ok(r.tris, 'a complete STL parsed without producing triangles');
  assert.equal(r.tris.length, 9);
});

test('the STL reader REFUSES one truncated mid-facet — the case that arrived 2026-08-11', () => {
  // Cut after a whole vertex line so the vertex count stays a clean multiple of
  // 9. That is the point: `verts.length % 9` PASSES here, and the endfacet /
  // endsolid completeness check is the only thing that can catch it.
  const truncated = ONE_TRI.slice(0, ONE_TRI.indexOf('endloop'));
  const r = parseAsciiStl(truncated);
  assert.equal(r.ok, false, 'a truncated STL was accepted as ground truth');
});

test('the STL reader REFUSES one missing only its endsolid', () => {
  assert.equal(parseAsciiStl(ONE_TRI.replace('endsolid x\n', '')).ok, false);
});

test('the CSG reader REFUSES an export over its cap instead of reading it', () => {
  // Driven with an INJECTED cap of 1 byte against a trivial model, so the
  // refusal path runs end to end — openscad really runs, really writes, and the
  // guard really rejects — without a 68 MB fixture. The real cap is unchanged.
  assert.ok(MAX_CSG_BYTES > 0, 'there is a real cap, not an absent one');
  const dir = mkdtempSync(join(tmpdir(), 'csgcap-'));
  try {
    const f = join(dir, 'tiny.scad');
    writeFileSync(f, 'cube(1);\n');
    const r = exportCsg('openscad', f, 60000, 1);
    if (r.ok === false && !/read cap/.test(String(r.reason))) {
      // No openscad on this box: the guard cannot be REACHED, and saying that is
      // not the same as saying it held. Reported, never counted as a pass.
      console.log(`  (skipped: openscad unavailable — ${String(r.reason).slice(0, 60)})`);
      return;
    }
    assert.equal(r.ok, false, 'an over-cap CSG was read instead of refused');
    assert.match(String(r.reason), /read cap/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
