/**
 * A change request for the cad chat, carried from another tab (cnc's "Open in cad to
 * change"). Held until the cad tab shows THE SAME DESIGN (`path`), then delivered once —
 * so a request can never be sent to the chat against a different model than the one it
 * was written for. The design itself travels through `shop/handoff.ts` as before.
 */
export interface CadAsk {
  /** Catalogue path the request is for (CadTab's selfPath once the design lands). */
  path: string;
  text: string;
}

let pending: CadAsk | null = null;
const listeners = new Set<() => void>();

export function requestCadAsk(a: CadAsk): void {
  pending = a;
  for (const fn of listeners) fn();
}

/** Take the request if it is for `path`; otherwise leave it waiting. */
export function claimCadAsk(path: string | null | undefined): string | null {
  if (!pending || !path || pending.path !== path) return null;
  const t = pending.text;
  pending = null;
  return t;
}

export function subscribeCadAsk(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Tests only. */
export function resetCadAsk(): void {
  pending = null;
  listeners.clear();
}
