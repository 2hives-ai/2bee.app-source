/**
 * Operator stops (src/cnc/interventions.ts): read off the core's render moves,
 * one stop per M0 — a clamp move followed by a cutter change is ONE stop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RenderMove } from '../src/cam.ts';
import {
  clampsForPhase,
  moveLines,
  movedInto,
  phaseAt,
  playedCount,
  stopCounts,
  stopSummary,
  stopTitle,
  stopsOf,
  CLAMP_NO_ZCHECK,
} from '../src/cnc/interventions.ts';

const mv = (kind: RenderMove['kind'], text?: string): RenderMove => ({ kind, x: 0, y: 0, z: 0, ...(text ? { text } : {}) });

test('a clamp move then a cutter change is one stop of kind both', () => {
  const moves = [mv('cut'), mv('change', '3mm'), mv('cut'), mv('clamp', 'move c1'), mv('change', '6mm'), mv('cut')];
  const s = stopsOf(moves);
  assert.equal(s.length, 2);
  assert.deepEqual(s[0], { at: 1, kind: 'cutter', cutter: '3mm' });
  // `from`: the second stop knows the cutter the first one fitted.
  assert.deepEqual(s[1], { at: 3, kind: 'both', clamps: 'move c1', cutter: '6mm', from: '3mm' });
  assert.deepEqual(stopCounts(moves), { stops: 2, cutter: 2, clamps: 1, both: 1, handZero: 0, unchecked: 0 });
  assert.equal(
    stopSummary(moves, { cutter: 2, clamps: 1, merged: 1, stops: 2, stops_unmerged: 3 }),
    '2 cutter changes · 1 clamp move (1 done at a cutter change: 3 stops → 2)',
  );
});

test('a clamp move alone is a clamps stop, and the phase follows the playhead', () => {
  const moves = [mv('cut'), mv('cut'), mv('clamp', 'move c1'), mv('probe'), mv('cut')];
  assert.deepEqual(stopsOf(moves).map((s) => s.kind), ['clamps']);
  assert.equal(phaseAt(moves, playedCount(moves.length, 0.2)), 0);
  assert.equal(phaseAt(moves, playedCount(moves.length, 0.6)), 1);
  assert.equal(phaseAt(moves, playedCount(moves.length, 1)), 1);
});

test('clamps per phase come from the report, and a one-phase job keeps report.clamps', () => {
  const A = [{ name: 'c1', x: 0, y: 0, w: 10, h: 10, height_mm: 20 }];
  const B = [{ name: 'c1', x: 0, y: 50, w: 10, h: 10, height_mm: 20 }];
  assert.equal(clampsForPhase({ clamps: A }, 3), A);
  assert.equal(clampsForPhase({ clamps: A, clamp_phases: [A, B] }, 0), A);
  assert.equal(clampsForPhase({ clamps: A, clamp_phases: [A, B] }, 1), B);
  const moves = [{ clamp: 'c1', from: [5, 5] as [number, number], to: [5, 55] as [number, number] }];
  assert.deepEqual(movedInto({ clamp_moves: moves }, 0), []);
  assert.deepEqual(movedInto({ clamp_moves: moves }, 1), moves);
  assert.deepEqual(moveLines(moves, 'mm'), ['Move clamp c1 from X 5 mm, Y 5 mm to X 5 mm, Y 55 mm']);
});

test('no Z probe: a cutter change and its hand zero are ONE stop, titled old → new', () => {
  const moves = [mv('cut'), mv('change', '6mm'), mv('zero', '6mm: touch off'), mv('cut'), mv('change', '3mm drill'), mv('zero', '3mm drill: touch off'), mv('cut')];
  const s = stopsOf(moves);
  assert.equal(s.length, 2);
  assert.deepEqual(s[1], { at: 4, kind: 'cutter', cutter: '3mm drill', from: '6mm', zero: '3mm drill: touch off' });
  assert.equal(stopTitle(s[1]), 'Change cutter: 6mm → 3mm drill, then set Z zero by hand');
  assert.equal(stopCounts(moves).handZero, 2);
  assert.match(stopSummary(moves), /^2 cutter changes · Z zero set by hand after every cutter change \(no Z probe\)$/);
});

test('no Z probe: a clamp-only stop carries the warning; with a re-probe after it, none', () => {
  const noProbe = stopsOf([mv('cut'), mv('clamp', 'move c1'), mv('cut')]);
  assert.equal(noProbe[0].warning, CLAMP_NO_ZCHECK);
  // CONTROL: the core writes a probe right after the clamp stop when it can.
  const probed = stopsOf([mv('cut'), mv('clamp', 'move c1'), mv('probe'), mv('cut')]);
  assert.equal(probed[0].warning, undefined);
  // A merged stop changes the cutter, so Z IS set again: no warning.
  const merged = stopsOf([mv('cut'), mv('clamp', 'move c1'), mv('change', '3mm'), mv('zero', 'x'), mv('cut')]);
  assert.equal(merged[0].warning, undefined);
  assert.equal(stopTitle(merged[0]), 'Move clamps and change cutter: 3mm, then set Z zero by hand');
});

test('the warning text is the core\'s, byte for byte', async () => {
  const { readFileSync } = await import('node:fs');
  const core = readFileSync(new URL('../../core/src/setup.rs', import.meta.url), 'utf8');
  assert.ok(core.includes(`"${CLAMP_NO_ZCHECK}"`), 'core/src/setup.rs CLAMP_NO_ZCHECK differs from the web copy');
});
