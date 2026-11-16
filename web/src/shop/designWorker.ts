// Run `viewer.worker.ts` once, as a promise that can be abandoned.
//
// One worker per request, terminated when it answers, when the caller aborts
// (dialog closed, card left) or at the give-up time — never left running. See
// `viewer.worker.ts` for what it evaluates and why it is off the page.

import type { ViewerReply, ViewerRequest } from './viewer.worker';
import { RESOLUTION_ORDER } from '../cad/resolution';

/**
 * The viewer stops waiting here. Above the mesher's own 120 s wall backstop
 * (`mesh.ts` WALL_BACKSTOP_MS), so a build the mesher would finish — refused or
 * not — is never cut short by the caller first.
 */
export const DESIGN_GIVE_UP_MS = 150_000;

/**
 * A MACHINE build (`forMachine`) walks the resolution ladder (`cad/machine.ts`): up to one mesher run per tier,
 * each with its own 120 s backstop. Waiting only 150 s would cut short a build the ladder would finish at a lower
 * tier — the exact thing the line above exists to prevent — so the wait scales with the tier count.
 */
export const MACHINE_GIVE_UP_MS = RESOLUTION_ORDER.length * 120_000 + 30_000;

export function runDesignWorker(
  req: ViewerRequest,
  opts: { signal?: AbortSignal; giveUpMs?: number; parts?: number } = {},
): Promise<ViewerReply> {
  return new Promise((resolve) => {
    if (typeof Worker === 'undefined') {
      resolve({
        ok: false,
        why: 'this browser cannot build the design off the page, and building it on the page would freeze it.',
      });
      return;
    }
    const giveUpMs = opts.giveUpMs ?? (req.forMachine === true ? MACHINE_GIVE_UP_MS : DESIGN_GIVE_UP_MS);
    const w = new Worker(new URL('./viewer.worker.ts', import.meta.url), { type: 'module' });
    let done = false;
    const finish = (r: ViewerReply) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      w.terminate();
      resolve(r);
    };
    const onAbort = () => finish({ ok: false, why: 'stopped.' });
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          why:
            `stopped after ${Math.round(giveUpMs / 1000)} s` +
            (opts.parts !== undefined ? ` — this design (${opts.parts} parts) is too slow to build here` : '') +
            '.',
        }),
      giveUpMs,
    );
    if (opts.signal?.aborted) return onAbort();
    opts.signal?.addEventListener('abort', onAbort);
    w.onmessage = (ev: MessageEvent<ViewerReply>) => finish(ev.data);
    w.onerror = (ev) => finish({ ok: false, why: ev.message || 'the builder stopped with an error.' });
    w.postMessage(req);
  });
}
