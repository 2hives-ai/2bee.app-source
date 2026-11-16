// The three-step surface's decisions: which machine a design goes to, and what
// a human must do at that machine before anything is sent.
//
// Founder 2026-10-14 (verbatim in AGENTS.md § Scope): *"1) user picks an
// existing design (3d or cnc) 2) user can change it with AI 3) User can send it
// to the printer and let the user know what configuration/tool setup, etc
// needed to make it happen (e.g. tool change, put in the plywood panel, clean
// up the 3d printer bed); make simple as possible"*.
//
// Pure functions only, so every line the user reads is unit-tested.
//
// 🔴 A CHECKLIST LINE IS A PHYSICAL INSTRUCTION. Each one is either derived
// from a measured fact (the design's own size, the printer profile's printable
// volume) or says plainly that the fact is not known yet. None of them is
// invented to make the list look complete. The router's work area is NOT used
// here, because the repo holds two numbers for it (core default 600x900,
// `hardware/cad/2bee_cnc_table/README.md` "~670x1250"). The CNC planner checks
// fit against the machine it is given. This file does not choose one.

import type { ShopEntry } from '../shop/catalogue';

export type Machine = 'printer' | 'router';

/**
 * The machine follows from the design. The user is never asked.
 *
 * Keyed on the PATH suffix, the same rule `scripts/build-shop-catalogue.ts`
 * uses to write `kind` (`_3d` / `_wcnc` / `_acnc`), not on the display string,
 * so a reworded label cannot silently move a design to the other machine.
 * Anything else (models, assemblies, board stand-ins) is not one job on one
 * machine and returns `null`.
 */
export function machineFor(path: string): Machine | null {
  if (/_3d\.scad$/.test(path)) return 'printer';
  // `_wcnc` only. `_acnc` is ALUMINIUM (hardware/cad/NAMING.md): flat bar, cut and drilled on a
  // drill press. It went to the wood router as plywood until 2026-10-15 (journey test), so an
  // aluminium part was planned with a wood material and a wood cutter. It is not a job this
  // router runs, so it is not offered here at all.
  if (/_wcnc\.scad$/.test(path)) return 'router';
  return null;
}

/** Only designs that are one job on one machine appear in step 1. */
export function makeable(entries: readonly ShopEntry[]): ShopEntry[] {
  return entries.filter((e) => machineFor(e.path) !== null);
}

export const MACHINE_NAME: Readonly<Record<Machine, string>> = {
  printer: 'Bambu Lab X2D printer',
  router: '2bee CNC router',
};

/**
 * X2D printable volume, from OrcaSlicer's own machine profile
 * (`resources/profiles/BBL/machine/Bambu Lab X2D 0.4 nozzle.json`):
 * `printable_area` 0x0..256x256, `printable_height` 261. The second extruder's
 * area is narrower (`extruder_printable_area` starts at x=20.5, height 256), so
 * the single-extruder figure is the upper bound, not a promise for both.
 */
export const X2D_VOLUME_MM: readonly [number, number, number] = [256, 256, 261];

export type Fit = 'fits' | 'too-big' | 'unknown';

/** Does a box fit the volume in SOME orientation (axis swaps only)? */
export function fitsVolume(size: readonly number[] | null, volume: readonly number[]): Fit {
  if (!size || size.length !== 3 || size.some((v) => !Number.isFinite(v) || v <= 0)) return 'unknown';
  const a = [...size].sort((x, y) => x - y);
  const b = [...volume].sort((x, y) => x - y);
  return a.every((v, i) => v <= b[i]) ? 'fits' : 'too-big';
}

/**
 * A flat CNC part's workpiece: thickness is its SMALLEST dimension and the
 * footprint the other two. The catalogue's `sizeMm` is in the model's own
 * orientation, which for several `_wcnc` files is standing on edge
 * (`2bee_hive_box_panel_wcnc.scad` measures `[19, 407, 80]`), so the axes cannot
 * be read off by position.
 */
export function workpieceOf(size: readonly number[] | null): { thickness: number; footprint: [number, number] } | null {
  if (!size || size.length !== 3 || size.some((v) => !Number.isFinite(v) || v <= 0)) return null;
  const [t, a, b] = [...size].sort((x, y) => x - y);
  return { thickness: t, footprint: [b, a] };
}

const mm = (v: number) => (Math.round(v * 10) / 10).toString();

export interface SetupStep {
  /** What the person does, in the imperative. */
  text: string;
  /** Why, or where the number came from. Shown small. */
  why: string;
}

/** What a human must do at the machine before this design is sent. */
export function setupChecklist(e: Pick<ShopEntry, 'path' | 'sizeMm' | 'trust'>): SetupStep[] {
  const m = machineFor(e.path);
  const steps: SetupStep[] = [];
  if (m === 'printer') {
    steps.push(
      { text: 'Clean the build plate and check it is the Textured PEI plate.', why: 'Grease or dust on the plate is the usual reason a first layer does not stick.' },
      { text: 'Check the filament loaded is the one the job names.', why: 'The job is sliced for one material. Another material needs other temperatures.' },
      { text: 'Clear the build plate of anything left from the last print.', why: 'The nozzle crashes into whatever is on the plate.' },
      { text: 'Watch the first layer go down.', why: 'Most failed prints show it in the first layer. Nothing from this app has printed yet.' },
    );
  } else if (m === 'router') {
    const wp = workpieceOf(e.sizeMm);
    steps.push(
      wp
        ? {
            text: `Put in the workpiece: ${mm(wp.thickness)} mm thick, at least ${mm(wp.footprint[0])} × ${mm(wp.footprint[1])} mm, with room for clamps.`,
            why: 'Thickness and footprint come from the design itself (its smallest dimension, then the other two).',
          }
        : { text: 'Put in the workpiece the design needs.', why: 'The design has no measured size, so no workpiece size can be given.' },
      { text: 'Clamp the workpiece outside the cut area.', why: 'Clamps are not declared for this design, so nothing has checked the cutter path against them.' },
      { text: 'Fit the cutter the job names, and check it is tight in the collet.', why: 'The cutter is chosen when the job is planned.' },
      { text: 'Set zero where the job says, then stand at the machine with a hand near the stop button.', why: 'Nothing from this app has cut anything yet.' },
    );
  }
  if (m && e.trust !== 'trusted') {
    steps.unshift({
      text: 'Check the picture matches the part you expect. Some of this design could not be read, so pieces may be missing.',
      why: 'Anything missing from the picture is missing from the job too. Details: Expert tools → Designs.',
    });
  }
  return steps;
}

/**
 * A part that cannot be made on its machine at all. Shown as a refusal, never as a
 * checklist line: a box the user can tick is not how "this does not fit" should read
 * (it was one until 2026-10-15). `size` is the design AS IT STANDS, after any AI change.
 */
export function fitBlocker(path: string, size: readonly number[] | null): string | null {
  if (machineFor(path) !== 'printer') return null;
  if (fitsVolume(size, X2D_VOLUME_MM) !== 'too-big') return null;
  return `This part (${size!.map(mm).join(' × ')} mm) does not fit the X2D in any orientation (printable volume 256 × 256 × 261 mm, from the X2D machine profile). Split it or print it elsewhere.`;
}

/**
 * Why the Send button cannot send yet, or `null` once it can.
 *
 * 🔴 STATED, NOT HIDDEN. A Send button that pretends to work, or that quietly
 * hands the job to an expert tab, would be the exact failure this lane refuses.
 */
export function sendBlocker(m: Machine): string | null {
  if (m === 'printer') {
    return 'Not yet. This step does not slice or send yet. The 3d tab slices with 2bee.fdm, this app’s own engine, which has not printed yet, and only uploads to the X2D.';
  }
  return 'Not yet. The router has never run a program from this app. The first runs are an air cut, then a test panel, with an operator at the machine.';
}
