/*
 * Builds the 3D view of ONE catalogue design, off the main thread.
 *
 * Founder 2026-10-15: *"when I click on the preview it should open the 3d
 * visualization"*. The catalogue holds designs of up to ~300 parts, and
 * `parseScad` + `meshScene` are synchronous: run on the page they would freeze
 * it for as long as the mesh takes, with no way to close the dialog. In a
 * worker the page stays live, the dialog can show elapsed time, and Close
 * TERMINATES the work instead of waiting for it.
 *
 * ⚠ THIS IS THE SAME EVALUATION THE EXPERT TAB RUNS — `evaluate` in
 * `cad/ask.tsx` is exactly `parseScad(source, {path, host})` then
 * `meshScene(parse.scene)`, with the design's import closure as the library
 * host (as `MakeFlow` and `CadTab` pass it). It is called directly here rather
 * than through `ask.tsx` because that module pulls React into the worker.
 * Nothing here chooses or alters geometry; the verdict (`trust`) is the
 * mesher's own and travels back unmodified.
 */
import { parseScad } from '../cad/scad';
import { meshScene, type MeshResult } from '../cad/mesh';
import { makeLibraryHost, type ScadLibrary } from '../cad/library';
import { buildCadRecord, type CadBuild } from '../cad/record';
import { evaluateForMachine, machineRecordFrom, type Resolution } from '../cad/machine';
import { cutSolids, layFlat } from '../make/autoPlan';

export interface ViewerRequest {
  path: string;
  source: string;
  files: Record<string, string>;
  /**
   * Absent: return the mesh for the 3D viewer. Present: ALSO build the
   * drawings-list record the CNC tab cuts from (`cad/record.ts`
   * `buildCadRecord`, the same builder 2bee.cad's Save uses — refusals and all),
   * named this.
   */
  recordName?: string;
  /**
   * cnc only (founder 2026-10-15: "in cnc the toolpath is vertical?"): lay the
   * solid on its thinnest side BEFORE the record is built, as the Make step does
   * (make/autoPlan.ts layFlat — axis cycle only, no mirror). A panel modelled
   * standing on edge (Hive box panel, 19 x 407 x 80) was otherwise sectioned
   * through its edge at z = 40 and refused, or cut as a sliver. The 3D viewer
   * and the 3d tab keep the design as modelled.
   */
  layFlat?: boolean;
  /**
   * A file for a MACHINE (the 3d tab's STL, the cnc tab's drawings record): evaluate as a render
   * (`ScadOptions.render`: `$preview` false, fine `$fa`/`$fs`). Absent ⇒ the on-screen preview.
   * Named `forPrint` and set by the 3d print path only until 2026-11-12; the cnc record was a preview.
   */
  forMachine?: boolean;
}

export type ViewerReply =
  /** `resolution`: set for a `forMachine` build — the resolution-ladder tier it was built at (`cad/machine.ts`). */
  | { ok: true; result: MeshResult; record?: CadBuild; resolution?: Resolution }
  | { ok: false; why: string };

/**
 * The mesh with its SOLIDS laid flat together (one rigid move), or `null` if it
 * has none. The thinnest axis is chosen over `cutSolids` — the same parts the
 * Make step lays flat — never over 2D parts, which are not material and which
 * the record does not write. (Until 2026-11-12 this laid flat over every part,
 * so a design carrying a 2D part could choose a different axis here than in
 * the Make step.) 2D parts are left where they are; the record only counts them.
 */
function laidFlat(m: MeshResult): MeshResult {
  const solids = cutSolids(m.parts);
  const f = layFlat(solids);
  if (!f) return m; // No solid: the record builder refuses it in its own words.
  const moved = new Map(solids.map((p, i) => [p, f.solids[i].positions]));
  return { ...m, parts: m.parts.map((p) => (moved.has(p) ? { ...p, positions: moved.get(p)! } : p)) };
}

self.onmessage = (ev: MessageEvent<ViewerRequest>) => {
  const { path, source, files, recordName, layFlat: flat, forMachine } = ev.data;
  let reply: ViewerReply;
  try {
    const lib: ScadLibrary = { files: new Map(Object.entries(files)), rootName: '', pickedAt: 0, skipped: [] };
    if (forMachine === true) {
      // A machine file goes through the ONE machine build, resolution ladder included (cad/machine.ts).
      const m = evaluateForMachine(source, { path, host: makeLibraryHost(lib) });
      const result = m.mesh;
      reply =
        recordName === undefined
          ? { ok: true, result, resolution: m.resolution }
          : { ok: true, result, resolution: m.resolution, record: machineRecordFrom(m, recordName, Date.now(), flat ? laidFlat(result) : result) };
    } else {
      const parse = parseScad(source, { path, host: makeLibraryHost(lib) });
      const result = meshScene(parse.scene);
      reply =
        recordName === undefined
          ? { ok: true, result }
          : { ok: true, result, record: buildCadRecord({ name: recordName, source, parse, mesh: flat ? laidFlat(result) : result, now: Date.now() }) };
    }
  } catch (e) {
    reply = { ok: false, why: String((e as Error)?.message ?? e) };
  }
  // A Set: two parts sharing one buffer would make the transfer list throw.
  const transfer = reply.ok ? [...new Set(reply.result.parts.map((p) => p.positions.buffer as ArrayBuffer))] : [];
  if (reply.ok && reply.record?.ok) {
    const b = reply.record.record.bytes.buffer as ArrayBuffer;
    if (!transfer.includes(b)) transfer.push(b);
  }
  (self as unknown as Worker).postMessage(reply, transfer);
};
