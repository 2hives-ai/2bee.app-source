// 3D previews for the touch plate and work holding catalogues. Built by
// `geometry.ts` from the SAME catalogue numbers the flat drawings read, with
// the flat drawings' own caption lines printed under the solid.

import type { ReactNode } from 'react';
import { Scene3D } from './Scene3D';
import { buildTouchPlateModel, buildWorkholdingModel } from './geometry';
import { touchPlateCaption } from '../touchplateShape';
import { workholdingCaption, shapeFor } from '../workholdingShape';
import { findTouchPlate } from '../touchplates';

type Line = { text: string; tone: 'muted' | 'accent' | 'warn' };

const LEGEND: Line = {
  text: 'Faded orange wireframe = a stand-in shape (the number is not published). Drag to turn.',
  tone: 'muted',
};

function Caption({ lines }: { lines: Line[] }) {
  return (
    <ul className="t3d-cap">
      {lines.map((l, i) => (
        <li key={i} className={l.tone === 'warn' ? 't3d-warn' : l.tone === 'accent' ? 't3d-accent' : undefined}>
          {l.text}
        </li>
      ))}
    </ul>
  );
}

export function TouchPlate3D({ id, className, fallback }: { id: string; className?: string; fallback: ReactNode }) {
  const p = findTouchPlate(id);
  const lines = touchPlateCaption(id);
  if (!p || !lines) return <>{fallback}</>;
  const label =
    `3D model of ${p.name}. References the ${p.references}. ` +
    `Top thickness ${p.topMm === null ? 'not published' : `${p.topMm} mm`}, ` +
    `wall thickness ${p.wallMm === null ? 'not published' : `${p.wallMm} mm`}.`;
  return (
    <Scene3D
      build={() => buildTouchPlateModel(id)}
      buildKey={`tp:${id}:${p.topMm}:${p.wallMm}:${p.boreMm}:${p.footprintMm?.join('x')}:${p.standingHeightMm}`}
      label={label}
      fallback={fallback}
      elevation={0.55}
      className={className ? `t3d--wide ${className}` : 't3d--wide'}
      testid="touchplate-3d"
    >
      <Caption lines={[...lines, LEGEND]} />
    </Scene3D>
  );
}

export function Workholding3D({ id, className, fallback }: { id: string; className?: string; fallback: ReactNode }) {
  const s = shapeFor(id);
  const lines = workholdingCaption(id);
  if (!s || !lines) return <>{fallback}</>;
  const extra: Line[] = [];
  if (s.kind === 'proud') extra.push({ text: 'Dashed orange box = the keepout gate P7 checks a toolpath against.', tone: 'warn' });
  if (s.kind === 'through') extra.push({ text: 'Fastener diameter is not published — drawn 3.2 mm, as in the flat drawing.', tone: 'muted' });
  const label = `3D model of ${id}: ${s.heightMm} mm above the spoilboard, footprint ${s.footprintMm[0]} x ${s.footprintMm[1]} mm.`;
  return (
    <Scene3D
      build={() => buildWorkholdingModel(id)}
      buildKey={`wh:${id}:${s.heightMm}:${s.footprintMm.join('x')}`}
      label={label}
      fallback={fallback}
      elevation={0.5}
      className={className ? `t3d--wide ${className}` : 't3d--wide'}
      testid="workholding-3d"
    >
      <Caption lines={[...lines, ...extra, LEGEND]} />
    </Scene3D>
  );
}
