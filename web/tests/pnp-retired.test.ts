// pcb ticket 2026-11-12-19-43-40: retired boards showed as live PCB cards. Markers are pcb's; no names here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retiredBy, retiredLabel } from '../src/pnp/retired';

const M = [
  'hardware/pcb/sensor_pod/_SUPERSEDED.md',
  'hardware/pcb/sensor_pod/fab/_DO-NOT-ORDER.md',
  'hardware/pcb/autoframe_motor/fab/_DO-NOT-ORDER.md',
  'hardware/pcb/split/fab/io/_DO-NOT-ORDER-io.md',
];

test('superseded wins and names its marker', () => {
  const r = retiredBy('hardware/pcb/sensor_pod/fab/sensor_pod-cpl.csv', M);
  assert.deepEqual(r, { marker: 'hardware/pcb/sensor_pod/_SUPERSEDED.md', kind: 'superseded' });
  assert.match(retiredLabel(r!), /do not order/);
});

test('a DO-NOT-ORDER in fab/ retires the board', () => {
  assert.equal(retiredBy('hardware/pcb/autoframe_motor/fab/autoframe_motor-cpl.csv', M)?.kind, 'do-not-order');
});

test('a sub-board marker covers that sub-board only', () => {
  assert.equal(retiredBy('hardware/pcb/split/fab/io/io-cpl.csv', M)?.kind, 'do-not-order');
  assert.equal(retiredBy('hardware/pcb/split/fab/soc/soc-cpl.csv', M), null);
});

test('a live board, and a board with a similar name, stay live', () => {
  assert.equal(retiredBy('hardware/pcb/outlet/fab/outlet-cpl.csv', M), null);
  assert.equal(retiredBy('hardware/pcb/sensor_pod_v3/fab/io/sensor_pod_v3_io-cpl.csv', M), null, 'sensor_pod_v3 is not sensor_pod');
});
