/**
 * The selected design(s), shown under the design picker in the cnc chat
 * (founder 2026-10-15: "if design is selected show it under the design above
 * the ai agent"). A thumbnail saved from the cnc view if there is one
 * (`thumbnail.ts`), else the part outlines AS THE CORE IMPORTED THEM
 * (`report.drawing`), drawn flat — what will be cut, not a render.
 */
import type { DrawingPart } from '../cam';
import { readThumbnail } from './thumbnail';

export function DesignPreview({ names, parts }: { names: string[]; parts: DrawingPart[] | null }) {
  if (names.length === 0) return null;
  const thumb = readThumbnail(names.join(' + '));
  if (thumb) {
    return (
      <figure className="cnc-design-preview" data-testid="cnc-design-preview">
        <img src={thumb.dataUrl} alt={`${names.join(' + ')} — saved from cnc`} />
        <figcaption>{names.join(' + ')}</figcaption>
      </figure>
    );
  }
  const loops: { x: number; y: number }[][] = [];
  for (const p of parts ?? []) {
    for (const c of [p.outer, ...p.inners]) loops.push(c.verts.map((v) => ({ x: v.x, y: v.y })));
  }
  const pts = loops.flat();
  if (pts.length === 0) {
    return (
      <figure className="cnc-design-preview" data-testid="cnc-design-preview">
        <div className="note">Reading {names.join(' + ')}…</div>
      </figure>
    );
  }
  const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
  return (
    <figure className="cnc-design-preview" data-testid="cnc-design-preview">
      <svg viewBox={`${minX - w * 0.04} ${-maxY - h * 0.04} ${w * 1.08} ${h * 1.08}`} role="img" aria-label={`Outlines of ${names.join(' + ')}`}>
        {loops.map((l, i) => (
          <polygon key={i} points={l.map((p) => `${p.x},${-p.y}`).join(' ')} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <figcaption>
        {names.join(' + ')} · {Math.round(w)} × {Math.round(h)} mm
      </figcaption>
    </figure>
  );
}
