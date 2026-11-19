// "MINE" — THE USER'S OWN SAVED DESIGNS, ON THE DESIGN PAGE.
//
// Founder 2026-10-15: *"in the design page able to filter to see only my designs
// what I changed and saved"*. They live in the browser store's `drawings` list
// (`store.ts`): models saved from 2bee.cad (`cad/record.ts` records — source AND
// the mesh the CNC tab cuts) and plain drawings the user saved in cnc (a DXF/SVG/
// STL file, no source).
//
// ⚠ WHAT A SAVED MODEL DOES NOT CARRY: its imports. A record stores the entry
// source only (`CadPayload.source`), so a model that `use`s or `include`s another
// file reopens with those imports unresolved unless 2bee.cad has a library
// holding them. The card says so rather than letting the refusal surprise.
//
// ⚠ A SAVED DRAWING FILE HAS NO SOURCE, so it has no 2bee.cad view and no 3D
// view built from source; it opens in cnc only, and the card says why the other
// two are unavailable.

import { cadRowDetail, isCadRecord, verifyCadRecord, type CadVerification, type SavedCadDrawing } from '../cad/record';
import { list as listSaved } from '../store';
import type { MeshResult } from '../cad/mesh';
import type { ViewerSubject } from './DesignViewer';
import type { CncHandoff, PendingDesign } from './handoff';
import { workpieceOfRecord, workpieceSentence } from './toCnc';

export interface MineItem {
  /** Unique across the page: `mine:<name>`. */
  id: string;
  /** The user's name for it — also the `drawings` key. */
  title: string;
  savedAt: number;
  /** No pictures are stored with a saved item. */
  thumb: null;
  kind: 'cad' | 'drawing';
  /** `kind === 'cad'` only. */
  rec: SavedCadDrawing | null;
  verification: CadVerification | null;
  /** `kind === 'drawing'` only: the file format it was saved as. */
  format: string | null;
  /** The source names files it does not carry (`use`/`include`). */
  hasImports: boolean;
}

const IMPORT_RE = /^\s*(use|include)\s*</m;

export function toMineItem(row: { name: string; saved_at: number; data: unknown }): MineItem {
  const cad = isCadRecord(row.data) ? (row.data as SavedCadDrawing) : null;
  const fmt = !cad && row.data && typeof row.data === 'object' && 'format' in row.data ? String((row.data as { format: unknown }).format) : null;
  return {
    id: `mine:${row.name}`,
    title: row.name,
    savedAt: row.saved_at,
    thumb: null,
    kind: cad ? 'cad' : 'drawing',
    rec: cad,
    verification: cad ? verifyCadRecord(cad) : null,
    format: fmt,
    hasImports: cad ? IMPORT_RE.test(cad.cad.source) : false,
  };
}

/** Everything in the `drawings` list, newest first. */
export async function listMine(): Promise<MineItem[]> {
  const rows = await listSaved<unknown>('drawings');
  return rows.map(toMineItem).sort((a, b) => b.savedAt - a.savedAt);
}

/** The file name a saved model is opened under (it has no path of its own). */
export function minePath(m: MineItem): string {
  return `${m.title.replace(/[\\/]/g, '_')}.scad`;
}

/** The design to hand to 2bee.cad or 3d. `null` for a drawing with no source. */
export function mineDesign(m: MineItem): PendingDesign | null {
  if (!m.rec) return null;
  const path = minePath(m);
  return { id: m.id, title: m.title, path, source: m.rec.cad.source, files: { [path]: m.rec.cad.source } };
}

/** The CNC handoff: the row is ALREADY in the drawings list, so nothing is re-saved. */
export function mineCnc(m: MineItem): CncHandoff {
  if (!m.rec) {
    return {
      drawingName: m.title,
      note: `your saved drawing${m.format ? ` (${m.format.toUpperCase()})` : ''}. It has no thickness of its own, so the cnc tab's workpiece thickness stands; check it matches the workpiece you load.`,
    };
  }
  // A saved 2bee.cad model: the thickness is read off its own STL, through the
  // function the Make step plans with (see toCnc.ts workpieceOfRecord).
  const wp = workpieceOfRecord(m.rec);
  return wp
    ? { drawingName: m.title, workpiece: wp, note: `${workpieceSentence(wp)} ${cadRowDetail(m.rec)}` }
    : { drawingName: m.title, note: `No thickness could be read from this model, so the cnc tab's workpiece thickness stands; check it. ${cadRowDetail(m.rec)}` };
}

/** The card's verdict line, in the record's own terms. */
export function mineNote(m: MineItem): string {
  if (!m.rec) return 'A drawing file you saved in cnc. It has no 2bee.cad source, so it opens in cnc only.';
  const parts: string[] = [];
  if (m.verification && m.verification.status !== 'ok') parts.push(`${m.verification.status.toUpperCase()}: ${m.verification.why}`);
  parts.push(
    m.rec.cad.complete
      ? 'Saved from 2bee.cad; its mesh was closed and nothing was refused when saved.'
      : 'Saved from 2bee.cad with constructs REFUSED — features are missing from its mesh.',
  );
  if (m.hasImports) parts.push('It imports other files, which are not saved with it — they resolve only if 2bee.cad has them.');
  return parts.join(' ');
}

/**
 * The mesh SAVED WITH the model — the binary STL in the record, which is what cnc
 * cuts — as a one-part MeshResult for CadPreview.
 *
 * 🔴 WHY NOT RE-EVALUATE THE SOURCE: a record carries the entry source only, not
 * its imports, so re-evaluating a model that `include`s its library draws NOTHING
 * (measured 2026-10-15: "Hive cleat" re-evaluated to 0 triangles). The stored
 * mesh is the thing the user saved.
 *
 * ⚠ THE VERDICT IS THE RECORD'S, NOT A NEW AUDIT. `audit` is null because this
 * file does not re-audit the STL; the record could only be saved with a `closed`
 * audit (`cad/record.ts` SAVEABLE_VERDICTS), and its checksums are re-checked by
 * `verifyCadRecord` — a stale or incompatible record is reported `untrusted`.
 */
export function meshFromRecord(m: MineItem): MeshResult {
  const rec = m.rec;
  if (!rec) throw new Error('a saved drawing file has no saved mesh');
  const bytes = rec.bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = bytes.byteLength >= 84 ? view.getUint32(80, true) : 0;
  const count = Math.min(n, Math.floor((bytes.byteLength - 84) / 50));
  const positions = new Float32Array(count * 9);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < count; t++) {
    const o = 84 + t * 50 + 12; // skip the normal
    for (let k = 0; k < 9; k++) {
      const v = view.getFloat32(o + k * 4, true);
      positions[t * 9 + k] = v;
      const ax = k % 3;
      if (v < min[ax]) min[ax] = v;
      if (v > max[ax]) max[ax] = v;
    }
  }
  const ok = m.verification?.status === 'ok';
  const refused = rec.cad.unsupported.length + rec.cad.issues.filter((i) => i.severity === 'refused').length;
  const trust: MeshResult['trust'] = count === 0 ? 'nothing' : !ok ? 'untrusted' : rec.cad.complete ? 'trusted' : 'suspect';
  const trustDetail = !ok
    ? `This saved mesh may not belong to its source — ${m.verification && m.verification.status !== 'ok' ? m.verification.why : 'not verified'}`
    : rec.cad.complete
      ? `The mesh saved with this model (what cnc cuts). Its audit at save time: ${rec.cad.audit_detail}`
      : `The mesh saved with this model — ${refused} construct(s) were REFUSED when it was saved and are missing from it: ` +
        [...rec.cad.unsupported, ...rec.cad.issues.filter((i) => i.severity === 'refused')].map((i) => `${i.name} (line ${i.line})`).join(', ');
  return {
    parts: [
      {
        id: `${m.id}:saved`,
        label: m.title,
        line: 1,
        dim: 3,
        positions,
        triangles: count,
        audit: null,
        bounds: count ? { min, max } : null,
        colour: null,
      },
    ],
    issues: [],
    stats: { triangles: count, solids: count ? 1 : 0, flats: 0, booleansComputed: 0, booleansRefused: 0, ms: 0, work: 0 },
    trust,
    trustDetail,
    sourceDiagnostics: null,
  };
}

export function mineSubject(m: MineItem): ViewerSubject {
  const d = mineDesign(m);
  return {
    id: m.id,
    title: m.title,
    path: d ? `your design · ${d.path}` : 'your drawing',
    thumbKey: m.title,
    parts: m.rec ? m.rec.cad.solids : null,
    badge: { cls: m.rec ? (m.rec.cad.complete ? 'trusted' : 'suspect') : 'nothing', text: m.rec ? (m.rec.cad.complete ? 'mine · mesh closed' : 'mine · suspect') : 'mine' },
    note: mineNote(m),
    load: async () => {
      if (!d) throw new Error('a saved drawing file has no source to build a 3D view from');
      return { path: d.path, sources: d.files };
    },
    saved: m.rec ? () => meshFromRecord(m) : undefined,
  };
}
