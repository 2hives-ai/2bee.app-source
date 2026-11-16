// The 3d tab's own layout (web/src/print3d/layout3d.ts): separate, lay flat,
// arrange, and the checks the assistant's layout actions and replies go through.
//
// Each test names the planted defect it was watched going red against (the
// plants were made by editing layout3d.ts and running this file; see the
// commit body for the red runs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arrange,
  bbox,
  checkLayout,
  contactArea,
  footprintOf,
  layFlat,
  plateFromArea,
  rotatePart,
  rotMatrix,
  scrubOtherPrograms,
  separate,
  separationText,
  sizeOf,
  transformDrop,
  validateLayoutActions,
} from '../src/print3d/layout3d.ts';

/** A box as 12 triangles, outward winding. */
function box(ox: number, oy: number, oz: number, sx: number, sy: number, sz: number): number[] {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].map(([x, y, z]) => [ox + x * sx, oy + y * sy, oz + z * sz]);
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return f.flatMap((t) => t.flatMap((k) => v[k]));
}
const F = (a: number[]) => Float32Array.from(a);
const PLATE = plateFromArea(['0x0', '256x0', '256x256', '0x256 '])!;

test('separate: two disjoint cubes are 2 parts, cubes sharing a face are 1, one cube is 1', () => {
  // plant watched red: union-find never joined (each triangle its own part) -> 24 / 24 / 12.
  assert.equal(separate(F([...box(0, 0, 0, 10, 10, 10), ...box(30, 0, 0, 10, 10, 10)])).length, 2);
  assert.equal(separate(F([...box(0, 0, 0, 10, 10, 10), ...box(10, 0, 0, 10, 10, 10)])).length, 1);
  assert.equal(separate(F(box(0, 0, 0, 10, 10, 10))).length, 1);
});

test('separate: the weld is a tolerance, not a rounding — vertices 0.0004 mm apart across a rounding edge still join', () => {
  // 4.99995 and 5.00035 round apart at 1e-4 (toFixed(4)) but are within 1e-3 of each other.
  const a = box(0, 0, 0, 4.99995, 10, 10);
  const b = box(5.00035, 0, 0, 5, 10, 10);
  assert.equal(separate(F([...a, ...b]), 1e-3).length, 1);
  assert.equal(separate(F([...a, ...b]), 1e-5).length, 2);
});

test('separate: a degenerate fragment is kept in the list, flagged and named — never dropped silently', () => {
  // plant watched red: filtering degenerate components out of `separate`'s result -> length 2.
  const sliver = [0, 0, 0, 1, 0, 0, 0, 1, 0]; // one triangle, no volume
  const comps = separate(F([...box(0, 0, 0, 10, 10, 10), ...box(40, 0, 0, 0.5, 0.5, 0.5), ...sliver.map((v, i) => v + (i % 3 === 0 ? 80 : 0))]));
  assert.equal(comps.length, 3);
  assert.equal(comps.filter((c) => c.degenerate).length, 1);
  assert.match(comps.find((c) => c.degenerate)!.degenerate!, /not a closed solid/);
  assert.equal(comps.filter((c) => c.tiny).length, 1);
  const text = separationText('kit', comps, (k) => `kit_part${k + 1}`);
  assert.match(text, /3 objects separated, 2 added as parts/);
  assert.match(text, /Not added \(1\): kit_part3 \(1 x 1 x 0 mm, 1 triangle: not a closed solid\)/);
  assert.match(text, /Very small.*kit_part2 \(0\.5 x 0\.5 x 0\.5 mm\)/);
});

test('lay flat: a tilted box ends with a face on z = 0 (min z = 0, contact = its largest face)', () => {
  // plant watched red: the chosen rotation skipped (identity) -> contact 0, the box still on its edge.
  const m = rotMatrix([1, 0.4, 0.2], 0.7);
  const tilted = transformDrop(F(box(0, 0, 0, 40, 20, 5)), m);
  assert.ok(contactArea(tilted) < 1, 'precondition: the tilted box stands on an edge');
  const r = layFlat(tilted);
  assert.equal(r.found, true);
  const b = bbox(r.tri);
  assert.ok(Math.abs(b.min[2]) < 1e-4, `min z = ${b.min[2]}`);
  assert.ok(Math.abs(contactArea(r.tri) - 800) < 2, `contact ${contactArea(r.tri)}`);
  assert.ok(Math.abs(r.height - 5) < 0.01, `height ${r.height}`);
  assert.match(r.text, /laid on its 800 mm² face/);
});

test('lay flat: largest contact first, then lowest height; a part already flat is not turned', () => {
  const upright = F(box(0, 0, 0, 10, 10, 50)); // stands on 100 mm²; its 500 mm² side is the face to lie on
  const r = layFlat(upright);
  assert.ok(Math.abs(r.area - 500) < 0.5, `area ${r.area}`);
  assert.ok(Math.abs(r.height - 10) < 0.01);
  assert.ok(Math.abs(r.angle - 90) < 0.01);
  const flat = layFlat(F(box(0, 0, 0, 50, 10, 10)));
  assert.equal(flat.angle, 0);
  assert.match(flat.text, /already on its largest flat face/);
  // an L-shaped part: the hull face over the gap is NOT a mesh face, so it is not chosen.
  const L = F([...box(0, 0, 0, 30, 10, 5), ...box(0, 0, 5, 5, 10, 25)]);
  const rl = layFlat(L);
  assert.ok(contactArea(rl.tri) > 200, `L contact ${contactArea(rl.tri)}`);
  assert.ok(Math.abs(bbox(rl.tri).min[2]) < 1e-4);
});

test('lay flat: winding does not matter (an inside-out box lies the same way)', () => {
  const a = box(0, 0, 0, 10, 10, 50);
  const inv: number[] = [];
  for (let t = 0; t < a.length; t += 9) inv.push(...a.slice(t, t + 3), ...a.slice(t + 6, t + 9), ...a.slice(t + 3, t + 6));
  assert.ok(Math.abs(layFlat(F(inv)).height - 10) < 0.01);
});

test('rotate: a quarter turn about X stands a flat plate on its long edge face and back on the plate', () => {
  const r = rotatePart(F(box(0, 0, 0, 40, 20, 5)), 'x', 90);
  const s = sizeOf(bbox(r));
  assert.ok(Math.abs(s[2] - 20) < 1e-3 && Math.abs(s[1] - 5) < 1e-3, `size ${s}`);
  assert.ok(Math.abs(bbox(r).min[2]) < 1e-4);
});

test('arrange: no overlap, everything inside the plate, gap kept, centred', () => {
  // plant watched red: gap 0 in the shelf advance -> checkLayout reports "only 0 mm apart".
  const fps = Array.from({ length: 9 }, (_, i) => ({ w: 30 + i * 3, d: 20 + (i % 3) * 7 }));
  const a = arrange(fps, PLATE, { gap: 5 });
  assert.equal(a.plates, 1);
  assert.equal(a.tooBig.length, 0);
  assert.deepEqual(checkLayout(fps, a.placed, PLATE, 5), []);
  const xs = a.placed.map((p, i) => [p!.x - (p!.rot ? fps[i].d : fps[i].w) / 2, p!.x + (p!.rot ? fps[i].d : fps[i].w) / 2]);
  const minX = Math.min(...xs.map((x) => x[0])), maxX = Math.max(...xs.map((x) => x[1]));
  assert.ok(Math.abs((minX + maxX) / 2 - 128) < 0.01, 'centred in X');
});

test('arrange: too many for one plate go to a second plate, never overlapping, never outside', () => {
  // plant watched red: a new row always opened on plate 1 (no second plate) -> 1 plate, parts outside it.
  const fps = Array.from({ length: 12 }, () => ({ w: 80, d: 80 }));
  const a = arrange(fps, PLATE, { gap: 5 });
  assert.equal(a.plates, 2);
  assert.equal(a.placed.filter((p) => p?.plate === 1).length, 9);
  assert.equal(a.placed.filter((p) => p?.plate === 2).length, 3);
  assert.deepEqual(checkLayout(fps, a.placed, PLATE, 5), []);
});

test('arrange: a part too big is listed with its size, never placed; one that fits only turned is turned', () => {
  const fps = [{ w: 300, d: 20 }, { w: 20, d: 240 }, { w: 300, d: 300 }];
  const a = arrange(fps, { x0: 0, y0: 0, x1: 256, y1: 120 }, { gap: 5 });
  assert.equal(a.placed[0], null);
  assert.equal(a.placed[2], null);
  assert.deepEqual(a.tooBig.map((t) => t.index), [0, 2]);
  assert.match(a.tooBig[0].reason, /300 x 20 mm does not fit .* at any turn/);
  assert.equal(a.placed[1]!.rot, 90);
  assert.deepEqual(checkLayout(fps, a.placed, { x0: 0, y0: 0, x1: 256, y1: 120 }, 5), []);
});

test('checkLayout catches an overlap and an outside part on its own (it does not trust arrange)', () => {
  const fps = [{ w: 20, d: 20 }, { w: 20, d: 20 }];
  assert.match(checkLayout(fps, [{ plate: 1, x: 50, y: 50, rot: 0 }, { plate: 1, x: 60, y: 50, rot: 0 }], PLATE, 5)[0], /overlapping/);
  assert.match(checkLayout(fps, [{ plate: 1, x: 5, y: 50, rot: 0 }, null], PLATE, 5)[0], /outside plate 1/);
  assert.deepEqual(checkLayout(fps, [{ plate: 1, x: 50, y: 50, rot: 0 }, { plate: 2, x: 50, y: 50, rot: 0 }], PLATE, 5), []);
});

test('footprint and plate parsing', () => {
  const fp = footprintOf(F(box(3, 4, 0, 10, 20, 5)));
  assert.deepEqual([fp.w, fp.d], [10, 20]);
  // the outline is the box's top and bottom faces (edge-on side faces dropped), around the box centre
  assert.equal(fp.outline!.length, 4 * 6);
  assert.ok(Math.max(...fp.outline!.map(Math.abs)) <= 10 + 1e-6);
  assert.equal(footprintOf(F(box(3, 4, 0, 10, 20, 5))) === fp, false, 'a new mesh is a new footprint');
  assert.deepEqual(plateFromArea(['0x0', '256x0', '256x256', '0x256 ']), { x0: 0, y0: 0, x1: 256, y1: 256 });
  assert.equal(plateFromArea(['nonsense']), null);
  assert.equal(plateFromArea(null), null);
});

test('layout actions from the model: checked one by one, unknown ones refused', () => {
  const v = validateLayoutActions(
    [{ do: 'separate' }, { do: 'lay_flat' }, { do: 'lay_flat', part: 2 }, { do: 'arrange' }, { do: 'rotate', part: 1, axis: 'x', deg: 90 }, { do: 'rotate', part: 9, axis: 'x', deg: 90 }, { do: 'rotate', part: 1, axis: 'q', deg: 90 }, { do: 'delete_everything' }],
    3,
  );
  assert.deepEqual(v.accepted, [{ do: 'separate' }, { do: 'lay_flat', part: null }, { do: 'lay_flat', part: 2 }, { do: 'arrange' }, { do: 'rotate', part: 1, axis: 'x', deg: 90 }]);
  assert.equal(v.refused.length, 3);
  assert.deepEqual(validateLayoutActions('separate', 3).accepted, []);
  assert.equal(validateLayoutActions([{ do: 'arrange' }], 0).accepted.length, 0);
});

test('a reply that sends the person to another slicer program loses those sentences', () => {
  const r = scrubOtherPrograms('Cannot do. Use OrcaSlicer: Arrange button (A key). Done otherwise. Try Bambu Studio.');
  assert.equal(r.text, 'Cannot do. Done otherwise.');
  assert.equal(r.dropped, 2);
  assert.equal(scrubOtherPrograms('More walls.').dropped, 0);
});

test('the assistant: no other program in its instruction, layout actions only on the 3d tab, a reply naming OrcaSlicer is scrubbed', async () => {
  const { PRINT_SYSTEM_INSTRUCTION, PRINT_LAYOUT_INSTRUCTION, readPrintProposal, buildPrintRequest } = await import('../src/make/printJob/ai.ts');
  for (const ins of [PRINT_SYSTEM_INSTRUCTION, PRINT_LAYOUT_INSTRUCTION]) {
    assert.ok(!/orca/i.test(ins), 'the instruction names no slicer program');
    assert.match(ins, /NEVER tell the person to use another program/);
  }
  assert.match(PRINT_LAYOUT_INSTRUCTION, /"do": "lay_flat"/);
  assert.ok(!/"do": "lay_flat"/.test(PRINT_SYSTEM_INSTRUCTION));
  // the founder's exchange, replayed as the model's answer
  const reply = JSON.stringify({
    reply: 'Cannot do. No key for object separation. Use OrcaSlicer: Arrange button (A key), Lay on face tool (F key). Separating, laying flat and arranging now.',
    overrides: {},
    actions: [{ do: 'separate' }, { do: 'lay_flat' }, { do: 'arrange' }, { do: 'rotate', part: 7, axis: 'x', deg: 90 }],
  });
  const p3d = readPrintProposal(reply, 2);
  assert.deepEqual(p3d.actions, [{ do: 'separate' }, { do: 'lay_flat', part: null }, { do: 'arrange' }]);
  assert.ok(!/orca/i.test(p3d.reply), p3d.reply);
  assert.equal(p3d.scrubbed, 1);
  assert.ok(p3d.refused.some((r) => /part must be 1\.\.2/.test(r.why)));
  // the Make step offers no layout: actions are refused there, never applied
  const make = readPrintProposal(reply);
  assert.deepEqual(make.actions, []);
  assert.ok(make.refused.some((r) => r.key === 'actions'));
  // the 3d tab sends its parts as data and gets the layout instruction
  const cfg = { endpoint: 'http://127.0.0.1:1/v1/chat/completions', model: 'm', apiKey: '', timeoutMs: 1000 } as never;
  const req = buildPrintRequest(cfg, 'arrange', { design: 'kit', slot: null, current: {}, parts: [{ name: 'a', size: '1 x 1 x 1 mm', plate: 1 }] });
  const msgs = (req.body as { messages: { content: string }[] }).messages;
  assert.equal(msgs[0].content, PRINT_LAYOUT_INSTRUCTION);
  assert.deepEqual(JSON.parse(msgs[1].content).job.parts, [{ n: 1, name: 'a', size: '1 x 1 x 1 mm', plate: 1 }]);
});

/**
 * A stand-in for the sill planter bracket (founder 2026-11-13: 3 of them went on 2 plates):
 * same 159.3 x 88.34 x 20 mm box, a top flange, an end post and a diagonal strut, so its
 * outline fills about a quarter of its box, as the real part's does (24 %).
 */
function prism(poly: [number, number][], h: number): number[] {
  const out: number[] = [];
  const n = poly.length;
  for (let i = 1; i + 1 < n; i++) {
    out.push(poly[0][0], poly[0][1], 0, poly[i + 1][0], poly[i + 1][1], 0, poly[i][0], poly[i][1], 0);
    out.push(poly[0][0], poly[0][1], h, poly[i][0], poly[i][1], h, poly[i + 1][0], poly[i + 1][1], h);
  }
  for (let i = 0; i < n; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % n];
    out.push(ax, ay, 0, bx, by, 0, bx, by, h, ax, ay, 0, bx, by, h, ax, ay, h);
  }
  return out;
}
function bracket(): Float32Array {
  const W = 159.3, D = 88.34, H = 20;
  return F([
    ...prism([[0, D - 10], [W, D - 10], [W, D], [0, D]], H), // top flange
    ...prism([[W - 14, 0], [W, 0], [W, D - 10], [W - 14, D - 10]], H), // end post
    ...prism([[14, D - 10], [26, D - 10], [W - 14, 6], [W - 14, 18]], H), // diagonal strut
  ]);
}

test('arrange: three brackets whose boxes do not fit one plate nest on ONE by their outlines', () => {
  // plant watched red: grow() with gap 0 (no halo) -> checkLayout "only 0.x mm apart" / "overlapping".
  const b = bracket();
  const fp = footprintOf(b);
  assert.ok(Math.abs(fp.w - 159.3) < 1e-3 && Math.abs(fp.d - 88.34) < 1e-3);
  const fps = [fp, fp, fp];
  // as boxes they need two plates (159.3 + 5 + 88.34 > 252, 3 x 88.34 + 10 > 252)
  const boxes = arrange(fps.map((f) => ({ w: f.w, d: f.d })), PLATE, { gap: 5 });
  assert.equal(boxes.plates, 2);
  const t0 = performance.now();
  const a = arrange(fps, PLATE, { gap: 5 });
  const ms = performance.now() - t0;
  assert.equal(a.plates, 1, JSON.stringify(a.placed));
  assert.deepEqual(checkLayout(fps, a.placed, PLATE, 5), []);
  assert.ok(ms < 3000, `arrange took ${ms.toFixed(0)} ms`);
  console.log(`# arrange ${fps.length} parts: ${ms.toFixed(0)} ms`);
});

test('checkLayout measures outlines: nested brackets pass, the same brackets pushed together are refused', () => {
  // plant watched red: the pair check returning early (no distance check) -> the pushed pairs below pass.
  const fp = footprintOf(bracket());
  const big = { x0: -100, y0: -100, x1: 400, y1: 400 };
  // one turned 180 deg, one 120 deg into its empty corner (an arrangement arrange() produced): 6.1 mm apart
  const nested = [{ plate: 1, x: 90.15, y: 174.42, rot: 180 }, { plate: 1, x: 235.08, y: 127.81, rot: 120 }];
  assert.match(checkLayout([{ w: fp.w, d: fp.d }, { w: fp.w, d: fp.d }], nested, big, 5)[0] ?? '', /overlapping/, 'as boxes they collide');
  assert.deepEqual(checkLayout([fp, fp], nested, big, 5), [], 'as outlines they are 6.1 mm apart');
  assert.match(checkLayout([fp, fp], nested, big, 7)[0] ?? '', /only 6.1 mm apart/);
  assert.match(checkLayout([fp, fp], [nested[0], { ...nested[1], x: nested[1].x - 2 }], big, 5)[0] ?? '', /only 4.4 mm apart/);
  assert.match(checkLayout([fp, fp], [nested[0], { ...nested[1], x: nested[1].x - 60 }], big, 5)[0] ?? '', /overlapping/);
  assert.match(checkLayout([fp], [{ plate: 1, x: 240, y: 100, rot: 0 }], PLATE, 5)[0] ?? '', /outside plate 1/);
});

test('arrange: twenty small mixed parts, one plate, checked, quick', () => {
  const fps = Array.from({ length: 20 }, (_, i) => footprintOf(F(i % 2 ? box(0, 0, 0, 20 + i, 15 + (i % 5) * 4, 10) : bracketSmall(i))));
  const t0 = performance.now();
  const a = arrange(fps, PLATE, { gap: 5 });
  const ms = performance.now() - t0;
  assert.equal(a.tooBig.length, 0);
  assert.equal(a.plates, 1);
  assert.deepEqual(checkLayout(fps, a.placed, PLATE, 5), []);
  assert.ok(ms < 3000, `arrange took ${ms.toFixed(0)} ms`);
  console.log(`# arrange ${fps.length} parts: ${ms.toFixed(0)} ms`);
});
function bracketSmall(i: number): number[] {
  const s = 0.2 + (i % 4) * 0.03;
  return prism([[0, 0], [159.3 * s, 0], [159.3 * s, 88.34 * s], [0, 10 * s]], 10);
}
