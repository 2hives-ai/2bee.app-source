// Mesh invariants, and the tolerance — where it comes from and why it is not
// a curve fitted to make the corpus pass.
//
// THE QUESTION THIS FILE ANSWERS: does our kernel produce the same SOLID?
// Not the same file. STL bytes differ legitimately in vertex order, in
// triangulation and in float formatting, and OpenSCAD's mesh for the standard
// example has 144 triangles where ours has 272 — the same solid, cut up
// differently. So triangle count is REPORTED and never decides anything; the
// decision is made on quantities that are properties of the solid rather than
// of its tessellation: volume, surface area, axis-aligned bounds and the
// volume-weighted centroid.

// ---------------------------------------------------------------------------
// THE TOLERANCE
// ---------------------------------------------------------------------------
//
// 🔴 ONE NUMBER, DERIVED, AND EVERY CASE THAT EXCEEDS IT IS REPORTED RATHER
// THAN ABSORBED BY WIDENING IT.
//
// What does NOT set this tolerance, contrary to the obvious guess:
//
//   TESSELLATION. The textbook term — "a curve can never match exactly" — is
//   COMMON MODE here and cancels. `mesh.ts`'s `fragments()` is a port of
//   OpenSCAD's own `get_fragments_from_r`, with the same `$fa=12`/`$fs=2`
//   defaults, the same meridian count, and the same half-step ring latitudes on
//   a sphere. Both sides therefore tessellate the SAME polygon, not two
//   approximations of the same circle. For scale, if the two ever disagreed on
//   `$fn` the error would be enormous by comparison: an inscribed n-gon
//   understates a circle's area by 1 - (n/2pi)*sin(2pi/n), which is 6.4e-3 at
//   n=32 and 1.6e-3 at n=64 — three orders above this tolerance. That is a
//   useful signature: a mesh divergence of that MAGNITUDE is a `$fn`/`$fa`/`$fs`
//   disagreement, not float noise, and the harness prints the ratio so the
//   reader can tell the two apart without re-deriving this.
//
// What DOES set it:
//
//   FLOAT32. `MeshPart.positions` is a `Float32Array` — that is the product's
//   actual output surface, not a harness artefact, so the comparison has to
//   live with it. float32 has a 24-bit significand, so each coordinate carries
//   up to 2^-24 ~ 6e-8 of relative error, and a displaced surface changes the
//   enclosed volume by the integral of that displacement over the surface. The
//   size of that term depends on the part's shape (thin parts and parts far
//   from the origin are worse), so it is not a single constant — and rather
//   than BOUND it analytically with a worst case that is never approached, this
//   harness MEASURES it per case: it takes the oracle's own double-precision
//   mesh, rounds it through float32, and recomputes. The change is the
//   instrument's resolution for that case, measured on the oracle's own data.
//
//   If that measured floor reaches the tolerance, the case is not decidable at
//   this precision and is reported PENDING with the number — never passed, and
//   never used as a reason to move the constant.
//
// Choosing the constant, given those two facts:
//
//   UPPER BOUND — it must sit far below the smallest defect that could matter
//   physically. A 0.01 mm dimensional error on a 20 mm feature is 1.5e-3 of
//   relative volume. One triangle dropped from a cube face is 1.25e-1. The
//   `mesh-scale` plant's 1% is 3.0e-2. Anything at or below 1e-4 is safely
//   under every one of those.
//   LOWER BOUND — it must sit above the measured float32 floor. Across the
//   corpus that floor is 0 to 9.04e-8 (worst case `xform_nested`), and the
//   largest residual on any case that AGREES is the same 9.04e-8.
//
//   1e-5 is two orders above the measured floor and two below the smallest
//   defect that matters. ⚠ THE CLAIM THAT THE PLACEMENT IS NOT LOAD-BEARING WAS
//   CHECKED RATHER THAN ASSERTED: replaying every recorded measurement at
//   1e-6, 3e-6, 1e-5 and 3e-5 gives IDENTICAL verdicts on every case — a 30x
//   band with the constant inside it. At 1e-4 it stops being identical: the
//   `fn_clamped` finding (our MAX_FN=256 clamp against the source's $fn=400,
//   5.93e-5 of volume) is absorbed and disappears. That is the reason the
//   number is not at 1e-4, and it is a measured reason, not a preference.
//
//   🔴 The one case in the corpus that lands between the floor and a real
//   defect is `fn_clamped` at 5.93e-5 — only 6x above this tolerance. So the
//   headroom below is 110x and the headroom above is 6x, and it is the SMALL
//   side that is doing the work. If a future clamp or default lands closer than
//   that, the answer is to report the case, not to move the number.

/** Relative agreement required of volume and surface area. See above. */
export const REL_TOL = 1e-5;

/**
 * Relative spacing of float32. Used only to explain the measured floor, never
 * to substitute for measuring it.
 */
export const EPS32 = 2 ** -24;

/**
 * Absolute quantities — bbox faces and centroid coordinates — are compared at
 * `REL_TOL * scale`, where `scale` is the largest coordinate magnitude in the
 * reference mesh. A bbox face at x = 0 has no meaningful relative error, and
 * scaling by the part's own coordinate range is the same statement the relative
 * test makes for volume: agree to one part in 1e5 of the size of the thing.
 */
export const absTol = (scale) => REL_TOL * Math.max(scale, 1);

// ---------------------------------------------------------------------------
// The invariants themselves
// ---------------------------------------------------------------------------

/**
 * Compute volume, area, bounds, centroid and triangle count from a triangle
 * soup (9 values per triangle, any Float32Array/Float64Array/Array).
 *
 * Volume is the signed sum of tetrahedra on the origin, which is exact for any
 * closed orientable surface and — deliberately — MEANINGLESS for an open one.
 * That is a feature: a mesh with a hole gets a volume that will not match, and
 * the audit in `mesh.ts` says the same thing independently.
 */
export function invariants(tris) {
  const n = Math.floor(tris.length / 9);
  let vol = 0;
  let area = 0;
  let cx = 0, cy = 0, cz = 0;
  let minx = Infinity, miny = Infinity, minz = Infinity;
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;

  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
    const bx = tris[o + 3], by = tris[o + 4], bz = tris[o + 5];
    const dx = tris[o + 6], dy = tris[o + 7], dz = tris[o + 8];

    // signed volume of the tetrahedron (origin, a, b, c)
    const v = (ax * (by * dz - bz * dy) + ay * (bz * dx - bx * dz) + az * (bx * dy - by * dx)) / 6;
    vol += v;
    // volume-weighted centroid: the tetrahedron's centroid is the mean of its
    // four vertices, one of which is the origin.
    cx += v * (ax + bx + dx) / 4;
    cy += v * (ay + by + dy) / 4;
    cz += v * (az + bz + dz) / 4;

    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = dx - ax, e2y = dy - ay, e2z = dz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    area += Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;

    if (ax < minx) minx = ax; if (ax > maxx) maxx = ax;
    if (bx < minx) minx = bx; if (bx > maxx) maxx = bx;
    if (dx < minx) minx = dx; if (dx > maxx) maxx = dx;
    if (ay < miny) miny = ay; if (ay > maxy) maxy = ay;
    if (by < miny) miny = by; if (by > maxy) maxy = by;
    if (dy < miny) miny = dy; if (dy > maxy) maxy = dy;
    if (az < minz) minz = az; if (az > maxz) maxz = az;
    if (bz < minz) minz = bz; if (bz > maxz) maxz = bz;
    if (dz < minz) minz = dz; if (dz > maxz) maxz = dz;
  }

  const c = vol !== 0 ? [cx / vol, cy / vol, cz / vol] : [0, 0, 0];
  const bounds = n ? { min: [minx, miny, minz], max: [maxx, maxy, maxz] } : null;
  const scale = bounds
    ? Math.max(...bounds.min.map(Math.abs), ...bounds.max.map(Math.abs))
    : 0;

  return { triangles: n, volume: vol, area, centroid: c, bounds, scale };
}

/**
 * The instrument's resolution for THIS case: what float32 alone does to the
 * oracle's own mesh. Not a bound, a measurement.
 */
export function quantisationFloor(refTris) {
  const exact = invariants(refTris);
  const rounded = invariants(Float32Array.from(refTris));
  const rel = (a, b) => (Math.abs(a) > 0 ? Math.abs(a - b) / Math.abs(a) : Math.abs(a - b));
  return {
    volume: rel(exact.volume, rounded.volume),
    area: rel(exact.area, rounded.area),
  };
}

/**
 * Compare two invariant sets. Returns `{ same, checks }` where every check
 * carries its own numbers, so a report can print WHY rather than just "no".
 */
export function compareInvariants(ref, got) {
  const checks = [];
  const at = absTol(ref.scale);

  const relCheck = (name, a, b) => {
    const denom = Math.abs(a);
    const delta = Math.abs(a - b);
    const rel = denom > 0 ? delta / denom : delta;
    const tol = denom > 0 ? REL_TOL : at;
    checks.push({ name, ref: a, got: b, delta, rel, tol, ok: rel <= tol });
  };
  const absCheck = (name, a, b) => {
    const delta = Math.abs(a - b);
    checks.push({ name, ref: a, got: b, delta, rel: null, tol: at, ok: delta <= at });
  };

  relCheck('volume', ref.volume, got.volume);
  relCheck('area', ref.area, got.area);

  if (ref.bounds && got.bounds) {
    const ax = ['x', 'y', 'z'];
    for (let i = 0; i < 3; i++) {
      absCheck(`bbox.min.${ax[i]}`, ref.bounds.min[i], got.bounds.min[i]);
      absCheck(`bbox.max.${ax[i]}`, ref.bounds.max[i], got.bounds.max[i]);
    }
    for (let i = 0; i < 3; i++) absCheck(`centroid.${ax[i]}`, ref.centroid[i], got.centroid[i]);
  } else if (Boolean(ref.bounds) !== Boolean(got.bounds)) {
    checks.push({
      name: 'bounds',
      ref: ref.bounds ? 'present' : 'absent',
      got: got.bounds ? 'present' : 'absent',
      delta: NaN,
      rel: null,
      tol: at,
      ok: false,
    });
  }

  return { same: checks.every((c) => c.ok), checks };
}

/**
 * The n-gon signature, printed next to a failing volume so a `$fn` disagreement
 * is not mistaken for float noise. Returns the relative area deficit of an
 * inscribed n-gon against its circle.
 */
export function ngonDeficit(n) {
  return 1 - (n / (2 * Math.PI)) * Math.sin((2 * Math.PI) / n);
}

/** Do two axis-aligned boxes overlap (touching counts as not overlapping)? */
export function boxesOverlap(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a.max[i] <= b.min[i] || b.max[i] <= a.min[i]) return false;
  }
  return true;
}

/**
 * Relative contact resolution for `boxesTouch`. The solids' positions are
 * float32, and two faces that are coincident BY CONSTRUCTION (a box stacked on
 * a box) survive exactly only when both were computed through the same
 * arithmetic; through different transforms the same plane can land a few
 * ulps apart. 1e-6 of the largest coordinate magnitude is ~20x that float32
 * ulp at the hardware leg's coordinate range and ~1000x below the smallest
 * contact face any of these models carries, so it separates "designed to
 * touch" from "designed apart" without confusing either with noise.
 */
export const TOUCH_REL_EPS = 1e-6;

/** The absolute contact epsilon for a pair of boxes, from their coordinates. */
export function touchEps(a, b) {
  const s = Math.max(
    1,
    ...a.min.map(Math.abs), ...a.max.map(Math.abs),
    ...b.min.map(Math.abs), ...b.max.map(Math.abs),
  );
  return TOUCH_REL_EPS * s;
}

/**
 * Do two axis-aligned boxes TOUCH — face, edge or point contact, with no
 * separation and (by the caller's ordering) no overlap either?
 *
 * Per axis the gap is positive when the intervals are separated; contact on
 * an axis means |gap| <= eps. The pair TOUCHES when no axis is separated by
 * more than eps and at least one axis is in contact. A pair overlapping on
 * every axis is `boxesOverlap`'s case, not this one's: the caller checks
 * overlap first, so a pair that reaches here with one axis in contact and
 * the other two overlapping is face contact — the exact shape where
 * OpenSCAD's CGAL union deletes the coincident internal faces and a summed
 * surface area counts them twice.
 *
 * Conservative in the safe direction, like `boxesOverlap`: the boxes are
 * bounding boxes, so a curved solid can "touch" here where its surface does
 * not. That scores an undecidable-PENDING where a comparison might have
 * succeeded — never a pass where a divergence hid.
 */
export function boxesTouch(a, b, eps) {
  let contact = false;
  for (let i = 0; i < 3; i++) {
    const gap = Math.max(a.min[i] - b.max[i], b.min[i] - a.max[i]);
    if (gap > eps) return false;
    if (Math.abs(gap) <= eps) contact = true;
  }
  return contact;
}
