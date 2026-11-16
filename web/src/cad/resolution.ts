// The resolution-ladder tier a MACHINE build was made at — the vocabulary only.
//
// The ladder itself is `cad/machine.ts`. This file holds the names and the one
// sentence a caller shows, with NO value import of the parser or the mesher, so
// a main-thread module (`shop/toCnc.ts`, the catalogue types) can state the tier
// without pulling the CAD kernel into its chunk.

/**
 * `print`            root `$fa`/`$fs` at scad.ts `PRINT_FA`/`PRINT_FS` (the fine render)
 * `openscad-default` root `$fa=12`/`$fs=2` (a source's own `$fn`/`$fa`/`$fs` still win)
 * `cap64` / `cap32`  additionally at most 64 / 32 fragments per circle, overriding even the source's `$fn`
 */
export type Resolution = 'print' | 'openscad-default' | 'cap64' | 'cap32';

/** The tiers in ladder order. `cad/machine.ts`'s RESOLUTION_LADDER is checked against this (tests). */
export const RESOLUTION_ORDER: readonly Resolution[] = ['print', 'openscad-default', 'cap64', 'cap32'];

/** One clause per tier: what it draws curves at. */
export const RESOLUTION_SAYS: Readonly<Record<Resolution, string>> = {
  print: 'print resolution (root $fa=2, $fs=0.3)',
  'openscad-default': "OpenSCAD's default resolution (root $fa=12, $fs=2)",
  cap64: "at most 64 segments per circle, overriding the source's own $fn",
  cap32: "at most 32 segments per circle, overriding the source's own $fn",
};

/** The sentence a note carries about the tier, or `''` for `print` (nothing to disclose). */
export function resolutionSentence(r: Resolution): string {
  if (r === 'print') return '';
  return (
    `Built at a COARSER resolution — ${RESOLUTION_SAYS[r]} — because the finer one exceeded the in-browser ` +
    "kernel's polygon budget. The shape is the render's; its curves have fewer, larger flats."
  );
}
