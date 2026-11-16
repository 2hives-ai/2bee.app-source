// The TIME budget is enforced during GENERATION, not only inside the booleans.
//
// 🔴 WHY THIS EXISTS. `MAX_MS` is documented as "wall-clock for the whole
// evaluation", and until 2026-09-04 `budget.check` was called ONLY inside the
// BSP loops in csgUnion/csgSubtract/csgIntersect. A model that spends its time
// GENERATING geometry — tessellating gear teeth, walking nested `for` loops over
// an assembly — passed no check at all, so neither the 6 s deadline nor the
// polygon ceiling applied to it. Measured: one hardware assembly ran 178 s and
// died of a 4 GB heap OOM without ever being asked whether it had run out of
// anything.
//
// ⚠ AND THE REVERT SWEEP THEN FOUND THE FIX ITSELF UNGUARDED (ceo `20-55-00`):
// `budget.tick()` could be deleted with the whole suite green. It was also
// UNTESTABLE — the only way to exceed a 6 s wall-clock was to find a model that
// really takes 6 s, which is slow, machine-dependent and would rot into a flake.
// `meshScene`'s `budgetMs` parameter is the seam that makes the deadline
// reachable in a millisecond; the browser still gets `MAX_MS` by default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScad } from '../src/cad/scad.ts';
import { meshScene } from '../src/cad/mesh.ts';

const SRC = 'union() { cube(10); translate([5,0,0]) sphere(6); }';

test('a model meshes normally under the default budget', () => {
  const r = meshScene(parseScad(SRC).scene);
  assert.ok(r.stats.solids > 0, 'the control model produced no solids, so the test below proves nothing');
});

test('an ALREADY-EXPIRED budget refuses the whole model and NAMES the budget', () => {
  // Negative rather than 0: the deadline is `t0 + budgetMs` and the check is
  // `now() > deadline`, so a 0 ms budget can compare equal on a fast machine and
  // pass. A control that only fires when the clock cooperates is not a control.
  const r = meshScene(parseScad(SRC).scene, undefined, -1);
  assert.equal(r.stats.solids, 0, 'geometry was produced after the budget had expired');
  const refused = r.issues.filter((i) => i.severity === 'refused');
  assert.ok(refused.length > 0, 'the budget was exceeded and nothing was reported as refused');
  assert.ok(
    refused.some((i) => /wall-clock backstop/.test(i.detail)),
    `a refusal was reported but it does not name the budget: ${refused.map((i) => i.detail).join(' | ')}`,
  );
});

test('the refusal happens during GENERATION — a model with no boolean at all', () => {
  // The pre-fix code could only notice inside a BSP loop, so a single primitive
  // is the case it was structurally blind to. This is the assertion that would
  // have failed before `budget.tick()` and passes after it.
  const r = meshScene(parseScad('sphere(5);').scene, undefined, -1);
  assert.equal(r.stats.solids, 0, 'a boolean-free model ignored the time budget');
});

// ── 2026-10-15: THE BUDGET THAT DECIDES VERDICTS IS WORK, NOT TIME ──────────
// A wall-clock budget made CAD1H verdicts depend on machine load (a cut file
// flipped DIVERGES <-> STRICTER between runs). These hold the replacement.
test('the work budget refuses the whole model and NAMES itself', () => {
  const r = meshScene(parseScad(SRC).scene, undefined, undefined, 0);
  assert.equal(r.stats.solids, 0, 'geometry was produced past a zero work budget');
  assert.ok(
    r.issues.some((i) => i.severity === 'refused' && /work budget of 0 units/.test(i.detail)),
    JSON.stringify(r.issues.map((i) => i.detail)),
  );
});

test('work is deterministic: the same model spends the same units every run', () => {
  const runs = [0, 1, 2].map(() => meshScene(parseScad(SRC).scene).stats.work);
  assert.ok(runs[0] > 0, 'no work was counted, so the budget measures nothing');
  assert.deepEqual(runs, [runs[0], runs[0], runs[0]]);
});

test('the verdict does not depend on the clock: a 10x larger backstop changes nothing', () => {
  const a = meshScene(parseScad(SRC).scene);
  const b = meshScene(parseScad(SRC).scene, undefined, 1_200_000);
  assert.deepEqual([a.stats.solids, a.stats.triangles, a.stats.work, a.trust], [b.stats.solids, b.stats.triangles, b.stats.work, b.trust]);
});
