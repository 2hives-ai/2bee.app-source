/**
 * The board's 3D inputs for `BoardView`, for a tab OTHER than PnP (the pcb tab,
 * founder 2026-10-16: *"have the 3d pcb view"*): pcb's gerber render
 * (`stackup.ts`) and pcb's component models (the kicad-cli GLB), each with the
 * sentence that says why it is absent.
 *
 * ⚠ The same loading PnpTab does inline. PnpTab is NOT switched onto this hook
 * in this change, so the pnp tab's behaviour is untouched; when it is, the two
 * copies become one.
 */
import { useEffect, useState } from 'react';
import type { Object3D } from 'three';
import { loadPartsGlb, loadStackup, stackupIndex, type StackupSides } from './stackup';

export interface Board3d {
  /** The gerber render, or null (fallback: the part-extent plate). */
  sides: StackupSides | null;
  /** Why there is no render ('' when there is, or while loading). */
  sidesWhy: string;
  partsGlb: Object3D | null;
  glbWhy: string;
  /** Models that are pcb's generic box_*.step stand-ins, of those with a model. */
  models: { withModel: number; placeholder: number } | null;
}

export function useBoard3d(boardId: string): Board3d {
  const [stack, setStack] = useState<{ id: string; sides: StackupSides | null; why: string } | null>(null);
  const [glb, setGlb] = useState<{ id: string; obj: Object3D | null; why: string; models: Board3d['models'] } | null>(null);
  useEffect(() => {
    setStack(null);
    setGlb(null);
    if (!boardId) return;
    let live = true;
    void stackupIndex().then(async (idx) => {
      const e = idx?.get(boardId);
      const why = !idx ? 'no gerber render (run npm run pnp:stackup)' : !e ? 'no gerbers for this board' : e.error ? `gerbers could not be rendered: ${e.error}` : '';
      const models = e?.parts ? { withModel: e.parts.withModel, placeholder: e.parts.placeholder } : null;
      if (why) {
        if (live) setStack({ id: boardId, sides: null, why });
      } else
        loadStackup(boardId).then(
          (sides) => live && setStack({ id: boardId, sides, why: sides ? '' : 'no gerber render' }),
          (err: Error) => live && setStack({ id: boardId, sides: null, why: `gerber render did not load: ${err.message}` })
        );
      if (!e?.parts?.glb) {
        if (live) setGlb({ id: boardId, obj: null, why: e?.parts?.error ?? 'no model export (run npm run pnp:stackup)', models });
      } else
        loadPartsGlb(boardId).then(
          (obj) => live && setGlb({ id: boardId, obj, why: '', models }),
          (err: Error) => live && setGlb({ id: boardId, obj: null, why: `models did not load: ${err.message}`, models })
        );
    });
    return () => {
      live = false;
    };
  }, [boardId]);
  const s = stack && stack.id === boardId ? stack : null;
  const m = glb && glb.id === boardId ? glb : null;
  return { sides: s?.sides ?? null, sidesWhy: s?.why ?? '', partsGlb: m?.obj ?? null, glbWhy: m?.why ?? '', models: m?.models ?? null };
}
