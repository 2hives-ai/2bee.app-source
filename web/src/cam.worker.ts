/*
 * The CAM core, off the main thread.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FIXES, AND WHAT THE README CLAIMED FOR WEEKS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 🔴 `README.md`'s stack table said **"WASM in a Web Worker — slicing must not
 * block the canvas"**, and it had NEVER been true: `cam.ts` loaded the wasm glue
 * on the main thread and called straight into it, and the only `Worker` under
 * `web/src` was `run/streamer.worker.ts`, which streams G-code to the machine
 * and does no CAM at all. So planning a large drawing froze the canvas the row
 * said it protected — the reason was right and the mechanism was absent
 * (TODO #144, raised 2026-08-28 when the row was corrected rather than
 * promised).
 *
 * This is the mechanism. It owns the wasm instance; `cam.ts` owns the protocol.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ **It is not a second place where machining decisions are made**, and that is
 * the rule `cam.ts` opens with: no machining decision is taken in TypeScript,
 * because anything computed here would be invisible to the CLI and to the gates,
 * and gate `I1`'s browser-vs-CLI parity would then be comparing two different
 * programs. This file forwards a named export and its arguments to the SAME
 * wasm build the CLI's core was compiled from, and forwards the answer back. It
 * must never grow a branch that inspects a job.
 *
 * ⚠ **It does not change what is emitted.** The core is the same bytes; gate
 * `K3` proves the wasm and the CLI came from one core, and `I1` proves the two
 * hosts emit identical G-code. Moving the call site between threads cannot make
 * those disagree — and if it ever does, one of them is wrong about which build
 * it loaded, which is exactly what those two gates are for.
 */

/** One call: the exported wasm function to run, and its arguments. */
export interface CamRequest {
  id: number;
  fn: string;
  args: unknown[];
}

/** Its answer. `ok: false` carries the error's MESSAGE, not the Error — an
 *  `Error` does not survive `structuredClone` with its stack intact, and a
 *  half-cloned error reaching the UI reads as a different fault. */
export interface CamResponse {
  id: number;
  ok: boolean;
  out?: unknown;
  err?: string;
}

let loading: Promise<Record<string, unknown>> | null = null;

/**
 * Load the wasm exactly as `cam.ts` used to on the main thread — the glue from
 * `src/wasm/` (NOT `public/`, which `vite dev` refuses to serve to an import),
 * and the `.wasm` fetched at runtime as a Vite asset.
 */
function load(): Promise<Record<string, unknown>> {
  if (!loading) {
    loading = (async () => {
      const m = await import('./wasm/twobee_cam_wasm.js');
      // `{ module_or_path }` rather than a bare URL: wasm-bindgen deprecated the
      // positional form and warns on every load, and a warning nobody can act
      // on trains people to scroll past the console.
      await m.default({ module_or_path: new URL('./wasm/twobee_cam_wasm_bg.wasm', import.meta.url) });
      return m as unknown as Record<string, unknown>;
    })();
  }
  return loading;
}

self.onmessage = async (ev: MessageEvent<CamRequest>) => {
  const { id, fn, args } = ev.data;
  try {
    const m = await load();
    const f = m[fn];
    if (typeof f !== 'function') {
      // NAMED, never "undefined is not a function". A renamed wasm export must
      // say which name was asked for: the alternative is a TypeError in a
      // worker, which reaches the page as a blank failure with no subject.
      throw new Error(
        `the CAM core has no export named ${JSON.stringify(fn)} — the wasm build and cam.ts disagree about the API`,
      );
    }
    const out = (f as (...a: unknown[]) => unknown)(...args);
    (self as unknown as Worker).postMessage({ id, ok: true, out } satisfies CamResponse);
  } catch (e) {
    (self as unknown as Worker).postMessage({
      id,
      ok: false,
      err: e instanceof Error ? e.message : String(e),
    } satisfies CamResponse);
  }
};
