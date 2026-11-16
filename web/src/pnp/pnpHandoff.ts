// OPENING A PCB IN 2bee.pnp FROM ELSEWHERE (the Designs page) — founder
// 2026-10-15: *"load all pcbs into the design, able to open only with pnp"*.
//
// The same shape as `shop/handoff.ts` (read its header for why this is a
// subscription and not a storage write): the caller PUBLISHES a board id; the
// PnP tab consumes it. One pending slot, because the tab may not be listening
// yet; a second click before it listens is the user changing their mind, so it
// replaces the first rather than queueing behind it. Claiming CLEARS the slot,
// so a remount never re-opens a board nobody asked for again.
//
// What is handed over is only the board ID — the files are `pcb`'s and the tab
// reads them itself (`boards.ts`), so there is no second copy in flight.

type Listener = (boardId: string) => void;

let pending: string | null = null;
const listeners = new Set<Listener>();

/** Ask the PnP tab to open board `id` (a `BoardEntry.id`, e.g. `outlet`). The
 *  caller switches the tab itself (App: `setTab('pnp')`). */
export function openInPnp(id: string): void {
  if (listeners.size === 0) {
    pending = id;
    return;
  }
  pending = null;
  for (const fn of listeners) fn(id);
}

/** Claim a request made before anything was listening. Clears the slot. */
export function claimPendingPnp(): string | null {
  const id = pending;
  pending = null;
  return id;
}

export function subscribePnp(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Tests only — the module holds process-wide state. */
export function resetPnpHandoff(): void {
  pending = null;
  listeners.clear();
}
