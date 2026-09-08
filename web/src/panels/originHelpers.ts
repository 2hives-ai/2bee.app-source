/**
 * Origin tag helpers — pure, no React state.
 *
 * Extracted from App.tsx to reduce file size.
 * These functions build the SHIPPED / YOURS tags and provenance properties
 * for merged picker lists.
 */

import type { ObjectProperty } from '../ObjectPicker';

export const SHIPPED_TAG = 'SHIPPED';
export const YOURS_TAG = 'YOURS';

export function shipped(provenance: string): { tag: string; prop: ObjectProperty } {
  return {
    tag: SHIPPED_TAG,
    prop: {
      label: 'Where this came from',
      value: `Shipped with this build — ${provenance}`,
    },
  };
}

export function yours(savedAt: number): { tag: string; prop: ObjectProperty } {
  return {
    tag: YOURS_TAG,
    prop: {
      label: 'Where this came from',
      // ⚠ Says what is NOT known, not just what is. "Saved by you" alone reads
      // as a provenance; the absence of one is the fact that matters next to a
      // shipped row that has a supplier page and a date on it.
      value:
        `YOU saved this in THIS browser on ${new Date(savedAt).toLocaleString()}. ` +
        `Nothing was measured or sourced for it, nobody checked it, and clearing ` +
        `site data deletes it — there is no server copy.`,
    },
  };
}
