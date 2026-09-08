// Driving the real OpenSCAD binary, and reading what it says back.
//
// This module is the ORACLE HALF of the differential harness. Everything here
// runs the actual `openscad` executable and parses its output; nothing here
// knows anything about our own implementation. That separation is deliberate —
// a harness whose two halves share a helper can agree with itself.
//
// 🔴 EVERY FAILURE MODE HERE RETURNS A REASON, NEVER AN EMPTY RESULT. A missing
// binary, a timeout, an unreadable file and "this model has no 3D geometry" are
// four different facts, and only the last one is compatible with a pass. A
// function that returned `null` for all four would let the harness score an
// absent oracle as agreement, which is the exact shape SLICER-GATES.md §3 bans.

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

/** Default per-invocation wall clock. A hive model's CGAL render is not fast. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Largest ASCII STL we will read into memory. Beyond this the harness reports
 * PENDING rather than risking an OOM that would look like a crash in OUR code.
 */
export const MAX_STL_BYTES = 512 * 1024 * 1024;
/**
 * Bytes of `.csg` text this harness will read and hand to `csgToCanon`.
 *
 * 🔴 A SIZE CAP IN FILE BYTES IS ONLY HONEST IF THE MULTIPLIER IS STATED, so:
 * measured 2026-09-04, `csgToCanon` peaks at **23.7x the file size** in heap
 * (64.8 MB of CSG -> 1536 MB peak, 4.0 s). The cap is set just above the largest
 * CSG in `hardware/cad/` OBSERVED TO PARSE — it is a capacity bound taken from a
 * measurement, not a round number, and re-deriving it means re-running that
 * probe rather than reasoning about it.
 *
 * ⚠ RAISING THIS IS A DECISION ABOUT HEAP, NOT ABOUT COVERAGE. At 24x, doubling
 * this cap asks for another ~1.5 GB. A case over the cap is REFUSED BY NAME and
 * counted, which is a declared gap; a case that OOMs takes the other 172 with it
 * and reports nothing about any of them.
 */
export const MAX_CSG_BYTES = 64 * 1024 * 1024;

/**
 * 🔴 ASCII STL, NOT BINARY, AND THE REASON IS THE TOLERANCE.
 *
 * Binary STL stores coordinates as float32. Round-tripping the oracle's mesh
 * through float32 would add ~2e-7 of relative volume error on the side we are
 * treating as ground truth — within a factor of five of the tolerance this
 * harness compares at, so the oracle's own export format would have become a
 * term in the comparison. OpenSCAD's ASCII writer prints full double precision
 * (verified: a vertex reads `-3.325878449210181`), so the export contributes
 * nothing and the only float32 in the system is on OUR side, where it belongs —
 * it is what `mesh.ts` actually hands its callers.
 *
 * The format is passed EXPLICITLY for a second reason: `openscad --help` warns
 * that the default STL flavour is planned to change. A harness that relies on a
 * documented-as-changing default is a defect with a release date on it.
 */
const STL_FORMAT = 'asciistl';

/**
 * 🔴 THE GEOMETRY BACKEND IS PINNED, NOT INHERITED — and it is part of the
 * reference, not a performance setting.
 *
 * OpenSCAD ships two 3D kernels and `--backend` selects between them. Upstream
 * made Manifold non-experimental in the 2024.09.28 nightly and has since made it
 * the DEFAULT, with CGAL still reachable via `--backend=cgal`. ⇒ The default has
 * already moved once.
 *
 * ⚠ MEASURED HERE 2026-09-06, and this is why it matters rather than being
 * tidy: the same corpus case exports DIFFERENT BYTES under each kernel —
 * `corpus/bool_difference.scad` gives 29,409 bytes under Manifold and 29,189
 * under CGAL, different sha256. So "what OpenSCAD renders" is not one answer,
 * and every CAD1/CAD1H baseline was pinned against whichever kernel happened to
 * be the default on the box that pinned it.
 *
 * 🔴 The provenance line said only `OpenSCAD version 2026.08.07` — a string that
 * is IDENTICAL under both kernels. A colleague passing `--backend=cgal`, or a
 * future release flipping the default back, moves every number in this harness
 * and leaves no trace in the artefact that records where the numbers came from.
 * That is a provenance line omitting the variable that changes the answer.
 */
const BACKEND = 'manifold';

export function openscadVersion(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20_000 });
  if (r.error || r.status !== 0) return null;
  // OpenSCAD prints its version on stderr.
  const line = `${r.stderr || ''}${r.stdout || ''}`.trim().split('\n')[0] || null;
  /* The kernel travels with the version, because the version alone does not
   * identify the reference — see the note above BACKEND. */
  return line ? `${line} [backend=${BACKEND}]` : null;
}

/**
 * Run the binary once. Returns `{ ok, status, stdout, stderr, reason }`.
 * `ok === false` always carries a `reason` fit to print in a PENDING row.
 */
function run(bin, args, cwd, timeoutMs) {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) {
    if (r.error.code === 'ENOENT') {
      return { ok: false, reason: `openscad binary not found at ${bin}` };
    }
    if (r.error.code === 'ETIMEDOUT') {
      return { ok: false, reason: `openscad timed out after ${timeoutMs} ms` };
    }
    return { ok: false, reason: `openscad could not be run: ${r.error.message}` };
  }
  if (r.signal) return { ok: false, reason: `openscad was killed by ${r.signal} (timeout is ${timeoutMs} ms)` };
  return { ok: true, status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A scratch dir per call, removed on the way out even when a step failed. */
function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'scad-oracle-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The EVALUATED CSG TREE — what the language means after variables, modules,
 * `for`, `if` and `$fn` have been resolved. This is the gold standard for the
 * TREE leg of the comparison.
 *
 * Returns `{ ok: true, csg, stderr }` or `{ ok: false, reason }`.
 */
// `cap` is injectable ONLY so a test can drive the refusal path with a real
// (tiny) model instead of a 68 MB fixture. Default is the real cap; the revert
// sweep found this guard was a HOLE — nothing in the suite noticed when it was
// deleted — and a guard that can only be exercised by allocating 68 MB is a
// guard nobody will exercise.
export function exportCsg(bin, scadPath, timeoutMs = DEFAULT_TIMEOUT_MS, cap = MAX_CSG_BYTES) {
  return withTemp((dir) => {
    const out = join(dir, 'out.csg');
    const r = run(bin, ['--backend', BACKEND, '-o', out, scadPath], dirname(scadPath), timeoutMs);
    if (!r.ok) return r;
    if (r.status !== 0) {
      return { ok: false, reason: `openscad exited ${r.status} on the CSG export: ${firstLine(r.stderr)}` };
    }
    let csgSize;
    try {
      csgSize = statSync(out).size;
    } catch (e) {
      return { ok: false, reason: `openscad exited 0 but wrote no CSG: ${e.message}` };
    }
    // 🔴 THIS CAP DID NOT EXIST, AND ITS ABSENCE KILLED THE FULL RUN FOR DAYS.
    // `exportStl` has always had `MAX_STL_BYTES`; the CSG path had nothing, and
    // the comment above `oracleFor()` in `oracle.mjs` called the CSG "cheap and
    // always taken". It is cheap in TIME on a small model. It is unbounded in
    // SIZE, and it is taken for EVERY case unconditionally.
    //
    // ⚠ MEASURED 2026-09-04, in this order, because the first two suspects were
    // innocent and I had a theory for each:
    //   our own pipeline on the offending model   47 ms, 29 MB peak
    //   parseAsciiStl on its 196 MB ASCII STL     1.3 s, 428 MB peak
    //   its CSG export                            **485 MB of text**
    // `csgToCanon` on a 64.8 MB CSG peaks at **1536 MB — 23.7x the file**. At
    // 485 MB that projects to ~11.5 GB against a 4 GB heap, which is exactly the
    // `FATAL ERROR: Reached heap limit` the run died of, twice, at the same case.
    if (csgSize > cap) {
      return {
        ok: false,
        reason:
          `CSG is ${(csgSize / 1e6).toFixed(0)} MB, over the ${cap / 1e6} MB read cap ` +
          `(csgToCanon costs ~24x the file in heap, so this one needs ~${((csgSize * 23.7) / 1e9).toFixed(1)} GB)`,
      };
    }
    let csg;
    try {
      csg = readFileSync(out, 'utf8');
    } catch (e) {
      return { ok: false, reason: `CSG could not be read: ${e.message}` };
    }
    return { ok: true, csg, bytes: csgSize, stderr: r.stderr };
  });
}

/**
 * The MESH. Returns `{ ok: true, tris, bytes, stderr }` where `tris` is a
 * Float64Array of 9 values per triangle, or `{ ok: false, reason, notSolid }`.
 *
 * `notSolid: true` is the ONE failure that is not a harness problem: the model's
 * top-level object is 2D, so there is no solid to export. It is reported
 * distinctly because "OpenSCAD says this model has no solid" and "OpenSCAD could
 * not be asked" must not be scored the same way.
 *
 * 🔴 `empty: true` IS A THIRD FACT AND IT USED TO BE FOLDED INTO THE SECOND.
 * The doc comment above said `notSolid` covered "2D (or empty)", and the regex
 * did not — an empty top-level object fell through to the generic error arm and
 * was scored as an oracle the harness COULD NOT ASK, i.e. PENDING. Those are
 * three different states of the world and the binary says which one it is, in
 * words, on stdout:
 *
 *   exit 0 + facets                            the model exports a solid
 *   exit 1 "Current top level object is        the model has 2D geometry and no
 *          not a 3D object."                   solid — an outline is drawn
 *   exit 1 "Current top level object is        the model produces NOTHING AT ALL
 *          empty."
 *
 * Measured at 2026.08.07: `intersection(){cube(10); circle(3);}` gives the third,
 * `difference(){circle(8); circle(3);}` gives the second, and a file containing
 * only `cube(0);` gives the third. Collapsing the last two loses the only
 * evidence that separates "we refuse and OpenSCAD also emits nothing" from "we
 * refuse and OpenSCAD draws something we do not" — which is the whole of the
 * REFUSED split in `oracle.mjs`.
 */
export function exportStl(bin, scadPath, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return withTemp((dir) => {
    const out = join(dir, 'out.stl');
    const r = run(bin, ['--backend', BACKEND, '--export-format', STL_FORMAT, '-o', out, scadPath], dirname(scadPath), timeoutMs);
    if (!r.ok) return r;
    if (r.status !== 0) {
      const msg = `${r.stdout}\n${r.stderr}`;
      // Order matters only because the two messages are disjoint; both are
      // matched on their own words so neither can absorb the other silently.
      if (/Current top level object is empty|No top level geometry/i.test(msg)) {
        return { ok: false, empty: true, reason: 'openscad: top-level object is EMPTY — it produces no geometry at all' };
      }
      if (/not a 3D object|Current top level object is not a 3D object/i.test(msg)) {
        return {
          ok: false,
          notSolid: true,
          reason: 'openscad: top-level object is NOT A 3D OBJECT — it has 2D geometry and no solid',
        };
      }
      return { ok: false, reason: `openscad exited ${r.status} on the STL export: ${firstLine(msg)}` };
    }
    let size;
    try {
      size = statSync(out).size;
    } catch (e) {
      return { ok: false, reason: `openscad exited 0 but wrote no STL: ${e.message}` };
    }
    if (size > MAX_STL_BYTES) {
      return { ok: false, reason: `STL is ${(size / 1e6).toFixed(0)} MB, over the ${MAX_STL_BYTES / 1e6} MB read cap` };
    }
    let text;
    try {
      text = readFileSync(out, 'utf8');
    } catch (e) {
      return { ok: false, reason: `STL could not be read: ${e.message}` };
    }
    const p = parseAsciiStl(text);
    if (!p.ok) return { ok: false, reason: `oracle STL rejected: ${p.reason} (${size} bytes)` };
    return { ok: true, tris: p.tris, bytes: size, stderr: r.stderr };
  });
}

function firstLine(s) {
  return String(s || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-1)[0] || '(no message)';
}

/**
 * ASCII STL -> `{ ok: true, tris }` (Float64Array, 9 doubles per triangle) or
 * `{ ok: false, reason }`.
 *
 * Deliberately does NOT read the `facet normal` line. A normal in an STL is
 * redundant with the winding and the two disagree often enough in the wild that
 * trusting it would import someone else's bug. Every invariant this harness
 * computes is derived from the vertex order.
 *
 * 🔴 THE COMPLETENESS CHECKS ARE NOT PEDANTRY — A PARTIAL EXPORT IS A FALSE
 * GROUND TRUTH, AND IT ARRIVED (measured 2026-08-11).
 *
 * The only integrity check here used to be `verts.length % 9 !== 0`, and its
 * comment claimed it stopped a truncated export being "silently rounded down to
 * a shorter valid mesh". **It does not.** An ASCII STL facet is exactly three
 * `vertex` lines, so a file cut at ANY facet boundary leaves a vertex count that
 * is still a multiple of three and sails through — the guard catches only a cut
 * that lands mid-facet. Demonstrated on a 12-facet cube: truncated after the
 * 5th `endfacet`, 15 vertices, guard PASSES.
 *
 * What that cost, before it was found: a full `--hardware` run on a box whose
 * `/tmp` is a 62 GB **tmpfs at 89%**, with another lane's `openscad` running
 * concurrently, returned a partial mesh for `corpus/prim_sphere_default_fn` —
 * `sphere(r=8)` with an oracle `bbox.min.z` of **+5.30** where our correct
 * tessellation said **-7.94**. `openscad` had exited **0**. The harness then
 * reported `bool_union`, `bool_nested` and `prim_sphere_default_fn` as FRESH
 * DIVERGENCES, gate CAD1 went red naming three innocent cases, and the same run
 * repeated in isolation is byte-stable and clean. **The instrument produced a
 * red about the product from a defect in itself**, which is the one failure a
 * differential harness must not have: its own output is the evidence.
 *
 * So completeness is asserted structurally, and every check below is an EXACT
 * property of the format — no tolerance, nothing to tune:
 *   · the file must terminate with `endsolid`; a truncated write never does
 *   · `facet` count must equal `endfacet` count
 *   · the vertex count must be exactly 3x the facet count
 * A file failing any of them is reported as an unusable oracle (PENDING), never
 * compared. ⚠ A short read is now LOUD; it is not thereby impossible.
 */
export function parseAsciiStl(text) {
  const verts = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const at = text.indexOf('vertex', i);
    if (at < 0) break;
    // Guard against the word appearing inside the solid name on line 1.
    const prev = text.charCodeAt(at - 1);
    if (!(prev === 32 || prev === 9 || prev === 10 || prev === 13)) {
      i = at + 6;
      continue;
    }
    let j = at + 6;
    const eol = text.indexOf('\n', j);
    const line = text.slice(j, eol < 0 ? n : eol);
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) return { ok: false, reason: `a vertex line carries ${parts.length} coordinates, not 3` };
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const z = Number(parts[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return { ok: false, reason: `a vertex line is not finite: ${JSON.stringify(line.trim())}` };
    }
    verts.push(x, y, z);
    i = eol < 0 ? n : eol + 1;
  }
  if (verts.length % 9 !== 0) {
    return { ok: false, reason: `${verts.length / 3} vertices is not a whole number of triangles` };
  }
  // Counted on word boundaries: `endfacet` contains `facet`, and `endsolid`
  // contains `solid`, so a naive substring count would report a complete file
  // for every input and this whole guard would be decoration.
  const count = (re) => (text.match(re) || []).length;
  const facets = count(/(^|\s)facet(\s|$)/g);
  const endfacets = count(/(^|\s)endfacet(\s|$)/g);
  if (!/(^|\s)endsolid(\s|$)/.test(text)) {
    return {
      ok: false,
      reason:
        `TRUNCATED — no \`endsolid\` terminator, so openscad did not finish writing this export ` +
        `(${facets} facet(s) read). It exits 0 having written a short file, and the vertex-count ` +
        `check cannot see a cut that lands on a facet boundary`,
    };
  }
  if (facets !== endfacets) {
    return { ok: false, reason: `${facets} \`facet\` against ${endfacets} \`endfacet\` — the export is malformed` };
  }
  if (verts.length / 3 !== facets * 3) {
    return {
      ok: false,
      reason: `${verts.length / 3} vertices for ${facets} facet(s); an ASCII STL facet is exactly 3 vertices`,
    };
  }
  return { ok: true, tris: Float64Array.from(verts) };
}
