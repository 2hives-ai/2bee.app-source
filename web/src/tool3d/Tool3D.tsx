// A cutter as a 3D solid, built by `geometry.ts` from the same
// `readToolShape()` fields the flat drawing in `toolShape.tsx` uses. Slowly
// turns; drag to orbit. Falls back to the flat drawing where WebGL is not
// available or the tool states no diameter.

import type { ReactNode } from 'react';
import { readToolShape, type ToolShapeTool } from '../toolShape';
import { Scene3D } from './Scene3D';
import { buildToolModel, describeTool3D } from './geometry';

export interface Tool3DProps {
  tool: ToolShapeTool;
  className?: string;
  /** The flat drawing, shown when no 3D can be drawn. */
  fallback: ReactNode;
}

export function Tool3D({ tool, className, fallback }: Tool3DProps) {
  const key = JSON.stringify([
    tool.category,
    tool.diameter_mm,
    tool.shank_mm,
    tool.cutting_length_mm,
    tool.flutes,
    tool.included_angle_deg,
    tool.point_angle_deg,
    tool.flute_type,
    tool.overall_length_mm,
  ]);
  /* The tip and helix the solid is built from, on the wrapper, as the flat drawing carries them: f1fbf5ffb0 made the
   * properties pane a canvas and every per-tool check that read `svg[data-tool-shape]` found nothing (e2e
   * slicer.spec.ts:2778, red unseen until 2026-11-15). These are the RECORD's fields, not a measurement of the
   * solid — tests/tool3d-geometry.test.ts measures that. */
  const r = readToolShape(tool);
  return (
    <Scene3D
      build={() => buildToolModel(tool)?.group ?? null}
      buildKey={key}
      label={describeTool3D(tool).title}
      fallback={fallback}
      elevation={0.3}
      className={className}
      testid="tool-3d"
      data={{ 'data-tool-tip': r.tip.kind, 'data-tool-helix': String(r.helix) }}
    />
  );
}
