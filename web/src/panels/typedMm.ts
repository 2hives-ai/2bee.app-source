/**
 * typedMm — parse a string as millimetres, returning undefined for blanks.
 *
 * Extracted from App.tsx. Used by spoilboard config and other numeric fields
 * where an empty string means "not declared" (not zero).
 *
 * ⚠ STRING, and this is the one field where the string/number distinction is
 * a safety property rather than a convention. `Number('')` is `0`; a board
 * `0mm` thick is not a board nobody measured, and the difference is between a
 * question left open and a question answered favourably by accident.
 */
export function typedMm(s: string): number | undefined {
  const t = s.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}
