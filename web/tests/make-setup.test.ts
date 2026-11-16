// The three-step surface's decisions (src/make/setup.ts): which machine, what
// the human does before sending, and that Send says why it cannot send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  machineFor,
  makeable,
  fitsVolume,
  workpieceOf,
  setupChecklist,
  sendBlocker,
  X2D_VOLUME_MM,
  fitBlocker,
} from '../src/make/setup.ts';
import type { ShopEntry } from '../src/shop/catalogue.ts';

test('machine follows from the path suffix, and only one-job designs are makeable', () => {
  assert.equal(machineFor('2bee_hive/queen_excluder_3d.scad'), 'printer');
  assert.equal(machineFor('2bee_hive/2bee_hive_lid_wcnc.scad'), 'router');
  // Aluminium, drill press: not a router job (it was planned as plywood until 2026-10-15).
  assert.equal(machineFor('2bee_hive/nuc_tie_plate_acnc.scad'), null);
  assert.equal(machineFor('2bee_hive/2bee_hive_quilt.scad'), null);
  assert.equal(machineFor('2bee_hive/assembly.scad'), null);
  // A suffix in the middle of a name is not the suffix.
  assert.equal(machineFor('x_3d.scad.bak'), null);
  const e = (path: string) => ({ path }) as ShopEntry;
  assert.deepEqual(
    makeable([e('a_3d.scad'), e('b.scad'), e('c_wcnc.scad')]).map((x) => x.path),
    ['a_3d.scad', 'c_wcnc.scad'],
  );
});

test('the suffix rule agrees with the catalogue generator, so the two cannot drift apart', () => {
  // The generator writes `kind` from the same suffixes. If it gains a new
  // machine suffix this test does not know, the assertion below names it.
  const src = readFileSync(new URL('../scripts/build-shop-catalogue.ts', import.meta.url), 'utf8');
  const suffixes = [...src.matchAll(/\/_(\w+)\\\.scad\$\//g)].map((m) => m[1]);
  // `_assembly` and `_pcb` are display kinds, not machines: neither is one job.
  assert.deepEqual(suffixes.sort(), ['3d', 'acnc', 'assembly', 'pcb', 'wcnc']);
  assert.equal(machineFor('x_assembly.scad'), null);
  assert.equal(machineFor('x_pcb.scad'), null);
});

test('X2D fit is checked in any orientation, and a missing size is unknown, not a fit', () => {
  assert.equal(fitsVolume([55.8, 17, 18], X2D_VOLUME_MM), 'fits');
  assert.equal(fitsVolume([261, 10, 10], X2D_VOLUME_MM), 'fits'); // stood on end
  assert.equal(fitsVolume([508, 406, 3], X2D_VOLUME_MM), 'too-big'); // queen excluder
  assert.equal(fitsVolume([257, 257, 1], X2D_VOLUME_MM), 'too-big');
  assert.equal(fitsVolume(null, X2D_VOLUME_MM), 'unknown');
  assert.equal(fitsVolume([0, 1, 1], X2D_VOLUME_MM), 'unknown');
});

test('a flat part on edge still gives the right workpiece thickness', () => {
  assert.deepEqual(workpieceOf([19, 407, 80]), { thickness: 19, footprint: [407, 80] });
  assert.deepEqual(workpieceOf([544.8, 392.8, 18]), { thickness: 18, footprint: [544.8, 392.8] });
  assert.equal(workpieceOf(null), null);
});

test('printer checklist: plate, filament, too-big warning first, untrusted warning above all', () => {
  const ok = setupChecklist({ path: 'p_3d.scad', sizeMm: [50, 50, 10], trust: 'trusted' });
  assert.ok(ok[0].text.startsWith('Clean the build plate'));
  assert.ok(!ok.some((s) => s.text.includes('does not fit')));
  const big = setupChecklist({ path: 'q_3d.scad', sizeMm: [508, 406, 3], trust: 'untrusted' });
  assert.ok(big[0].text.includes('could not be read'));
  // Too big is a REFUSAL now, never a box to tick.
  assert.ok(!big.some((s) => s.text.includes('does not fit')));
  assert.match(fitBlocker('q_3d.scad', [508, 406, 3]) ?? '', /does not fit the X2D/);
  assert.equal(fitBlocker('q_3d.scad', [50, 50, 10]), null);
  assert.equal(fitBlocker('lid_wcnc.scad', [508, 406, 3]), null);
});

test('router checklist names the workpiece from the design and never a machine work area', () => {
  const s = setupChecklist({ path: 'lid_wcnc.scad', sizeMm: [536, 406, 18], trust: 'trusted' });
  assert.equal(s[0].text, 'Put in the workpiece: 18 mm thick, at least 536 × 406 mm, with room for clamps.');
  const all = s.map((x) => x.text + x.why).join(' ');
  for (const n of ['600', '900', '670', '1250', '2400', '2700']) assert.ok(!all.includes(n), `checklist states ${n}`);
  assert.ok(s.some((x) => x.text.startsWith('Fit the cutter')));
});

test('non-makeable designs get no checklist; Send states why it cannot send', () => {
  assert.deepEqual(setupChecklist({ path: 'assembly.scad', sizeMm: [1, 1, 1], trust: 'trusted' }), []);
  assert.match(sendBlocker('printer')!, /^Not yet\./);
  assert.match(sendBlocker('router')!, /^Not yet\./);
});
