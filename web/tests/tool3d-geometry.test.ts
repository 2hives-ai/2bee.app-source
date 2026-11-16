/**
 * THE 3D PREVIEW IS BUILT FROM THE TOOL'S NUMBERS — measured on the solid.
 *
 * Founder 2026-10-15: the tool list preview is a 3D object, not a drawing.
 * A solid asserts harder than a drawing, so these tests ask the BUILT geometry
 * (its bounding boxes) what size it is, rather than trusting the inputs that
 * were passed in: overall length, diameter, flute length, the V-bit's angle.
 * And they pin the refusals: a missing angle builds no cone, a missing shank
 * builds no shank, a missing overall length is tagged as a stand-in.
 *
 * NOT covered here: anything about how it LOOKS or that WebGL renders it —
 * there is no WebGL in Node. That is the e2e check and a screenshot.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildToolModel, buildTouchPlateModel, buildWorkholdingModel, describeTool3D, STOCK_MM } from '../src/tool3d/geometry';
import { TOUCH_PLATES } from '../src/touchplates';
import { WORKHOLDING } from '../src/workholding';
import { shapeFor } from '../src/workholdingShape';

const TOL = 0.02; // 2% — the fluted cross-section is sampled at 96 points

function bbox(o: THREE.Object3D): THREE.Box3 {
  o.updateMatrixWorld(true);
  const b = new THREE.Box3();
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) b.expandByObject(c);
  });
  return b;
}

function byName(g: THREE.Object3D, name: string): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  g.traverse((c) => {
    if (c.name === name) out.push(c);
  });
  return out;
}

function near(actual: number, want: number, what: string) {
  assert.ok(Math.abs(actual - want) <= Math.max(Math.abs(want) * TOL, 0.02), `${what}: built ${actual.toFixed(3)}, record says ${want}`);
}

const ENDMILL = {
  category: 'End Mill',
  diameter_mm: 6,
  shank_mm: 6.35,
  cutting_length_mm: 22,
  overall_length_mm: 60,
  flutes: 2,
  flute_type: 'up-cut',
};

test('end mill: overall length, diameter and flute length are the record numbers', () => {
  const m = buildToolModel(ENDMILL);
  assert.ok(m);
  const b = bbox(m.group);
  near(b.min.y, 0, 'tip at y=0');
  near(b.max.y, 60, 'overall length');
  const flutes = bbox(byName(m.group, 'flutes')[0]);
  near(flutes.max.y, 22, 'flute length');
  near(flutes.max.x - flutes.min.x, 6, 'cutter diameter (x)');
  near(flutes.max.z - flutes.min.z, 6, 'cutter diameter (z)');
  const shank = bbox(byName(m.group, 'shank')[0]);
  near(shank.max.x - shank.min.x, 6.35, 'shank diameter');
  assert.equal(m.info.overallMm, 60);
  assert.deepEqual(m.info.standIns, []);
});

test('V-bit: the built cone has the stated included angle', () => {
  for (const angle of [30, 60, 90, 120]) {
    const m = buildToolModel({ category: 'V-Bit', diameter_mm: 12, included_angle_deg: angle, cutting_length_mm: 15, shank_mm: 6.35, overall_length_mm: 50, flutes: 2, flute_type: 'straight' });
    assert.ok(m);
    const tip = bbox(byName(m.group, 'tip')[0]);
    const h = tip.max.y - tip.min.y;
    const r = (tip.max.x - tip.min.x) / 2;
    const built = (2 * Math.atan(r / h) * 180) / Math.PI;
    assert.ok(Math.abs(built - angle) < 0.5, `${angle}° V-bit built at ${built.toFixed(2)}°`);
    near(tip.min.y, 0, 'apex at y=0');
  }
});

test('ball nose: the tip is a hemisphere of the cutter radius', () => {
  const m = buildToolModel({ ...ENDMILL, category: 'Ball Nose', diameter_mm: 8 });
  assert.ok(m);
  const tip = bbox(byName(m.group, 'tip')[0]);
  near(tip.max.y - tip.min.y, 4, 'ball height = radius');
  near(tip.max.x - tip.min.x, 8, 'ball diameter');
});

test('compression and down-cut build; the twist is the only difference', () => {
  for (const flute_type of ['down-cut', 'compression', 'straight']) {
    const m = buildToolModel({ ...ENDMILL, flute_type });
    assert.ok(m, flute_type);
    near(bbox(m.group).max.y, 60, `${flute_type} overall`);
  }
});

test('🔴 refusals: no angle -> no cone; no shank -> no shank; no overall -> stand-in, tagged', () => {
  const noAngle = buildToolModel({ category: 'V-Bit', diameter_mm: 12, cutting_length_mm: 10, shank_mm: 6 });
  assert.ok(noAngle);
  assert.equal(byName(noAngle.group, 'tip').length, 0, 'a V-bit with no angle must build no tip');
  assert.equal(byName(noAngle.group, 'tip-refused').length, 1, 'and must mark the refusal');
  assert.ok(describeTool3D({ category: 'V-Bit', diameter_mm: 12 }).notDrawn.some((s) => s.includes('included angle')));

  const noShank = buildToolModel({ category: 'End Mill', diameter_mm: 6, cutting_length_mm: 20 });
  assert.ok(noShank);
  assert.equal(byName(noShank.group, 'shank').length, 0, 'no shank number -> no shank solid');

  const noOverall = buildToolModel({ ...ENDMILL, overall_length_mm: null });
  assert.ok(noOverall);
  assert.equal(noOverall.info.overallMm, null);
  assert.equal(byName(noOverall.group, 'shank')[0].userData.role, 'shank-assumed');
  assert.ok(noOverall.info.standIns.length > 0);

  const noFlute = buildToolModel({ ...ENDMILL, cutting_length_mm: null });
  assert.ok(noFlute);
  assert.equal(byName(noFlute.group, 'flutes')[0].userData.role, 'cut-assumed');

  assert.equal(buildToolModel({ category: 'End Mill' }), null, 'no diameter -> nothing is built');
});

test('every touch plate and every drawn work holding entry builds a solid', () => {
  for (const p of TOUCH_PLATES) assert.ok(buildTouchPlateModel(p.id), p.id);
  for (const w of WORKHOLDING) {
    if (!shapeFor(w.id)) continue;
    assert.ok(buildWorkholdingModel(w.id), w.id);
  }
  assert.equal(buildTouchPlateModel('no-such-plate'), null);
  assert.equal(buildWorkholdingModel('no-such-clamp'), null);
});

test('work holding: the clamp keepout box is the catalogue height and footprint', () => {
  const id = 'toggle-clamp-vertical';
  const s = shapeFor(id)!;
  const g = buildWorkholdingModel(id)!;
  const keep = bbox(byName(g, 'keepout')[0]);
  near(keep.max.y, s.heightMm, 'clamp height');
  near(keep.max.x - keep.min.x, s.footprintMm[0], 'footprint across');
  near(keep.max.z - keep.min.z, s.footprintMm[1], 'footprint along');
  // A vacuum pod lifts the stock by its height.
  const pod = buildWorkholdingModel('vacuum-pod-console')!;
  const stock = bbox(byName(pod, 'stock')[0]);
  near(stock.min.y, shapeFor('vacuum-pod-console')!.heightMm, 'stock sits on the pod');
  near(stock.max.y - stock.min.y, STOCK_MM, 'stock thickness');
});
