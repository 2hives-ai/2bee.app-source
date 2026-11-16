// The Run tab moves nothing on a REAL board until a physical e-stop exists (ops H5).
// Journey test 2026-10-15: the CNC jobs page enforced it, this expert tab did not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { uiStateGate, setRealPortConnectedForTest, REAL_PORT_MOTION_REFUSAL } from '../src/RunTab';
import { initialTrackedState } from '../src/run/protocol';

const idle = { ...initialTrackedState(), tab: 'Idle', controllerState: 'Idle' } as ReturnType<typeof initialTrackedState>;

test('on a real port, start / jog / home are refused with the H5 reason; stop is not', () => {
  setRealPortConnectedForTest(true);
  try {
    for (const c of ['start', 'jog', 'home'] as const) {
      const r = uiStateGate(c, idle);
      assert.equal(r?.id, 'H5', `${c} must be refused on a real port`);
      assert.equal(r?.why, REAL_PORT_MOTION_REFUSAL);
    }
    assert.notEqual(uiStateGate('stop', { ...idle, controllerState: 'Jog' } as typeof idle)?.id, 'H5');
  } finally {
    setRealPortConnectedForTest(false);
  }
});

test('on a fake port nothing changes (the control for the test above)', () => {
  setRealPortConnectedForTest(false);
  for (const c of ['start', 'jog', 'home'] as const) assert.notEqual(uiStateGate(c, idle)?.id, 'H5');
});
