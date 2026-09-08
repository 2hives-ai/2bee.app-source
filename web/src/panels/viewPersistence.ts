/**
 * View preference persistence — extracted from App.tsx.
 *
 * Persists the CNC tab's projection and display unit in localStorage.
 * These are chrome settings — they change the picture, never the G-code.
 */

import { DEFAULT_UNIT, readUnit, type Unit } from '../units';
import type { Projection } from '../projection';
import { readProjection, CNC_DEFAULT_PROJECTION } from '../projection';

const CNC_PROJECTION_KEY = '2bee.app.cnc.projection';

export function storedCncProjection(): Projection {
  try {
    return readProjection(localStorage.getItem(CNC_PROJECTION_KEY), CNC_DEFAULT_PROJECTION);
  } catch {
    /* Storage disabled: the tab opens orthographic, which is the default anyway.
     * A read that fails must not leave the viewport in a mode nobody chose. */
    return CNC_DEFAULT_PROJECTION;
  }
}

export function rememberCncProjection(p: Projection) {
  try {
    localStorage.setItem(CNC_PROJECTION_KEY, p);
  } catch {
    /* Not remembered. The control still works for this session — a failed write
     * must not make the control itself stop working. */
  }
}

const CNC_UNITS_KEY = '2bee.app.cnc.units';

export function storedCncUnit(): Unit {
  try {
    return readUnit(localStorage.getItem(CNC_UNITS_KEY), DEFAULT_UNIT);
  } catch {
    /* Storage disabled: the tab opens in millimetres, which is the default and
     * also what every stored value already is. */
    return DEFAULT_UNIT;
  }
}

export function rememberCncUnit(u: Unit) {
  try {
    localStorage.setItem(CNC_UNITS_KEY, u);
  } catch {
    /* Not remembered. The control still works for this session. */
  }
}
