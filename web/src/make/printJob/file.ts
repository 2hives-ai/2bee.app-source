// The printable file the job names: the design, evaluated by the same 2bee.cad
// evaluator the rest of the app uses AS A RENDER (`$preview` false, cad/machine.ts),
// written as a binary STL, and hashed.
//
// The contract's `files[]` entry is `{name, size, sha256}` (pnp,
// `CONTRACT-chat-job.md` §1). Nothing here sends the bytes anywhere: there is no
// upload in the app yet. The hash is what lets a later upload prove it carried
// THIS file.
//
// ⚠ The model's own orientation is kept. pnp's contract leaves arranging to
// Orca (`placement: null`); nothing here lays the part flat for printing.

import { evaluateForMachine } from '../../cad/machine';
import { makeLibraryHost, type ScadLibrary } from '../../cad/library';
import { encodeBinaryStl } from '../../cad/record';
import type { JobFile } from './job';

export async function designFile(d: { id: string; title: string; path: string; source: string; files: Record<string, string> }): Promise<{ file: JobFile; bytes: Uint8Array } | { why: string }> {
  try {
    const lib: ScadLibrary = { files: new Map(Object.entries(d.files)), rootName: '', pickedAt: 0, skipped: [] };
    const ev = evaluateForMachine(d.source, { path: d.path, host: makeLibraryHost(lib) });
    if (ev.exhausted !== null) return { why: `The design is too large for the in-browser kernel at every resolution: ${ev.exhausted}` };
    const solids = ev.mesh.parts.filter((p) => p.dim === 3 && p.triangles > 0);
    if (!solids.length) return { why: 'The design produced no solid to print.' };
    const bytes = encodeBinaryStl(solids, `2bee.app print: ${d.title}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return { file: { name: `${d.id}.stl`, size: bytes.length, sha256 }, bytes };
  } catch (e) {
    return { why: `The printable file could not be made: ${String((e as Error).message ?? e)}` };
  }
}
