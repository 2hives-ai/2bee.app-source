// The router page's gate and its 3D scenes (src/run/RouterPage.tsx, routerScene.ts).
// Structural only: node has no WebGL and no serial port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseBlocker, machinePosition } from '../src/run/RouterPage.tsx';
import { routerScene } from '../src/run/routerScene.ts';
import { analyse, profileOf, measurementsFor } from '../src/run/routerProfile.ts';
import { initialTrackedState } from '../src/run/protocol.ts';

test('Analyse is refused until the board is identified as grblHAL, and while streaming or moving', () => {
  const t = initialTrackedState();
  assert.match(analyseBlocker(t, false)!, /identify the router first/);
  const idle = { ...t, identification: 'grblHAL' as const, controllerState: 'Idle' as const };
  assert.equal(analyseBlocker(idle, false), null);
  assert.equal(analyseBlocker({ ...idle, controllerState: 'Alarm' as const }, false), null);
  assert.match(analyseBlocker(idle, true)!, /streaming/);
  assert.match(analyseBlocker({ ...idle, controllerState: 'Run' as const }, false)!, /Idle or Alarm/);
  assert.match(analyseBlocker({ ...idle, identification: 'grbl' as const }, false)!, /grblHAL/);
});

test('machine position: MPos as is, WPos plus WCO, and nothing without a WCO', () => {
  const r = (kind: 'MPos' | 'WPos', position: number[]) => ({ positionKind: kind, position }) as never;
  assert.deepEqual(machinePosition(r('MPos', [1, 2, 3]), null), [1, 2, 3]);
  assert.deepEqual(machinePosition(r('WPos', [1, 2, 3]), [10, 20, 30]), [11, 22, 33]);
  assert.equal(machinePosition(r('WPos', [1, 2, 3]), null), null);
  assert.equal(machinePosition(null, null), null);
});

test('every measurement has a 3D scene with something highlighted and a labelled dimension', () => {
  const p = profileOf(analyse(['$22=1', '$30=24000', '$130=1250', '$131=670', '$132=90']));
  for (const m of measurementsFor(p)) {
    const axis = m.id.startsWith('steps') ? (m.id.slice(5) as 'X' | 'Y' | 'Z') : undefined;
    const s = routerScene(m.diagram, p, axis);
    assert.ok(s.parts.some((x) => x.role === 'highlight'), `${m.id}: nothing highlighted`);
    assert.ok(s.dims.length >= 1 && s.dims.every((d) => d.label.length > 3), `${m.id}: no labelled dimension`);
  }
});

test('the router is scaled from its reported travel', () => {
  const long = routerScene('travel', profileOf(analyse(['$130=1250', '$131=670'])));
  const width = (sc: typeof long) => sc.parts.find((x) => x.shape === 'box' && x.size[1] === 0.18)!.size;
  const [w, , d] = width(long);
  assert.ok(w > d, 'a 1250 x 670 machine must draw wider than deep');
  assert.match(long.dims.map((x) => x.label).join(' '), /X travel \(set 1250 mm\)/);
});
