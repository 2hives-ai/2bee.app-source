import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyVariant, currentVariant, parseDefines, variantLabel, type Variant } from '../src/shop/variants.ts';
import { scanParams } from '../src/cad/params.ts';

const CAD = join(import.meta.dirname, '..', '..', '..', '..', 'hardware', 'cad');
const HOLDER = readFileSync(join(CAD, '2bee_cnc_table', 'cnc_pcb_holder_3d.scad'), 'utf8');
const FLEET = readFileSync(join(CAD, 'fleet_parts.yaml'), 'utf8');

/** The rows for one scad, read the way the catalogue build reads them. */
function rowsFor(scad: string): Variant[] {
  return FLEET.split('\n')
    .filter((l) => !/^\s*#/.test(l) && l.includes(`scad: ${scad}`))
    .map((l) => ({ part: /name:\s*([A-Za-z0-9_]+)/.exec(l)![1], defines: parseDefines(/defines:\s*\{([^}]*)\}/.exec(l)?.[1] ?? '') ?? {} }));
}

test('parseDefines reads every defines: in the real fleet_parts.yaml (a misread one would build the default)', () => {
  const bodies = [...FLEET.matchAll(/defines:\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(bodies.length >= 40, `expected the ~43 rows, read ${bodies.length}`);
  for (const b of bodies) assert.notEqual(parseDefines(b), null, `unreadable: {${b}}`);
  assert.deepEqual(parseDefines(` board: '"bucks"' `), { board: '"bucks"' });
  assert.deepEqual(parseDefines(` side: '"L"', print_ready: true `), { side: '"L"', print_ready: 'true' });
  assert.equal(parseDefines('board "bucks"'), null);
});

test('the CNC PCB holder: three parts, defaults to "bucks", and "skr_pi" rewrites board = "skr_pi" in the real file', () => {
  const vs = rowsFor('2bee_cnc_table/cnc_pcb_holder_3d.scad');
  assert.deepEqual(vs.map((v) => v.part), ['cnc_pcb_holder_skr_pi', 'cnc_pcb_holder_bucks', 'cnc_pcb_holder_hbs57_usb6']);
  assert.deepEqual(vs.map((v) => variantLabel(v, vs)), ['skr pi', 'bucks', 'hbs57 usb6']);
  // Founder 2026-11-20: "make the app default to bucks variant" — cad set the file's default to bucks.
  assert.equal(currentVariant(HOLDER, vs)?.part, 'cnc_pcb_holder_bucks', 'the file as committed is the bucks holder');
  const skr = vs.find((v) => v.part === 'cnc_pcb_holder_skr_pi')!;
  const r = applyVariant(HOLDER, skr);
  assert.ok(r.ok, r.ok ? '' : r.why);
  if (!r.ok) return;
  assert.equal(scanParams(r.source).params.find((p) => p.name === 'board')?.value, 'skr_pi');
  assert.equal(currentVariant(r.source, vs)?.part, 'cnc_pcb_holder_skr_pi');
  // Only that one value changed: the rest of the file is byte-identical.
  assert.equal(r.source.replace('board      = "skr_pi";', 'board      = "bucks";'), HOLDER);
});

test('a define the file does not assign at top level is REFUSED, not appended; a type mismatch too', () => {
  const r = applyVariant(HOLDER, { part: 'x', defines: { no_such_var: '"a"' } });
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.why, /no top-level variable no_such_var/);
  const t = applyVariant(HOLDER, { part: 'y', defines: { board: '3' } });
  assert.equal(t.ok, false);
});

test('a hand-edited source matches no variant', () => {
  const vs = rowsFor('2bee_cnc_table/cnc_pcb_holder_3d.scad');
  assert.equal(currentVariant(HOLDER.replace('board      = "bucks";', 'board      = "buck48_24";'), vs), null);
});
