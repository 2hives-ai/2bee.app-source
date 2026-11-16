// The plate's one-nozzle area (founder 2026-11-13: "in the plate show the area what is accessible by only one of
// the nozzles"), from Orca's extruder_printable_area. X2D values are the machine file's own
// (~/.config/OrcaSlicer/system/BBL/machine/Bambu Lab X2D 0.4 nozzle.json, read 2026-11-13).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oneNozzleZones } from '../src/print3d/PlateView.tsx';

const X2D_AREA = ['0x0', '256x0', '256x256', '0x256 '];
const X2D_EXTRUDERS = ['0x0,256x0,256x256,0x256', '20.5x0,256x0,256x256,20.5x256'];

test('X2D: the strip x 0-20.5 is reached by extruder 1 only, nothing by extruder 2 only', () => {
  assert.deepEqual(oneNozzleZones(X2D_AREA, X2D_EXTRUDERS), [{ x0: 0, y0: 0, x1: 20.5, y1: 256, only: 1 }]);
});

test('both sides restricted: one strip each; clipped to the plate', () => {
  assert.deepEqual(oneNozzleZones(X2D_AREA, ['0x0,240x0,240x256,0x256', '20x0,300x0,300x256,20x256']), [
    { x0: 0, y0: 0, x1: 20, y1: 256, only: 1 },
    { x0: 240, y0: 0, x1: 256, y1: 256, only: 2 },
  ]);
});

test('nothing is guessed: one extruder, equal reach, a non-rectangle, or no data -> no zone', () => {
  assert.deepEqual(oneNozzleZones(X2D_AREA, [X2D_EXTRUDERS[0]]), []);
  assert.deepEqual(oneNozzleZones(X2D_AREA, [X2D_EXTRUDERS[0], X2D_EXTRUDERS[0]]), []);
  assert.deepEqual(oneNozzleZones(X2D_AREA, [X2D_EXTRUDERS[0], '20x0,256x0,256x256,0x200']), []);
  assert.deepEqual(oneNozzleZones(X2D_AREA, null), []);
  assert.deepEqual(oneNozzleZones(null, X2D_EXTRUDERS), []);
});
