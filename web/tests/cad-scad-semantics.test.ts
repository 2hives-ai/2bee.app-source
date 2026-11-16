// OpenSCAD semantics the 2bee.cad kernel got wrong (bughunt 2026-11-15, round 9). Each
// case is OpenSCAD's documented/source behaviour; a wrong answer here is a wrong part on the
// router or the printer — e.g. every partial rotate_extrude landed 180 degrees out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScad } from '../src/cad/scad';
import { meshScene } from '../src/cad/mesh';
function run(src: string) { const p = parseScad(src); const m = meshScene(p.scene);
  let mn=[Infinity,Infinity,Infinity],mx=[-Infinity,-Infinity,-Infinity],vol=0;
  for(const q of m.parts){ if(!q.bounds) continue; for(let k=0;k<3;k++){mn[k]=Math.min(mn[k],q.bounds.min[k]);mx[k]=Math.max(mx[k],q.bounds.max[k]);}
    if(q.dim===3){const a=q.positions;for(let i=0;i<q.triangles*9;i+=9)vol+=(a[i]*(a[i+4]*a[i+8]-a[i+5]*a[i+7])-a[i+1]*(a[i+3]*a[i+8]-a[i+5]*a[i+6])+a[i+2]*(a[i+3]*a[i+7]-a[i+4]*a[i+6]))/6;}}
  const r=(x: number)=>Math.round(x*1000)/1000;
  const out={min:mn.map(r),max:mx.map(r),vol:r(vol),parts:m.parts.length,trust:m.trust,issues:m.issues.length,errs:p.errors.length+p.unsupported.length+p.warnings.length,echo:p.console.map(c=>c.message)};
  return out; }

test('F1 rotate_extrude(angle=90) must start at +X (OpenSCAD: start defaults to 0 when angle given)', () => {
  const r = run('rotate_extrude(angle=90, $fn=32) translate([10,0]) square([2,5]);');
  assert.deepEqual([r.min[0], r.min[1], r.max[0], r.max[1]], [0, 0, 12, 12]);
});
test('F2 rotate_extrude(angle=-90) sweeps clockwise (4th quadrant solid), not a flat', () => {
  const r = run('rotate_extrude(angle=-90, $fn=32) translate([10,0]) square([2,5]);');
  assert.ok(r.vol > 150, 'expected ~171.7 mm3 solid');
});
test('F3 [b:e] with b>e: OpenSCAD swaps (deprecated) and iterates', () => {
  const r = run('for (i=[3:1]) translate([i*10,0,0]) cube(1);');
  assert.equal(r.parts, 3);
  const z = run('n=0; for (i=[0:n-1]) translate([i*10,0,0]) cube(1);');
  assert.equal(z.parts, 2); // i = -1, 0
});
test('F4 resize(newsize=...) is honoured', () => {
  const r = run('resize(newsize=[10,10,10]) cube([1,2,3]);');
  assert.deepEqual(r.max, [10,10,10]);
});
test('F5 3D hull of a single cube is the cube', () => {
  const r = run('hull(){ cube(10); }');
  assert.equal(r.vol, 1000); assert.equal(r.trust, 'trusted');
});
test('F5b hull of two cubes = 11x1x1 box', () => {
  const r = run('hull(){ cube(1); translate([10,0,0]) cube(1);}');
  assert.equal(r.vol, 11);
});
test('F6 minkowski cube+sphere is a solid', () => {
  const r = run('minkowski(){ cube(10); sphere(1,$fn=4);}');
  assert.ok(r.vol > 1000);
});
test('F7 rotate_extrude angle>360 clamps to 360', () => {
  const r = run('rotate_extrude(angle=400, $fn=32) translate([10,0]) square([2,5]);');
  assert.equal(r.vol, run('rotate_extrude(angle=360, $fn=32) translate([10,0]) square([2,5]);').vol);
});
test('F5c 3D hull of round solids does not explode (two $fn=32 spheres threw a stack overflow)', () => {
  // bughunt 2026-11-15: near-coplanar points made quickhull add sliver faces until
  // `faces.push(...newFaces)` overflowed; the catalogue build and gate I1 died on it.
  const r = run('hull(){ sphere(10,$fn=32); translate([50,0,0]) sphere(10,$fn=32); }');
  const capsule = (4 / 3) * Math.PI * 1000 + Math.PI * 100 * 50; // 19896.8 mm3, the round shape
  assert.equal(r.trust, 'trusted');
  assert.ok(r.vol > 0.95 * capsule && r.vol <= capsule, `vol ${r.vol} vs capsule ${capsule.toFixed(1)}`);
  // OpenSCAD's sphere rings sit at half steps: the widest is r*sin(180*7.5/16 deg) = 9.952, not 10.
  assert.deepEqual([r.min[0], r.max[0]], [-9.952, 59.952]);
});
