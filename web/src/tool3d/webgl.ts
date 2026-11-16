// Can this browser give us a WebGL context at all? Asked ONCE, synchronously,
// with no three.js import — so the flat-drawing components can decide which
// picture to render without pulling the 3D chunk.
//
// `false` outside a browser (Node tests, server render), on a blocklisted GPU,
// and after `markWebglLost()` — the shared renderer calls that on a context
// loss, and every preview falls back to its drawing.

let cached: boolean | null = null;
const listeners = new Set<() => void>();

export function webglAvailable(): boolean {
  if (cached !== null) return cached;
  if (typeof document === 'undefined' || typeof window === 'undefined') return false;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    cached = !!gl;
    // Release the probe context now rather than waiting for GC — browsers cap
    // live contexts at ~16 and the app already holds several.
    (gl as WebGLRenderingContext | null)?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    cached = false;
  }
  return cached;
}

/** The shared renderer lost its context or could not be built. */
export function markWebglLost(): void {
  cached = false;
  for (const l of listeners) l();
}

export function onWebglLost(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
