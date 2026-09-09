// A 2bee.cad model, as it is written into the DRAWINGS collection.
//
// Founder, 2026-08-10: *"in the 1st tab (cad) we should able to save the cad
// files in the same list as drawings"*. This file is what makes that a saving
// of a PART rather than a saving of a file: it decides what travels, what is
// refused, and what a reader can check for itself when the record is picked up
// again days later by the tab that cuts things.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS STORED, AND WHY IT IS BOTH
// ─────────────────────────────────────────────────────────────────────────────
//
// **Both the SCAD source and the evaluated mesh. The source is the truth; the
// mesh is a CACHE, and it carries a checksum so a reader can tell when it has
// stopped being one.**
//
// The three options and why the other two lose:
//
//   · SOURCE ONLY. The model stays editable, which is right, and the CNC tab
//     cannot use it at all — nothing on that side runs the kernel, and the
//     kernel is 1,500 lines of TypeScript in this tab. A drawing in the drawings
//     list that cannot be cut is a row that looks like a part and is not one.
//   · MESH ONLY. The CNC tab can cut it, and the model is dead: reopening it in
//     `2bee.cad` gives you a triangle soup, not the `difference()` you wrote.
//     The founder's ask is that the two tabs are one app; a save that destroys
//     the design is a save that makes them two.
//   · BOTH. The design survives, the part is cuttable, and there is now a pair
//     that can DISAGREE. That is the cost, and it is paid explicitly below.
//
// 🔴 THE STALENESS SIGNAL IS NOT OPTIONAL AND IS NOT A COMMENT. A cached mesh
// that has drifted from its source is a part cut to a shape the source no longer
// describes — the exact failure this lane exists to prevent, arriving through a
// convenience feature. So the record carries `source_checksum` (of the source
// TEXT THAT WAS EVALUATED) and `stl_checksum` (of the bytes THAT EVALUATION
// PRODUCED), and {@link verifyCadRecord} re-derives both from the record's own
// contents. A record whose source has been edited without re-evaluating, or
// whose bytes have been swapped, reports `stale` and says which half moved.
//
// ⚠ WHAT THE CHECKSUM IS, precisely, so nobody reads more into it than it can
// carry: FNV-1a 32-bit plus the byte length. It detects ACCIDENTAL divergence —
// an edited source with an unrefreshed mesh, a truncated write, a record merged
// in from an export file that was hand-edited. It is NOT a cryptographic digest
// and NOT authentication: anyone who can write the record can write a matching
// checksum. There is no threat model here in which that matters, because the
// store is browser-local and the writer is the user; the thing being defended
// against is a mistake, not an attacker. Saying which one is the point — a
// checksum described as a hash gets quoted as integrity later.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS REFUSED, AND WHY IT IS REFUSED RATHER THAN FLAGGED
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 **A MODEL WHOSE MESH AUDIT DID NOT RETURN `closed` CANNOT BE SAVED AT ALL.**
// Not saved-with-a-warning; refused, by name, with the audit's own sentence.
//
// `mesh.ts` audits every solid it emits — welds it, then checks every edge for
// closure, orientation and manifoldness — and ranks `seams` (the check ran out
// of budget) WITH the failures rather than below them, because a check that
// could not finish is not a check that passed. That verdict is the only thing
// standing between a BSP kernel with three documented failure modes and a
// toolpath. The choice here was between:
//
//   (a) refuse outright, or
//   (b) save it with the verdict attached and show the verdict at the point of
//       use.
//
// (b) is the right answer for a *picture* and is what `preview.tsx` already
// does — an untrustworthy render is still informative, and the person looking
// at it is looking at it. It is the wrong answer for a *part*. The record's
// point of use is the drawings list in the other tab, where it is one row among
// shipped samples, days later, chosen by someone who may not have drawn it; the
// warning is a paragraph in a properties panel and the consequence is a
// non-manifold solid handed to a sectioner. A shape with no defensible inside
// still sections into a closed-looking outline, which still posts, still
// simulates and still cuts — a plausible wrong part, with no symptom until it
// is on the bed. The audit verdict is most actionable at the moment the user is
// looking at it in the CAD tab with the source in front of them, so that is
// where the refusal is spent.
//
// ⚠ THE BOUNDARY OF THAT RULE, stated so it is not read as "refuse anything
// imperfect": a REFUSED CONSTRUCT is NOT a refused save. See below.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT TRAVELS INSTEAD OF BEING REFUSED
// ─────────────────────────────────────────────────────────────────────────────
//
// `parseScad` reports constructs outside the subset BY NAME AND LINE, and they
// contribute NOTHING to the tree. A model saved while `minkowski()` was refused
// is a model MISSING A FEATURE — and it is still a real, closed, manifold
// solid, which somebody may perfectly well intend to cut. Refusing the save
// would block legitimate work over a language gap; hiding it would ship a part
// with a feature silently absent.
//
// So every refusal travels IN the record — `unsupported` (the parser's, by name
// and line), `issues` (the mesher's refusals and warnings), `parse_errors`, and
// a single `complete` flag that is false if any of them is a refusal. And
// {@link describeCadRecord} puts it FIRST in the properties, above the numbers,
// so it is read at selection time in the other tab — not only at save time,
// when the user already knows.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND THE THING THAT IS TRUE OF EVERY MESH IN THIS APP
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 The CNC side is 2.5D. It takes this STL and cuts **ONE FLAT SECTION** of it
// at a single Z. It does not cut the solid. That is the standing scope rule of
// the whole lane (`AGENTS.md`: *"an STL import does NOT widen this scope"*), and
// the failure it guards is not a crash — it is a user who models a part, saves
// it here, picks it in the CNC tab and receives a section, which plans, posts,
// gates green and cuts a plausible-looking wrong part. The record therefore
// carries `z_span_mm` and `mid_height_z_mm` the way `MESH_SAMPLES` does, and
// every description this file emits says the word *section*.
//
// Units are millimetres throughout, as everywhere else in this lane.

import type { MeshResult, MeshPart, PartVerdict } from './mesh';
import type { ScadResult } from './scad';

/** Written into every record so a reader can refuse one it does not understand. */
export const CAD_RECORD_KIND = '2bee.cad model';

/**
 * Bump when a field is renamed, changes units, or changes MEANING.
 *
 * ⚠ The same residual the session blob names applies here and is not papered
 * over: nothing enforces this, and a schema change that forgets it is a stored
 * record reinterpreted field-for-field by a build that means something else by
 * the same key. What limits the damage is that {@link verifyCadRecord} refuses
 * an unknown version outright rather than reading the fields it recognises.
 */
export const CAD_RECORD_VERSION = 1;

/** A refusal or a warning, from either the parser or the mesher, verbatim. */
export interface CadNote {
  /** `refused` ⇒ it contributed NOTHING. `warning` ⇒ something was produced and
   *  may be wrong. The distinction is the same one `MeshIssue` draws and it is
   *  preserved rather than flattened into "problems". */
  severity: 'refused' | 'warning';
  /** By its own name — `minkowski()`, `difference()`, `$fa`. */
  name: string;
  /** 1-based source line. */
  line: number;
  detail: string;
}

/** A syntax/evaluation failure, carried through unchanged from `ScadResult`. */
export interface CadParseError {
  line: number;
  message: string;
}

/** Everything about the model that is not its bytes. */
export interface CadPayload {
  kind: typeof CAD_RECORD_KIND;
  version: number;

  /**
   * 🔴 THE TRUTH. The exact source text that was evaluated to produce `bytes` —
   * not "the source at the time of saving", which is a different string whenever
   * the mesh is a keystroke behind the editor.
   */
  source: string;
  /** Of `source`. See the header: a checksum against accident, not a digest. */
  source_checksum: string;
  /** Of `bytes`. Both halves are checked, because either can be the one that moved. */
  stl_checksum: string;
  /** Millis, stamped by the caller so a test can control it. */
  evaluated_at: number;

  /** Solids written into the STL. Top-level siblings are NOT unioned — see
   *  `meshScene` — so this is a count of separate closed surfaces in one file. */
  solids: number;
  triangles: number;
  /**
   * 2D shapes present in the model and NOT written. A `square()` or `circle()`
   * has no volume; an STL of a zero-thickness plate sections to nothing at every
   * Z but one, where it sections to a degenerate outline. Dropping them is right
   * and is COUNTED, because "the part I drew had a circle in it and the file
   * does not" is exactly the kind of absence nobody notices.
   */
  flats_dropped: number;

  /** The WORST verdict across the solids written. Only `closed` can be saved —
   *  the field exists so the record states what was checked, not so it can vary. */
  verdict: PartVerdict;
  /** The audit's own sentence for that verdict, unparaphrased. */
  audit_detail: string;

  /** False ⇒ at least one construct was REFUSED and is missing from the solid. */
  complete: boolean;
  /** The parser's refusals, by name and line. Always `severity: 'refused'`. */
  unsupported: CadNote[];
  /** The mesher's refusals and warnings. */
  issues: CadNote[];
  /** Syntax/evaluation failures. Not refusals — a refusal is understood. */
  parse_errors: CadParseError[];

  /** `[min, max]` over the written triangles. The CNC tab sections INSIDE this. */
  z_span_mm: [number, number];
  /** The midpoint. Named the way `MESH_SAMPLES` names it: a guess about intent,
   *  not a default that is right. The core chooses this when given no Z. */
  mid_height_z_mm: number;
}

/**
 * What goes into the `drawings` collection.
 *
 * 🔴 THE FIRST THREE FIELDS ARE THE ORDINARY SAVED-DRAWING SHAPE, DELIBERATELY.
 * `App.tsx` resolves a `'saved'` row by spreading the stored record into a
 * loaded drawing (`{ ...rec.data, name, origin: 'saved', … }`) and handing
 * `bytes` + `format` to the core. A CAD model is therefore a saved drawing that
 * happens to carry `cad` as well — which means the existing load path, the
 * existing session restore and the existing planner call all work on it with no
 * change at all. Anything that made this a fourth shape would need a fourth
 * branch in each of them, and a branch is where a divergence lives.
 */
export interface SavedCadDrawing {
  /** Binary STL of the evaluated solids. The CACHE. */
  bytes: Uint8Array;
  /** Always `'stl'`. Not `'auto'`: we know what we wrote, and `'auto'` is a
   *  REQUEST to the core to measure the file, which is the right thing for a
   *  file somebody dragged in and a needless question about one we produced. */
  format: 'stl';
  name: string;
  cad: CadPayload;
}

// ---------------------------------------------------------------------------
// Checksum
// ---------------------------------------------------------------------------

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a 32-bit over bytes, rendered with the length.
 *
 * ⚠ A CHECKSUM. See the header: it answers *"are these the same bytes?"* against
 * accident, and nothing else. The length is included because it is free and
 * because a truncation is the single most likely accidental corruption, and a
 * truncation that happens to collide on 32 bits still cannot collide on length.
 */
export function checksumBytes(bytes: Uint8Array): string {
  let h = FNV_OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, FNV_PRIME);
  }
  return `fnv1a32:${(h >>> 0).toString(16).padStart(8, '0')}:${bytes.length}`;
}

/** The same, over the UTF-8 encoding of a string. Encoded rather than iterated
 *  by code unit, so a source containing non-ASCII checksums to the same value
 *  as the bytes any other tool would read from the same file. */
export function checksumText(text: string): string {
  return checksumBytes(new TextEncoder().encode(text));
}

// ---------------------------------------------------------------------------
// Binary STL
// ---------------------------------------------------------------------------

/** 80-byte header + a `u32` triangle count. Same constants the sample loader uses. */
const STL_HEADER_BYTES = 84;
/** 12 floats + a 2-byte attribute count. */
const STL_TRI_BYTES = 50;

/**
 * Pack solids into one binary STL.
 *
 * 🔴 ONE FILE, ALL SOLIDS, AND THAT IS WHAT AN STL IS. The format has no notion
 * of separate bodies — it is a triangle soup — so several closed surfaces in one
 * file is the normal case, not a compromise. It is also what the CNC side
 * already handles: the shipped `Schools-kit solar plate` sample sections into
 * TWO outlines, and the planner treats them as two parts. What a reader must not
 * conclude is that they were unioned; they were not (see `meshScene`), and a
 * count is carried in the record so the number is stated rather than inferred.
 *
 * ⚠ THE HEADER DOES NOT START WITH `solid`. Some readers sniff a leading
 * `solid` and take the file for ASCII. Ours does not — the core decides by
 * measuring the length against `84 + 50n` — but a file we emit may be saved out
 * and opened elsewhere, and a header that makes a third-party reader guess wrong
 * costs nothing to avoid.
 *
 * ⚠ The normal is COMPUTED from the winding rather than left at zero. Zero is
 * legal and means "work it out from the vertex order", which every serious
 * reader does anyway; writing it means a viewer that trusts the normal shades a
 * flat grey blob. For a degenerate triangle the normal genuinely is undefined
 * and zeros are written — the honest value.
 */
export function encodeBinaryStl(
  solids: readonly { positions: Float32Array; triangles: number }[],
  headerNote: string
): Uint8Array {
  let count = 0;
  for (const s of solids) count += s.triangles;

  const out = new Uint8Array(STL_HEADER_BYTES + count * STL_TRI_BYTES);
  const view = new DataView(out.buffer);

  // ASCII only, truncated to fit. A header is 80 bytes whatever you put in it.
  const note = `2bee.cad ${headerNote}`.replace(/[^\x20-\x7e]/g, ' ');
  for (let i = 0; i < Math.min(note.length, 80); i++) out[i] = note.charCodeAt(i);

  view.setUint32(80, count, true);

  let o = STL_HEADER_BYTES;
  for (const s of solids) {
    const p = s.positions;
    for (let t = 0; t < s.triangles; t++) {
      const b = t * 9;
      const ax = p[b], ay = p[b + 1], az = p[b + 2];
      const bx = p[b + 3], by = p[b + 4], bz = p[b + 5];
      const cx = p[b + 6], cy = p[b + 7], cz = p[b + 8];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (l > 0) {
        nx /= l;
        ny /= l;
        nz /= l;
      } else {
        nx = ny = nz = 0;
      }
      view.setFloat32(o, nx, true);
      view.setFloat32(o + 4, ny, true);
      view.setFloat32(o + 8, nz, true);
      view.setFloat32(o + 12, ax, true);
      view.setFloat32(o + 16, ay, true);
      view.setFloat32(o + 20, az, true);
      view.setFloat32(o + 24, bx, true);
      view.setFloat32(o + 28, by, true);
      view.setFloat32(o + 32, bz, true);
      view.setFloat32(o + 36, cx, true);
      view.setFloat32(o + 40, cy, true);
      view.setFloat32(o + 44, cz, true);
      view.setUint16(o + 48, 0, true);
      o += STL_TRI_BYTES;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Building a record
// ---------------------------------------------------------------------------

/** Why a model could not be written, in words a control can print unchanged. */
export interface CadRefusal {
  /** Short enough for a button's disabled reason. */
  headline: string;
  /** The whole sentence, including the audit's own words where there are any. */
  detail: string;
}

export type CadBuild =
  | { ok: true; record: SavedCadDrawing }
  | { ok: false; refusal: CadRefusal };

/** The one verdict a saved model may carry. Ranked as a LIST rather than a
 *  `=== 'closed'` so widening it later is a visible, reviewable edit rather than
 *  a comparison somebody loosens in passing. */
const SAVEABLE_VERDICTS: readonly PartVerdict[] = ['closed'];

function solidsOf(mesh: MeshResult): MeshPart[] {
  return mesh.parts.filter((p) => p.dim === 3 && p.triangles > 0);
}

/** Worst verdict across the written solids, ranked exactly as `meshScene` ranks
 *  it — `seams` WITH the failures, because a check that did not finish is not a
 *  check that passed. Re-derived here rather than read off `mesh.trust`, because
 *  `trust` also folds in refusals and flats, which are carried separately and
 *  must not be able to block a save on their own. */
function worstVerdict(solids: MeshPart[]): { verdict: PartVerdict; detail: string } | null {
  const rank = (x: PartVerdict): number =>
    ({ closed: 0, flat: 1, seams: 2, open: 2, 'non-manifold': 3 })[x];
  let worst: MeshPart | null = null;
  for (const p of solids) {
    if (!p.audit) continue;
    if (!worst || rank(p.audit.verdict) > rank(worst.audit!.verdict)) worst = p;
  }
  return worst ? { verdict: worst.audit!.verdict, detail: worst.audit!.detail } : null;
}

/**
 * Build the record, or refuse and say why.
 *
 * 🔴 `source` MUST be the text `mesh` was evaluated from, and the caller is the
 * only thing that can know that. In `CadTab` the mesh is DEBOUNCED and the parse
 * is not, so `src` and the meshed source differ for 250 ms after every keystroke
 * — and a record built from `src` with a mesh of the previous source would be
 * born stale, with a checksum pair that says so and a user who never saw a
 * warning. The tab refuses to save while the preview is marked STALE, and this
 * function is additionally always fed the meshed source, so the pairing holds
 * even if that guard is ever lost.
 */
export function buildCadRecord(args: {
  name: string;
  /** The source that was evaluated. Not the source in the editor. */
  source: string;
  /** The parse OF THAT SOURCE. */
  parse: ScadResult;
  /** The mesh OF THAT PARSE. */
  mesh: MeshResult;
  now: number;
}): CadBuild {
  const name = args.name.trim();
  if (!name) {
    return {
      ok: false,
      refusal: {
        headline: 'this model needs a name',
        detail:
          'A saved item is keyed by its name, so an unnamed save would be one shared slot every later ' +
          'save silently overwrote.',
      },
    };
  }

  const solids = solidsOf(args.mesh);
  const flats = args.mesh.parts.filter((p) => p.dim === 2).length;

  if (!solids.length) {
    const refused = args.mesh.issues.filter((i) => i.severity === 'refused').length;
    return {
      ok: false,
      refusal: {
        headline: 'there is no solid here to save',
        detail:
          (flats > 0
            ? `This source produced ${flats} 2D shape(s) and no solid. A square or a circle has no ` +
              'thickness and no interior; there is nothing for a machine to have a section of. '
            : 'This source produced no geometry at all. ') +
          (refused > 0
            ? `${refused} construct(s) were REFUSED, so the emptiness may be the refusals rather than ` +
              'the model — check the list below.'
            : 'An empty result means nothing was understood, not that the model is empty.'),
      },
    };
  }

  const worst = worstVerdict(solids);
  if (!worst) {
    // Every 3D part carries an audit by construction; if that ever stops being
    // true the honest answer is a refusal, not an unaudited save.
    return {
      ok: false,
      refusal: {
        headline: 'this model was not audited',
        detail:
          'No solid in this result carries a closure audit. A mesh that has not been checked for closure, ' +
          'orientation and manifoldness cannot be told apart from one that failed, and the CNC tab cannot ' +
          'ask the question again. Nothing was saved.',
      },
    };
  }

  if (!SAVEABLE_VERDICTS.includes(worst.verdict)) {
    return {
      ok: false,
      refusal: {
        headline: `the mesh audit says "${worst.verdict}" — this model cannot go in the drawings list`,
        detail:
          `${worst.detail} ` +
          'This is refused rather than saved with a warning because the drawings list is what the CNC tab ' +
          'cuts from: a solid with holes or with an edge shared by three faces still sections into a ' +
          'closed-looking outline, which still posts and still cuts — a plausible wrong part with no ' +
          /* ⚠ THIS READ "until it is on the bed" until 2026-08-27. `bed` is the term canon S1
             retires: it is ambiguous between the spoilboard (MATERIAL) and the travel envelope
             (REACH), and the sentence meant neither — it meant "until the part has been cut".
             Found by the terminology sweep the same day it stopped being a hand-maintained list
             of ten files and started discovering all 63; this string had never been swept. */
          'symptom until it is cut. Fix the model (flush and coplanar faces between operands are ' +
          'the usual cause — overshoot a cut by a fraction of a millimetre) and save again.',
      },
    };
  }

  const bytes = encodeBinaryStl(solids, name);

  let zMin = Infinity;
  let zMax = -Infinity;
  let triangles = 0;
  for (const s of solids) {
    triangles += s.triangles;
    for (let i = 2; i < s.triangles * 9; i += 3) {
      const z = s.positions[i];
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
    }
  }

  const unsupported: CadNote[] = args.parse.unsupported.map((u) => ({
    severity: 'refused',
    name: u.name,
    line: u.line,
    detail: u.detail,
  }));
  const issues: CadNote[] = args.mesh.issues.map((i) => ({
    severity: i.severity,
    name: i.name,
    line: i.line,
    detail: i.detail,
  }));

  const cad: CadPayload = {
    kind: CAD_RECORD_KIND,
    version: CAD_RECORD_VERSION,
    source: args.source,
    source_checksum: checksumText(args.source),
    stl_checksum: checksumBytes(bytes),
    evaluated_at: args.now,
    solids: solids.length,
    triangles,
    flats_dropped: flats,
    verdict: worst.verdict,
    audit_detail: worst.detail,
    complete:
      unsupported.length === 0 &&
      issues.every((i) => i.severity !== 'refused') &&
      args.parse.errors.length === 0,
    unsupported,
    issues,
    parse_errors: args.parse.errors.map((e) => ({ line: e.line, message: e.message })),
    z_span_mm: [zMin, zMax],
    mid_height_z_mm: (zMin + zMax) / 2,
  };

  return { ok: true, record: { bytes, format: 'stl', name, cad } };
}

// ---------------------------------------------------------------------------
// Reading a record back
// ---------------------------------------------------------------------------

/**
 * Is this stored drawing a CAD model?
 *
 * ⚠ Structural, and deliberately strict about the DISCRIMINATOR rather than
 * about every field. A record written by a future build with extra fields is
 * still a CAD model and should be recognised as one so that
 * {@link verifyCadRecord} gets to refuse it BY VERSION, with a sentence. A
 * looser `('cad' in data)` would accept anything; a stricter full-shape check
 * would make an unknown version look like an ordinary drawing, which is the one
 * outcome that loses the message.
 */
export function isCadRecord(data: unknown): data is SavedCadDrawing {
  const d = data as { cad?: { kind?: unknown } } | null | undefined;
  return !!d && typeof d === 'object' && !!d.cad && d.cad.kind === CAD_RECORD_KIND;
}

export type CadVerification =
  /** Source and mesh agree, and this build understands the schema. */
  | { status: 'ok' }
  /** Ours, written by a schema this build does not read. Trust nothing in it. */
  | { status: 'incompatible'; why: string }
  /**
   * 🔴 The cache has drifted from its source. The bytes are NOT known to be an
   * evaluation of the source stored beside them, and the CNC tab would cut the
   * bytes.
   */
  | { status: 'stale'; why: string };

/**
 * Re-derive both checksums from the record's own contents.
 *
 * 🔴 This is the whole reason a cache was allowed at all. It answers the one
 * question a reader cannot answer by looking: *does this mesh still belong to
 * this source?* It does NOT re-run the kernel and cannot tell you whether the
 * mesh is a CORRECT evaluation — only whether it is an evaluation of THIS text.
 * Saying which is which matters: "verified" would be read as the stronger claim.
 */
export function verifyCadRecord(rec: SavedCadDrawing): CadVerification {
  const c = rec.cad;
  if (c.version !== CAD_RECORD_VERSION) {
    return {
      status: 'incompatible',
      why:
        `this model was written by a different version of the app (stored ${c.version}, this build ` +
        `reads ${CAD_RECORD_VERSION}). Nothing in it is read: a field taken out of a schema this build ` +
        'does not understand is a wrong value wearing a right label.',
    };
  }
  const src = checksumText(c.source);
  const stl = checksumBytes(rec.bytes);
  if (src !== c.source_checksum && stl !== c.stl_checksum) {
    return {
      status: 'stale',
      why:
        'BOTH halves of this model have changed since it was saved — the source no longer checksums to ' +
        `${c.source_checksum} and the mesh no longer checksums to ${c.stl_checksum}. The record is not ` +
        'internally consistent and the mesh cannot be treated as an evaluation of the source stored with it.',
    };
  }
  if (src !== c.source_checksum) {
    return {
      status: 'stale',
      why:
        'the SOURCE has changed since this mesh was evaluated from it. The stored mesh is an evaluation ' +
        'of a different text, so cutting it would cut a shape the stored source no longer describes. ' +
        'Open it in 2bee.cad and save it again.',
    };
  }
  if (stl !== c.stl_checksum) {
    return {
      status: 'stale',
      why:
        'the MESH has changed since it was written — it no longer checksums to the value recorded beside ' +
        'it. The bytes were not produced by the evaluation this record describes, and what they are is ' +
        'not known.',
    };
  }
  return { status: 'ok' };
}

// ---------------------------------------------------------------------------
// Saying what it is, at the point of use
// ---------------------------------------------------------------------------

/**
 * Structurally an `ObjectProperty` from `ObjectPicker.tsx` without importing it.
 *
 * The picker's type lives in a `.tsx` that imports React; pulling it in here
 * would put React on the path of a module the store depends on. Assignability is
 * what the caller needs and structural typing is what gives it.
 */
export interface CadProperty {
  label: string;
  value: string | number;
}

const fmt = (n: number): string => (Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : '—');

/** The one-line `detail` under the name in a merged list row. */
export function cadRowDetail(rec: SavedCadDrawing): string {
  const c = rec.cad;
  const missing = c.complete ? '' : ` · ${c.unsupported.length + c.issues.filter((i) => i.severity === 'refused').length} REFUSED, features missing`;
  return `2bee.cad model · 3D solid · ONE section at z = ${fmt(c.mid_height_z_mm)} mm, CHOSEN FOR YOU${missing}`;
}

/**
 * Everything the properties panel should say about a stored CAD model.
 *
 * 🔴 THE ORDER IS THE ARGUMENT. What is MISSING and whether the mesh still
 * matches its source come FIRST, above the triangle counts — a caveat printed
 * under the numbers it qualifies is a caveat that gets read after the decision.
 * This is the "visible when the part is later selected" half of the refusal
 * policy in the header, and it is the only half that reaches the person who did
 * not draw the model.
 */
export function describeCadRecord(rec: SavedCadDrawing, verification?: CadVerification): CadProperty[] {
  const c = rec.cad;
  const v = verification ?? verifyCadRecord(rec);
  const out: CadProperty[] = [];

  if (v.status !== 'ok') {
    out.push({
      label: v.status === 'stale' ? '🔴 STALE — do not cut this' : '🔴 UNREADABLE — do not cut this',
      value: v.why,
    });
  }

  if (!c.complete) {
    const refusedIssues = c.issues.filter((i) => i.severity === 'refused');
    out.push({
      label: '🔴 FEATURES ARE MISSING FROM THIS PART',
      value:
        `${c.unsupported.length} construct(s) outside the 2bee.cad subset and ${refusedIssues.length} ` +
        'refused operation(s) contributed NOTHING to this solid. What was saved is a SUBSET of the model ' +
        'that was drawn, and it looks complete. ' +
        [...c.unsupported, ...refusedIssues]
          .map((u) => `${u.name} (line ${u.line})`)
          .join(', '),
    });
    if (c.parse_errors.length) {
      out.push({
        label: '🔴 The source did not parse cleanly',
        value: c.parse_errors.map((e) => `line ${e.line}: ${e.message}`).join(' · '),
      });
    }
  } else {
    out.push({
      label: 'Complete?',
      value:
        'Yes — nothing in the source was refused by the parser or the mesher, so this solid is the whole ' +
        'model as written. That is a statement about the LANGUAGE, not about the geometry being right.',
    });
  }

  out.push({
    label: 'What it is',
    value:
      'a 3D SOLID designed in the 2bee.cad tab — the machine cuts ONE flat section of it at one Z, never ' +
      'the solid. A different Z is a different part.',
  });
  out.push({
    label: 'Mesh audit',
    value: `${c.verdict} — ${c.audit_detail}`,
  });
  out.push({
    label: 'Source is kept',
    value:
      `${c.source.length} characters of 2bee.cad source are stored with this part, so it stays editable. ` +
      'The mesh beside it is a CACHE of that source; both carry a checksum and a mismatch is reported ' +
      'above rather than cut.',
  });
  out.push({ label: 'Solids in the file', value: c.solids });
  out.push({ label: 'Triangles', value: c.triangles });
  if (c.flats_dropped > 0) {
    out.push({
      label: '2D shapes NOT saved',
      value:
        `${c.flats_dropped}. A square or circle has no thickness and no interior, so it is not part of ` +
        'any solid and nothing was written for it.',
    });
  }
  out.push({ label: 'Solid spans Z', value: `${fmt(c.z_span_mm[0])} … ${fmt(c.z_span_mm[1])} mm` });
  out.push({
    label: 'Section Z — CHOSEN FOR YOU',
    value:
      `${fmt(c.mid_height_z_mm)} mm, the mid-height. A different Z is a different part; this one is a ` +
      'guess about your intent, not a reading of your model.',
  });
  if (c.issues.some((i) => i.severity === 'warning')) {
    out.push({
      label: 'Warnings recorded when it was evaluated',
      value: c.issues
        .filter((i) => i.severity === 'warning')
        .map((i) => `${i.name} (line ${i.line}): ${i.detail}`)
        .join(' · '),
    });
  }
  out.push({
    label: 'Evaluated',
    value: `${new Date(c.evaluated_at).toLocaleString()} — in THIS browser, by the 2bee.cad kernel. Nothing was measured, nobody checked it, and nothing this app has produced has ever been cut.`,
  });
  return out;
}
