/**
 * A design's functional specification as the USER edited it — kept in this browser.
 *
 * Founder 2026-10-16: *"Every design cad(scad)/pcb have to have a detailed functional
 * specification, show it in cnc, pcb, user should able to edit what ai will review and
 * work on it if it changes the design."*
 *
 * 🔴 TWO TEXTS, NEVER CONFUSED. The OWNER'S spec is the file `cad` / `pcb` wrote
 * (`hardware/cad/<dir>/<stem>.spec.md`, `hardware/pcb/<board>/SPEC.md`); this lane only
 * reads it. The USER'S copy lives here, under the design key, and is always labelled
 * as theirs. A copy that started as an AI draft keeps `origin: 'ai-draft'` for its
 * whole life, so an AI-written text is never shown as the owning lane's spec.
 *
 * Keys follow `cnc/thumbnail.ts`: the saved design name, else the catalogue path
 * (cad), or the board id (pcb, prefixed `pcb:` so a board and a design never share one).
 */
export const SPEC_PREFIX = '2bee.app.spec.';
/** Undo depth. Older steps fall off the bottom. */
export const SPEC_UNDO_CAP = 20;

/** The ticket the owning lanes were sent, quoted where no spec exists yet. */
export const SPEC_TICKET = 'ticket 2026-10-16 functional-spec-for-every-design';

/** The eight headings every spec carries (the ticket's template). */
export const SPEC_HEADINGS = [
  '1. Purpose',
  '2. Functional requirements',
  '3. Interfaces',
  '4. Critical dimensions and tolerances',
  '5. Material and process',
  '6. Environment and loads',
  '7. Acceptance checks',
  '8. Not stated / open questions',
] as const;

export type SpecOrigin = 'edited' | 'ai-draft';

export interface UserSpec {
  text: string;
  origin: SpecOrigin;
  savedAt: number;
  /** Earlier saved texts, newest LAST. Undo pops one. */
  undo: string[];
}

/** A `localStorage`-shaped thing, injected so the rules are tested in node. */
export interface SpecStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export function specKey(kind: 'cad' | 'pcb', designKey: string): string {
  return SPEC_PREFIX + (kind === 'pcb' ? `pcb:${designKey}` : designKey);
}

/**
 * The stored copy, or null. Every field is checked: a record that does not read is
 * treated as ABSENT (the owner's spec shows), never half-used.
 */
export function readUserSpec(store: SpecStore | null | undefined, key: string): UserSpec | null {
  try {
    const raw = store?.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as Record<string, unknown> | null;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    if (typeof v.text !== 'string') return null;
    if (v.origin !== 'edited' && v.origin !== 'ai-draft') return null;
    const undo = Array.isArray(v.undo) ? v.undo.filter((u): u is string => typeof u === 'string') : [];
    return { text: v.text, origin: v.origin, savedAt: Number(v.savedAt) || 0, undo };
  } catch {
    return null;
  }
}

/**
 * Save `text` as the user's copy. The text it replaces (the previous copy, or the
 * owner's spec when there was none) goes onto the undo list. An AI-draft origin is
 * sticky: editing an AI draft does not turn it into the user's own text.
 * Returns false when the browser refused the write.
 */
export function saveUserSpec(
  store: SpecStore | null | undefined,
  key: string,
  text: string,
  replaced: string,
  origin: SpecOrigin,
  now = Date.now(),
): boolean {
  const prev = readUserSpec(store, key);
  const undo = [...(prev?.undo ?? []), replaced].slice(-SPEC_UNDO_CAP);
  const next: UserSpec = { text, origin: prev?.origin === 'ai-draft' ? 'ai-draft' : origin, savedAt: now, undo };
  try {
    if (!store) return false;
    store.setItem(key, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

/** Put back the previous saved text. Returns the new copy, or null if nothing to undo. */
export function undoUserSpec(store: SpecStore | null | undefined, key: string, now = Date.now()): UserSpec | null {
  const prev = readUserSpec(store, key);
  if (!prev || prev.undo.length === 0) return null;
  const undo = prev.undo.slice(0, -1);
  const next: UserSpec = { text: prev.undo[prev.undo.length - 1], origin: prev.origin, savedAt: now, undo };
  try {
    store?.setItem(key, JSON.stringify(next));
    return next;
  } catch {
    return null;
  }
}

/** Drop the user's copy: the owner's spec shows again. */
export function revertUserSpec(store: SpecStore | null | undefined, key: string): boolean {
  try {
    store?.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** The owner's spec, as the loaders return it. */
export type OwnerSpec =
  | { kind: 'per-file' | 'directory'; owner: 'cad' | 'pcb'; path: string; text: string; tracked: boolean | null }
  | { kind: 'none'; owner: 'cad' | 'pcb'; why?: string }
  | { kind: 'withheld'; owner: 'cad' | 'pcb'; path: string; why: string }
  | { kind: 'error'; owner: 'cad' | 'pcb'; why: string };

/**
 * The label above the text. 🔴 The only sentence that says WHOSE text is on screen —
 * tested, because an AI text labelled as cad's is the failure this whole panel refuses.
 */
export function sourceLabel(owner: OwnerSpec, user: UserSpec | null): string {
  if (user) {
    return user.origin === 'ai-draft'
      ? `Your copy, started from an AI draft — not from ${owner.owner}, check it (saved in this browser)`
      : 'Your edited copy (saved in this browser)';
  }
  switch (owner.kind) {
    case 'per-file':
      return `From ${owner.owner}: ${owner.path}${owner.tracked === false ? ` (not yet committed by ${owner.owner})` : ''}`;
    case 'directory':
      return `From ${owner.owner}: ${owner.path} — the directory's spec, not written for this one design`;
    case 'withheld':
      return `${owner.owner}'s spec ${owner.path} is not shown: ${owner.why}`;
    case 'error':
      return `${owner.owner}'s spec could not be read: ${owner.why}`;
    case 'none':
      return owner.why ? `No specification from ${owner.owner}: ${owner.why}` : `No specification yet — ${owner.owner} was asked (${SPEC_TICKET})`;
  }
}

/** The owner's text, or '' when there is none. */
export function ownerText(owner: OwnerSpec): string {
  return owner.kind === 'per-file' || owner.kind === 'directory' ? owner.text : '';
}
