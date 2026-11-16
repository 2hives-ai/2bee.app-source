/*
 * 2bee.cad animation frames, built off the main thread (founder 2026-10-15:
 * "in the cad add a play button if animation exists for the scad").
 *
 * One frame = the SAME evaluation the tab runs (`parseScad` with `t` bound to
 * `$t`, then `meshScene`) — nothing interpolated, nothing guessed between
 * frames. Measured 2026-10-15 in node: 2.4–2.6 s per frame for
 * anim_s5_z.scad (77 parts), 5.8–6.2 s for anim_demo.scad (315 parts). That is
 * why frames are built here and posted one by one, and why playback can only
 * show the frames that exist so far.
 *
 * ⚡ PARALLEL (2026-10-15, founder: "analize why the building frames is going
 * slowly, improve it"). A cpu profile of one anim_s5_z frame (~2 s) spends it in
 * the mesher's CSG booleans (splitPolygon/BSP), T-junction repair (near,
 * repairTJunctions) and quickhull: real work, repeated for every part on every
 * frame. Frames are independent, so `CadAnim` now starts several of these
 * workers, each building every Nth frame. The geometry is unchanged: each
 * frame is still one full `parseScad` + `meshScene`.
 */
import { parseScad } from './scad';
import { meshScene, type MeshResult } from './mesh';
import { makeLibraryHost, type ScadLibrary } from './library';

export interface AnimRequest {
  path: string;
  source: string;
  files: Record<string, string>;
  frames: number;
  /** Which frames THIS worker builds (several workers share one animation). */
  indices: number[];
}
export type AnimReply =
  | { kind: 'frame'; index: number; t: number; result: MeshResult; ms: number }
  | { kind: 'failed'; index: number; why: string }
  | { kind: 'done' };

self.onmessage = (ev: MessageEvent<AnimRequest>) => {
  const { path, source, files, frames, indices } = ev.data;
  const lib: ScadLibrary = { files: new Map(Object.entries(files)), rootName: '', pickedAt: 0, skipped: [] };
  for (const i of indices) {
    const t = i / frames;
    const t0 = performance.now();
    try {
      const parse = parseScad(source, { path, host: makeLibraryHost(lib), t });
      const result = meshScene(parse.scene);
      (self as unknown as Worker).postMessage({ kind: 'frame', index: i, t, result, ms: performance.now() - t0 } satisfies AnimReply);
    } catch (e) {
      (self as unknown as Worker).postMessage({ kind: 'failed', index: i, why: String(e instanceof Error ? e.message : e) } satisfies AnimReply);
      return;
    }
  }
  (self as unknown as Worker).postMessage({ kind: 'done' } satisfies AnimReply);
};
