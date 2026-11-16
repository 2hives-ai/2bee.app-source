// Which evaluation a caller gets: the PICTURE or the FILE A MACHINE READS.
//
// 2026-11-12. 2bee.cad's `File → Export STL` (and Save into the drawings list,
// which the cnc tab cuts) wrote the PREVIEW: `$preview` true. A source may draw
// display-only geometry under `if ($preview)` — `cnc_gland_plate_3d.scad:345`
// adds 13 mm connector stubs that way — so the exported file was 12 parts and
// 17 mm tall where OpenSCAD's own `-o stl` gives 1 part and 4 mm. A plausible
// wrong part, written to the operator's disk.
//
// 🔴 RULE: every path that WRITES A FILE FOR A MACHINE (an STL, a drawings
// record the cnc tab sections, a print job, a router plan, a size the setup
// checklist states) evaluates with `render: true`. The on-screen viewport stays
// a preview, as OpenSCAD's F5 does. The two are named here so a caller states
// which one it wants instead of omitting an option and getting the picture.

import { parseScad, type ScadOptions, type ScadResult } from './scad';
import { meshScene, type MeshIssue, type MeshResult } from './mesh';
import { buildCadRecord, type CadBuild } from './record';

export type Purpose = 'view' | 'machine';

/** The parser options for a purpose. `machine` ⇒ `render: true` (`$preview` false, fine `$fa`/`$fs`). */
export function scadOptionsFor(purpose: Purpose, opts: Omit<ScadOptions, 'render'> = {}): ScadOptions {
  return { ...opts, render: purpose === 'machine' };
}

// ---------------------------------------------------------------------------
// 🔴 THE RESOLUTION LADDER (2026-11-13).
//
// Building machine files as a RENDER (8e212f9ed9, 74f2160259) gave every curve the
// print resolution ($fa=2/$fs=0.3 at the root, and a source's `$preview ? 24 : 96`
// now picks 96). Eight catalogue designs then exceeded the kernel's 200,000-polygon
// budget in a difference()/union(), so "Open in 3d", the CAD export and the
// catalogue lost them, while their preview was fine.
//
// Each tier keeps `$preview` FALSE, so the SHAPE is always the render's and no
// display-only geometry comes back. Only curve resolution drops:
//   1 print            root $fa=PRINT_FA / $fs=PRINT_FS (the 2026-11-12 behaviour)
//   2 openscad-default root $fa=12 / $fs=2 (a source's own $fn/$fa/$fs still win)
//   3 cap64            + at most 64 fragments per circle, even over the source's $fn
//   4 cap32            + at most 32
// then REFUSE with the kernel's reason.
//
// ⚠ IT STEPS DOWN ONLY ON A BUDGET REFUSAL (`MeshIssue.limit` polygons/work/clock).
// Any other refusal — an empty intersection operand, a text() with no outlines, a
// parse refusal, the depth limit — is the same at every resolution, so on its own it
// is NEVER retried: it is reported as it stands, at the tier it was found.
// A build that carries BOTH still steps down, because the budget one may clear:
// measured 2026-11-13 on autoframe_lid_3d.scad, whose print build refused two
// difference()s for polygons AND a text() with no outlines AND an intersection()
// whose operand was one of those refused differences (a CONSEQUENCE of the budget
// refusal, not an independent one). Requiring "every refusal is budget" left it at
// print with nothing drawn. The non-budget refusals travel with whichever tier wins.
//
// The tier used is RETURNED and every caller states it (STL note, CAD export, the
// catalogue entry): a coarser part is a fact about the file, not a detail.
// ---------------------------------------------------------------------------

import { RESOLUTION_SAYS, type Resolution } from './resolution';
export { resolutionSentence, type Resolution } from './resolution';

/** What a machine-build caller may pass: never the resolution, which only the ladder chooses. */
export type MachineOpts = Omit<ScadOptions, 'render' | 'renderFaFs' | 'maxFragments'>;

export interface ResolutionTier {
  resolution: Resolution;
  opts: Pick<ScadOptions, 'renderFaFs' | 'maxFragments'>;
  /** One clause for a note: what this tier draws curves at. */
  says: string;
}

const OPENSCAD_DEFAULT = { fa: 12, fs: 2 };

export const RESOLUTION_LADDER: readonly ResolutionTier[] = [
  { resolution: 'print', opts: {}, says: RESOLUTION_SAYS.print },
  { resolution: 'openscad-default', opts: { renderFaFs: OPENSCAD_DEFAULT }, says: RESOLUTION_SAYS['openscad-default'] },
  { resolution: 'cap64', opts: { renderFaFs: OPENSCAD_DEFAULT, maxFragments: 64 }, says: RESOLUTION_SAYS.cap64 },
  { resolution: 'cap32', opts: { renderFaFs: OPENSCAD_DEFAULT, maxFragments: 32 }, says: RESOLUTION_SAYS.cap32 },
];

/** The refusals that a coarser resolution may bring under budget. */
const BUDGET_LIMITS: ReadonlySet<NonNullable<MeshIssue['limit']>> = new Set(['polygons', 'work', 'clock']);

/** The build's budget refusals, or `null` when it must NOT step down (it has none — other refusals do not count). */
export function budgetRefusals(_parse: ScadResult, mesh: MeshResult): MeshIssue[] | null {
  const budget = mesh.issues.filter((i) => i.severity === 'refused' && i.limit !== undefined && BUDGET_LIMITS.has(i.limit));
  return budget.length > 0 ? budget : null;
}

/**
 * The scene as JSON with every `Facets` reduced to what the mesher actually draws from it: a positive finite `$fn`
 * is its ceil'd count and `$fa`/`$fs` are dropped (they are not read on that path); a non-finite `$fn` is its own
 * token (OpenSCAD's "no answer" = 3), and non-finite numbers anywhere are spelled out, not collapsed to `null`.
 * Two scenes with the same print mesh identically.
 */
export function tessellationPrint(scene: unknown): string {
  return JSON.stringify(scene, (_k, v: unknown) => {
    if (typeof v === 'number' && !Number.isFinite(v)) return `#${String(v)}`;
    if (v && typeof v === 'object' && 'fn' in v && 'fa' in v && 'fs' in v) {
      const fn = (v as { fn: number | null }).fn;
      if (fn !== null && Number.isFinite(fn) && fn > 0) return { ...v, fn: Math.ceil(fn >= 3 ? fn : 3), fa: '-', fs: '-' };
    }
    return v;
  });
}

export interface MachineEvaluation {
  source: string;
  parse: ScadResult;
  mesh: MeshResult;
  /** The tier whose parse/mesh these are. */
  resolution: Resolution;
  /** Every tier tried, in order, with the kernel reason that made it step down. */
  tried: { resolution: Resolution; steppedDownBecause: string | null; meshed: boolean }[];
  /** Non-null ⇒ even the last tier ran out of budget: the kernel's reason. The caller REFUSES. */
  exhausted: string | null;
}


/**
 * One evaluated source for a machine: the parse and the mesh, `$preview` false, at the finest
 * tier of the resolution ladder that fits the kernel's budget. See the ladder note above.
 *
 * `ladder` exists for the negative control (a ladder that retries everything); callers never pass it.
 */
export function evaluateForMachine(
  source: string,
  opts: MachineOpts = {},
  ladder: { tiers?: readonly ResolutionTier[]; stepDown?: typeof budgetRefusals } = {},
): MachineEvaluation {
  const tiers = ladder.tiers ?? RESOLUTION_LADDER;
  const stepDown = ladder.stepDown ?? budgetRefusals;
  const tried: MachineEvaluation['tried'] = [];
  let prev: { print: string; mesh: MeshResult } | null = null;
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    // The tier's options REPLACE any resolution a caller smuggled in (the type forbids it; this enforces it).
    const parse = parseScad(source, { ...scadOptionsFor('machine', opts), renderFaFs: undefined, maxFragments: undefined, ...tier.opts });
    /* ⚠ A TIER THAT CHANGES NOTHING IS NOT MESHED AGAIN. A source whose every curve carries its own `$fn` at or below
     * 64 (schools_kit_lib.scad: `$fn = $preview ? 20 : 56`) parses to the SAME tessellation at print,
     * openscad-default and cap64, and the mesher is deterministic in its scene (the work budget is a count, not a
     * clock), so re-meshing it would spend the same minutes to reach the same refusal. Equal fingerprint ⇒ the
     * previous mesh IS this tier's mesh. Any difference at all — including a source that reads `$fn`/`$fa` into
     * its own coordinates — changes the fingerprint and is meshed. */
    const print = tessellationPrint(parse.scene);
    const same = prev !== null && prev.print === print;
    const mesh: MeshResult = same ? prev!.mesh : meshScene(parse.scene);
    prev = { print, mesh };
    const budget = stepDown(parse, mesh);
    tried.push({ resolution: tier.resolution, steppedDownBecause: budget ? budget[0].detail : null, meshed: !same });
    if (!budget) return { source, parse, mesh, resolution: tier.resolution, tried, exhausted: null };
    if (i === tiers.length - 1) {
      tried[tried.length - 1].steppedDownBecause = null;
      return {
        source,
        parse,
        mesh,
        resolution: tier.resolution,
        tried,
        exhausted: `${budget[0].name} (line ${budget[0].line}): ${budget[0].detail}`,
      };
    }
  }
  throw new Error('the resolution ladder has no tiers');
}

/**
 * The drawings record / STL a machine will read, built from `source` evaluated
 * as a RENDER. A throw from the parser or mesher is a REFUSAL in the record
 * builder's own shape, never a file.
 */
export function buildMachineRecord(args: {
  name: string;
  source: string;
  opts?: MachineOpts;
  now: number;
}): MachineBuild {
  let ev: MachineEvaluation;
  try {
    ev = evaluateForMachine(args.source, args.opts);
  } catch (e) {
    return {
      ok: false,
      // A throw is not a budget refusal, so the ladder never stepped down: it came from the first tier.
      resolution: 'print',
      refusal: {
        headline: 'The model could not be built for the file',
        detail: `the reader failed on this source: ${e instanceof Error ? e.message : String(e)}. Nothing was written.`,
      },
    };
  }
  return machineRecordFrom(ev, args.name, args.now);
}

/** A machine build's record + the tier it was built at. Exhausted ladder ⇒ REFUSED with the kernel's reason. */
export type MachineBuild = CadBuild & { resolution: Resolution };

/** The record for an evaluation already made (the viewer worker lays the mesh flat between the two). */
export function machineRecordFrom(ev: MachineEvaluation, name: string, now: number, mesh: MeshResult = ev.mesh): MachineBuild {
  if (ev.exhausted !== null) {
    return {
      ok: false,
      resolution: ev.resolution,
      refusal: {
        headline: 'The model is too large for the in-browser kernel at every resolution',
        detail:
          `tried ${ev.tried.map((t) => t.resolution).join(', ')}; the last still refused: ${ev.exhausted}. ` +
          'Nothing was written.',
      },
    };
  }
  return { ...buildCadRecord({ name, source: ev.source, parse: ev.parse, mesh, now }), resolution: ev.resolution };
}

/**
 * What the catalogue states about a design for a machine: drawable part count,
 * overall size (mm, 0.1 rounding) and the mesh audit's trust — from the RENDER.
 * `null` when the render draws nothing.
 */
export function machineMeasure(
  source: string,
  opts: MachineOpts = {},
):
  | { parts: number; sizeMm: [number, number, number] | null; trust: MeshResult['trust']; trustDetail: string; resolution: Resolution; exhausted: null; budgetRefused: string | null }
  | { exhausted: string; resolution: Resolution }
  | null {
  const { mesh, resolution, exhausted } = evaluateForMachine(source, opts);
  const drawable = mesh.parts.filter((p) => p.positions.length > 0);
  /* An exhausted ladder that still DRAWS is measured, as every partial build was before the ladder: its refusals
   * are in `trust`/`trustDetail` (never `trusted`) and `resolution` says cap32. The catalogue lists a picture with
   * its verdict; it does not write a machine file, which is where an exhausted ladder REFUSES (buildMachineRecord,
   * print job, router plan). Only an exhausted ladder that draws nothing is reported as the kernel's refusal. */
  if (drawable.length === 0) return exhausted !== null ? { exhausted, resolution } : null;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of drawable) {
    if (!p.bounds) continue;
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], p.bounds.min[a]);
      hi[a] = Math.max(hi[a], p.bounds.max[a]);
    }
  }
  const sizeMm = Number.isFinite(lo[0])
    ? ([0, 1, 2].map((a) => Math.round((hi[a] - lo[a]) * 10) / 10) as [number, number, number])
    : null;
  return { parts: drawable.length, sizeMm, trust: mesh.trust, trustDetail: mesh.trustDetail, resolution, exhausted: null, budgetRefused: exhausted };
}
