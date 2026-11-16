// "What to measure" on the router, as 3D scenes (founder 2026-10-14: *"not
// svg, show it in 3d!"*). Pure data on `shop-setup/measureSpec.ts`'s types;
// `Measure3D.tsx` renders them.
//
// ⚠ AN ILLUSTRATION, SCALED FROM THE REPORTED TRAVEL. It is a generic gantry
// router (two rails, a gantry, a Z carriage, a spindle), not cad's model of our
// table. The proportions follow `$130`/`$131` when they were read, so a machine
// that reports 1250 × 670 looks long and narrow. Nothing reads a number back out
// of it.
//
// Axes: machine X → scene X, machine Y → scene −Z, machine Z → scene Y (up).

import type { DimLine, MeasureScene, Part, Vec3 } from '../shop-setup/measureSpec';
import type { Diagram, RouterProfile } from './routerProfile';

const S = 1 / 100; // 100 mm = 1 scene unit

function frame(p: RouterProfile | null) {
  const W = Math.max(3, (p?.travel.X ?? 900) * S);
  const D = Math.max(3, (p?.travel.Y ?? 600) * S);
  const H = 2.2;
  return { W, D, H };
}

/** The machine, every part as body. Returns named parts so a scene can highlight one. */
function machine(p: RouterProfile | null) {
  const { W, D, H } = frame(p);
  const railX = W / 2 + 0.25;
  const parts: Record<string, Part> = {
    railL: { shape: 'box', size: [0.25, 0.3, D + 0.6], at: [-railX, 0.15, 0], role: 'body' },
    railR: { shape: 'box', size: [0.25, 0.3, D + 0.6], at: [railX, 0.15, 0], role: 'body' },
    board: { shape: 'box', size: [W + 0.2, 0.18, D + 0.2], at: [0, 0.09, 0], role: 'body' },
    uprightL: { shape: 'box', size: [0.2, H, 0.35], at: [-railX, 0.3 + H / 2, 0], role: 'body' },
    uprightR: { shape: 'box', size: [0.2, H, 0.35], at: [railX, 0.3 + H / 2, 0], role: 'body' },
    beam: { shape: 'box', size: [2 * railX + 0.2, 0.4, 0.35], at: [0, 0.3 + H, 0], role: 'body' },
    carriage: { shape: 'box', size: [0.6, 0.9, 0.3], at: [0, 0.3 + H - 0.3, 0.33], role: 'body' },
    spindle: { shape: 'cylinder', size: [0.22, 0.22, 1.0], at: [0, 0.3 + H - 1.0, 0.33], role: 'body' },
    collet: { shape: 'cone', size: [0.16, 0.08, 0.2], at: [0, 0.3 + H - 1.6, 0.33], role: 'body' },
    cutter: { shape: 'cylinder', size: [0.04, 0.04, 0.35], at: [0, 0.3 + H - 1.88, 0.33], role: 'body' },
  };
  return { parts, W, D, H, railX };
}

const hi = (p: Part): Part => ({ ...p, role: 'highlight' });

/** The scene for one measurement diagram (and an optional axis for `steps`). */
export function routerScene(diagram: Diagram, p: RouterProfile | null, axis?: 'X' | 'Y' | 'Z'): MeasureScene {
  const m = machine(p);
  const parts = { ...m.parts };
  const dims: DimLine[] = [];
  const top = 0.3 + m.H;
  const t = (n: number | null | undefined) => (n == null ? '?' : `${n}`);
  switch (diagram) {
    case 'switches': {
      // Limit switches: X min (left rail end), Y min (front of right rail), Z top (carriage).
      const sw = (at: Vec3): Part => ({ shape: 'box', size: [0.18, 0.18, 0.18], at, role: 'highlight' });
      const extra: Part[] = [
        sw([-m.W / 2, top, 0.33]),
        sw([m.railX, 0.4, m.D / 2 + 0.2]),
        sw([0, top + 0.25, 0.33]),
        { shape: 'box', size: [0.5, 0.05, 0.5], at: [0, 0.21, 0.33], role: 'highlight' }, // probe plate
      ];
      return { parts: [...Object.values(parts), ...extra], dims: [{ from: [0, 0.25, 0.33], to: [0, top - 1.95, 0.33], label: 'probe: touch plate to cutter' }], camera: [m.W, m.H * 1.6, m.D * 1.3] };
    }
    case 'homing':
      parts.carriage = hi(parts.carriage);
      parts.beam = hi(parts.beam);
      dims.push({ from: [0, top + 0.6, 0.33], to: [-m.W / 2, top + 0.6, m.D / 2], label: 'moves to home switches' });
      break;
    case 'travel':
      parts.carriage = hi(parts.carriage);
      dims.push(
        { from: [-m.W / 2, top + 0.7, 0.6], to: [m.W / 2, top + 0.7, 0.6], label: `X travel (set ${t(p?.travel.X)} mm)` },
        { from: [m.railX + 0.5, 0.3, m.D / 2], to: [m.railX + 0.5, 0.3, -m.D / 2], label: `Y travel (set ${t(p?.travel.Y)} mm)` },
        { from: [0.6, top - 0.6, 0.6], to: [0.6, top - 1.5, 0.6], label: `Z travel (set ${t(p?.travel.Z)} mm)` },
      );
      break;
    case 'steps': {
      const len = 100 * S;
      if (axis === 'Y') {
        parts.beam = hi(parts.beam);
        dims.push({ from: [m.railX + 0.45, 0.45, 0], to: [m.railX + 0.45, 0.45, -len], label: 'Y: jog 100 mm, measure with a rule' });
      } else if (axis === 'Z') {
        parts.spindle = hi(parts.spindle);
        dims.push({ from: [0.5, top - 1.0, 0.6], to: [0.5, top - 1.0 - len, 0.6], label: 'Z: jog 100 mm, measure with a rule' });
      } else {
        parts.carriage = hi(parts.carriage);
        dims.push({ from: [0, top + 0.6, 0.6], to: [len, top + 0.6, 0.6], label: 'X: jog 100 mm, measure with a rule' });
      }
      break;
    }
    case 'spoilboard':
      parts.board = hi(parts.board);
      dims.push({ from: [-m.W / 2 - 0.1, 0, m.D / 2 + 0.1], to: [-m.W / 2 - 0.1, 0.18, m.D / 2 + 0.1], label: 'calipers: thickness at each corner' });
      break;
    case 'collet':
      parts.collet = hi(parts.collet);
      dims.push({ from: [-0.16, top - 1.6, 0.6], to: [0.16, top - 1.6, 0.6], label: 'read the size engraved on the collet' });
      break;
    case 'spindle':
      parts.spindle = hi(parts.spindle);
      dims.push({ from: [0.35, top - 0.6, 0.6], to: [0.35, top - 1.3, 0.6], label: 'tachometer on tape on the nut' });
      break;
  }
  return { parts: Object.values(parts), dims, camera: [m.W * 0.9, m.H * 1.5, m.D * 1.4] };
}
