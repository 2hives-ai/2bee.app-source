// The workpiece in 3D: the design laid flat where the planner put it, inside
// a translucent workpiece, and — on the clamp step — the clamp border.
//
// Drawn by 2bee.cad's own viewport (`cad/preview.tsx`), so orbit, zoom and the
// no-WebGL fallback are the ones the app already has. The workpiece and the
// clamp border are drawn as extra solids evaluated from two lines of SCAD by
// the same evaluator; they are PICTURES of the declared sizes, not geometry the
// planner reads. The workpiece is drawn 0.1 mm proud on every face so its faces
// do not fight the part's coplanar ones.

import { useMemo } from 'react';
import { CadPreview } from '../cad/preview';
import { evaluate } from '../cad/ask';
import type { MeshResult } from '../cad/mesh';
import { CLAMP_MARGIN_MM } from '../make/autoPlan';

const r2 = (v: number) => Math.round(v * 100) / 100;

function extras(stock: { x: number; y: number; t: number }, clamps: boolean): MeshResult['parts'] {
  const { x, y, t } = stock;
  const m = CLAMP_MARGIN_MM;
  const lines = [`color([0.85, 0.7, 0.45, 0.25]) translate([-0.1, -0.1, -0.1]) cube([${r2(x + 0.2)}, ${r2(y + 0.2)}, ${r2(t + 0.2)}]);`];
  if (clamps) {
    const top = r2(t + 0.2);
    const c = 'color([0.96, 0.65, 0.14, 0.6])';
    lines.push(
      `${c} translate([0, 0, ${top}]) cube([${r2(x)}, ${m}, 1]);`,
      `${c} translate([0, ${r2(y - m)}, ${top}]) cube([${r2(x)}, ${m}, 1]);`,
      `${c} translate([0, ${m}, ${top}]) cube([${m}, ${r2(y - 2 * m)}, 1]);`,
      `${c} translate([${r2(x - m)}, ${m}, ${top}]) cube([${m}, ${r2(y - 2 * m)}, 1]);`,
    );
  }
  return evaluate(lines.join('\n')).mesh.parts.map((p, i) => ({ ...p, id: `cncjob-extra-${i}` }));
}

export default function Workpiece3D({
  mesh,
  stock,
  clamps = false,
  label,
}: {
  mesh: MeshResult;
  stock: { x: number; y: number; t: number };
  clamps?: boolean;
  label: string;
}) {
  const result = useMemo<MeshResult>(() => ({ ...mesh, parts: [...mesh.parts, ...extras(stock, clamps)] }), [mesh, stock, clamps]);
  return (
    <div className="cj-view" aria-label={label} data-testid="cj-3d">
      <CadPreview result={result} stale={false} showAxes={false} showScaleMarkers={false} projection="perspective" />
    </div>
  );
}
