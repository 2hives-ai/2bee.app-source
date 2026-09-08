/**
 * Row ID helpers — pure, no React state.
 *
 * Extracted from App.tsx to reduce file size.
 * These functions handle picker row identification for merged lists.
 */

import type { DrawingOrigin } from '../store';

/**
 * Build a merged-list row id from a surface prefix and a name.
 *
 * The surface is the LIST the row came from (`preset`, `sample`, `saved`,
 * `mesh-sample`, …) and the name is the row's own id inside that list.
 * The colon separator is chosen because it is the character the picker's
 * search box will never need to escape, and every other separator collides
 * with a character a drawing name or a machine name already contains.
 *
 * `'file'` is a legal origin here and deliberately resolves to an id NO ROW
 * CARRIES: a drawing opened from disk and not saved is not in any list, and the
 * picker showing nothing selected is the honest rendering of that.
 */
export function rowId(surface: string, name: string): string {
  return `${surface}:${name}`;
}

/**
 * Split a merged-list row id, refusing any surface not in `kinds`.
 *
 * ⚠ `indexOf`, not `split` — a name may legitimately contain a colon and only
 * the FIRST one is the separator. `split(':')[1]` would silently truncate such a
 * name and resolve to no row, which reads as a dead click.
 */
export function parseRowId(id: string, kinds: string[]): { kind: string; name: string } | null {
  const at = id.indexOf(':');
  if (at < 0) return null;
  const kind = id.slice(0, at);
  return kinds.includes(kind) ? { kind, name: id.slice(at + 1) } : null;
}

export function drawingRowId(origin: DrawingOrigin, name: string): string {
  return rowId(origin, name);
}

/** The drawing surfaces that HAVE a row. `'file'` deliberately does not. */
export function parseDrawingRowId(id: string): { origin: DrawingOrigin; name: string } | null {
  const p = parseRowId(id, ['sample', 'mesh-sample', 'saved']);
  return p ? { origin: p.kind as DrawingOrigin, name: p.name } : null;
}
