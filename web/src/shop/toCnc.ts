// A CATALOGUE DESIGN → THE CNC TAB'S DRAWINGS LIST.
//
// Founder 2026-10-15: *"in the design able to open every item in cad , cnc or
// 3d"*. The CNC tab plans from the DRAWINGS list, and the one existing route
// from a 2bee.cad model into it is `cad/record.ts` `buildCadRecord` +
// `store.ts` `saveCadModel` — what 2bee.cad's own File → Save does. This file
// uses that route unchanged, so the same refusals apply: a mesh whose audit is
// not `closed` is NOT saved, and says why.
//
// 🔴 THE CNC SIDE IS 2.5D: IT CUTS ONE FLAT SECTION OF THIS SOLID AT ONE Z.
// The returned `note` is `cadRowDetail`'s sentence — *"ONE section at z = … mm,
// CHOSEN FOR YOU"* — and the CNC tab must show it. A user who clicks "Open in
// cnc" on a 3D part and receives a section without being told is the
// plausible-wrong-part failure `cad/record.ts`'s header describes.
//
// ⚠ NAMES. `saveCadModel` overwrites by name. The record is saved under the
// design's title; if a drawing of that name already exists and is NOT this same
// source (the user's own work, or an older version of the design), a numbered
// name is used instead of overwriting it.

import { cadRowDetail, isCadRecord, type SavedCadDrawing } from '../cad/record';
import { workpieceFor, type Workpiece } from '../make/autoPlan';
import { parseStl } from '../print3d/model';
import { load as loadSaved, saveCadModel } from '../store';
import { useCncStore } from '../store/cncStore';
import { runDesignWorker } from './designWorker';
import { resolutionSentence } from '../cad/resolution';
import type { CncHandoff, Pending3d, PendingDesign } from './handoff';

type LoadFn = (name: string) => Promise<{ data: unknown } | null>;

/** The first name that is free, or already holds this exact source. */
export async function freeDrawingName(title: string, source: string, load: LoadFn): Promise<string> {
  const base = title.trim() || 'design';
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? base : `${base} (${n})`;
    const have = await load(name);
    if (!have) return name;
    if (isCadRecord(have.data) && (have.data as SavedCadDrawing).cad.source === source) return name;
  }
  throw new Error(`no free drawing name for "${base}" after 99 tries`);
}

/**
 * Evaluate the design off the page, build its drawings record, save it.
 * `{ ok: false }` carries the refusal in the record builder's own words.
 */
export async function designToCnc(
  d: PendingDesign,
  opts: { signal?: AbortSignal; parts?: number } = {},
): Promise<{ ok: true; cnc: CncHandoff } | { ok: false; why: string }> {
  const name = await freeDrawingName(d.title, d.source, (n) => loadSaved<unknown>('drawings', n));
  const r = await runDesignWorker({ path: d.path, source: d.source, files: d.files, recordName: name, layFlat: true, forMachine: true }, opts);
  if (!r.ok) return { ok: false, why: `it could not be built — ${r.why}` };
  if (!r.record) return { ok: false, why: 'the builder returned no drawing record.' };
  if (!r.record.ok) return { ok: false, why: `${r.record.refusal.headline}. ${r.record.refusal.detail}` };
  // Decided BEFORE saving: a hand-off that cannot state its workpiece is refused,
  // not saved and opened on the cnc tab's remembered thickness.
  const h = cncHandoffFor(name, r.record.record);
  if (!h.ok) return h;
  try {
    await saveCadModel(r.record.record, Date.now());
  } catch (e) {
    return { ok: false, why: String(e instanceof Error ? e.message : e) };
  }
  return h;
}

/**
 * The workpiece the cnc tab must plan a saved 2bee.cad record on, read off the
 * record's OWN STL — the bytes the tab sections and cuts, as they lie — and
 * passed through `workpieceFor`, the function the Make step plans with. `null`
 * when the bytes hold no solid with a thickness.
 */
export function workpieceOfRecord(rec: Pick<SavedCadDrawing, 'bytes'>): Workpiece | null {
  const e = recordExtents(rec);
  if (!e) return null;
  // The thinnest axis is the thickness, as `layFlat` chooses it (Z on a tie, so a record that is
  // already flat keeps its footprint). Until 2026-11-13 this read Z as it lies, and a record saved
  // from 2bee.cad is NOT laid flat: a 19 mm panel modelled on edge planned 80 mm deep.
  const up = e[2] <= Math.min(e[0], e[1]) ? 2 : e[0] <= e[1] ? 0 : 1;
  return workpieceFor({ size: [e[(up + 1) % 3], e[(up + 2) % 3], e[up]] });
}

/**
 * True when the record's bytes do not lie on their thinnest side — every record saved from
 * 2bee.cad's own Save, which stores the model as modelled. The cnc tab sections the bytes AS
 * THEY LIE, so such a record must be laid flat (rebuilt through `designToCnc`) before cnc gets it.
 */
export function recordStandsUp(rec: Pick<SavedCadDrawing, 'bytes'>): boolean {
  const e = recordExtents(rec);
  return !!e && e[2] > Math.min(e[0], e[1]) + 1e-6;
}

function recordExtents(rec: Pick<SavedCadDrawing, 'bytes'>): [number, number, number] | null {
  const b = rec.bytes;
  const tri = parseStl(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  if (!tri.length) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tri.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (tri[i + k] < min[k]) min[k] = tri[i + k];
      if (tri[i + k] > max[k]) max[k] = tri[i + k];
    }
  }
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
}

/** The note sentence that states the thickness the cnc tab will plan on. */
export function workpieceSentence(wp: Workpiece): string {
  return `The cnc tab plans it on a ${wp.t} mm thick workpiece, the part's own thickness as it lies (the same rule the Make step plans with); change it there if the workpiece you load is thicker or thinner.`;
}

/**
 * The cnc hand-off for a saved, laid-flat design record. Its workpiece is read
 * off the record's bytes through `workpieceFor`, so the cnc tab and the Make
 * step plan the same design on the same thickness.
 *
 * 🔴 REFUSES when no thickness can be read, rather than handing off a drawing
 * the cnc tab would plan on whatever thickness it last remembered.
 */
export function cncHandoffFor(name: string, record: SavedCadDrawing): { ok: true; cnc: CncHandoff } | { ok: false; why: string } {
  const wp = workpieceOfRecord(record);
  if (!wp) return { ok: false, why: 'the design laid flat has no thickness, so no workpiece can be stated for it.' };
  return {
    ok: true,
    cnc: {
      drawingName: name,
      workpiece: wp,
      note: `Laid flat on its thinnest side for cutting. ${workpieceSentence(wp)} ${cadRowDetail(record)}`,
    },
  };
}

/**
 * The cnc tab takes the hand-off's workpiece THICKNESS. The stock footprint is
 * left as the operator set it (the sheet on the bed), because the drawing is
 * placed on that sheet; the thickness is what every Z depth is computed from.
 */
export function takeHandoffWorkpiece(cnc: Pick<CncHandoff, 'workpiece'>): void {
  if (cnc.workpiece) useCncStore.getState().setThickness(cnc.workpiece.t);
}

/**
 * The design as a binary STL for the 3d tab — built off the page by the same
 * record builder, so the same refusals apply. Nothing is saved.
 */
export async function designToStl(
  d: PendingDesign,
  opts: { signal?: AbortSignal; parts?: number } = {},
): Promise<{ ok: true; stl: Pending3d['stl'] } | { ok: false; why: string }> {
  const r = await runDesignWorker({ path: d.path, source: d.source, files: d.files, recordName: d.title || 'design', forMachine: true }, opts);
  if (!r.ok) return { ok: false, why: `it could not be built — ${r.why}` };
  if (!r.record) return { ok: false, why: 'the builder returned no solid.' };
  if (!r.record.ok) return { ok: false, why: `${r.record.refusal.headline}. ${r.record.refusal.detail}` };
  const c = r.record.record.cad;
  const base = c.complete
    ? `${c.solids} solid(s), ${c.triangles} triangles, from 2bee.cad's mesh.`
    : `${c.solids} solid(s) — constructs were REFUSED and are missing from this STL.`;
  // The resolution-ladder tier (cad/machine.ts): stated whenever it is not the fine print resolution.
  const coarser = r.resolution ? resolutionSentence(r.resolution) : '';
  const note = coarser ? `${base} ${coarser}` : base;
  return { ok: true, stl: { name: `${(d.title || 'design').replace(/[\\/]/g, '_')}.stl`, bytes: r.record.record.bytes, note } };
}
