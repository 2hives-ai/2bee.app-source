// OPENING A PCB IN THE pcb TAB FROM ELSEWHERE (the Designs page) — founder
// 2026-10-16: *"update design to able to open pcbs with pcb or pnp"*. The twin
// of `pnp/pnpHandoff.ts` (same shape, its own slot, so a pcb click never opens
// the pnp tab and the reverse).
//
// The same shape as `shop/handoff.ts` (read its header for why this is a
// subscription and not a storage write): the caller PUBLISHES a board id; the
// pcb tab consumes it. One pending slot, because the tab may not be listening
// yet; a second click before it listens is the user changing their mind, so it
// replaces the first rather than queueing behind it. Claiming CLEARS the slot,
// so a remount never re-opens a board nobody asked for again.
//
// What is handed over is only the board ID — the files are `pcb`'s and the tab
// reads them itself (`pnp/boards.ts`), so there is no second copy in flight.

type Listener = (boardId: string) => void;

let pending: string | null = null;
const listeners = new Set<Listener>();

/** Ask the pcb tab to open board `id` (a `BoardEntry.id`, e.g. `outlet`). The
 *  caller switches the tab itself (App: `setTab('pcb')`). */
export function openInPcb(id: string): void {
  if (listeners.size === 0) {
    pending = id;
    return;
  }
  pending = null;
  for (const fn of listeners) fn(id);
}

/** Claim a request made before anything was listening. Clears the slot. */
export function claimPendingPcb(): string | null {
  const id = pending;
  pending = null;
  return id;
}

/** Read the slot WITHOUT clearing it — for a state initialiser, which StrictMode
 *  calls twice; the claim itself happens once, in an effect. */
export function peekPendingPcb(): string | null {
  return pending;
}

export function subscribePcb(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Tests only — the module holds process-wide state. */
export function resetPcbHandoff(): void {
  pending = null;
  listeners.clear();
}
