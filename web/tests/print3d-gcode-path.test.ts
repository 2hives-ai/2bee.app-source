// The sliced-plate preview's reader (web/src/print3d/gcodePath.ts): what it draws must be what the G-code says.
// Synthetic programs pin each rule; the real-file test slices the pot saucer (hardware/cad, rendered by this app's
// own SCAD evaluator) through 2bee.fdm's fdmslice and checks the parse against counts taken from the EMITTED text by
// a second, independent reading. Without fdmslice or the X2D preset files that test is SKIPPED with `PENDING:`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GcodeParseError, PATH_KINDS, layerRange, parseGcode, type PathKind, type Toolpath } from '../src/print3d/gcodePath.ts';
import { parseScad } from '../src/cad/scad';
import { meshScene } from '../src/cad/mesh';
import { writeBinaryStl } from '../src/print3d/model.ts';

const segs = (t: Toolpath, k: PathKind) => t.kinds[k].pos.length / 6;
const seg = (t: Toolpath, k: PathKind, i: number) => Array.from(t.kinds[k].pos.slice(6 * i, 6 * i + 6)).map((v) => Math.round(v * 1000) / 1000);

test('relative E (M83): extrusion vs travel, features, CHANGE_LAYER + Z_HEIGHT layers, start/end G-code not drawn', () => {
  const g = [
    'G28', 'M83', 'G1 X0 Y0 Z5 F6000', 'G1 X50 Y0 E2 ; purge, start G-code',
    '; MACHINE_START_GCODE_END',
    '; CHANGE_LAYER', '; Z_HEIGHT: 0.2', 'G1 X10 Y10 F6000', 'G1 Z.2',
    '; FEATURE: Outer wall', 'G1 X20 Y10 E.5', 'G1 X20 Y20 E.5',
    '; FEATURE: Sparse infill', 'G1 E.8', 'G1 X10 Y20 E.3', 'G1 X12 Y20 E-.4 ; wipe: retracts while moving',
    '; CHANGE_LAYER', '; Z_HEIGHT: 0.4', 'G1 Z.4', '; FEATURE: Inner wall', 'G1 X10 Y10 E.2',
    '; FEATURE: Wobble', 'G1 X11 Y10 E.1',
    '; MACHINE_END_GCODE_START', 'G1 X100 Y100 E5',
  ].join('\n');
  const t = parseGcode(g);
  assert.equal(t.eMode, 'relative');
  assert.equal(t.layerSource, 'CHANGE_LAYER');
  assert.deepEqual(t.layers.map((l) => l.z), [0.2, 0.4]);
  assert.equal(segs(t, 'outer'), 2);
  assert.equal(segs(t, 'infill'), 1, 'the E-only unretract draws nothing');
  assert.equal(segs(t, 'inner'), 1);
  assert.deepEqual(seg(t, 'outer', 0), [10, 10, 0.2, 20, 10, 0.2]);
  assert.equal(segs(t, 'other'), 1, 'an unknown feature is drawn as other');
  assert.deepEqual(t.unknownFeatures, ['Wobble']);
  // travel: the move to 10,10 (layer 1), the wipe (E decrease with XY), none from the start or end G-code
  assert.equal(segs(t, 'travel'), 2);
  assert.deepEqual(seg(t, 'travel', 1), [10, 20, 0.2, 12, 20, 0.2]);
  assert.ok(Math.abs(t.extrudedE - (0.5 + 0.5 + 0.3 + 0.2 + 0.1)) < 1e-9);
  assert.deepEqual(Array.from(t.kinds.outer.layerEnd), [2, 2]);
  assert.deepEqual(layerRange(t.kinds.inner, 1), [0, 1]);
  assert.deepEqual(t.bbox, { min: [10, 10, 0.2], max: [20, 20, 0.4] });
  assert.match(t.notDrawn.join(';'), /start G-code/);
  assert.match(t.notDrawn.join(';'), /end G-code/);
});

test('absolute E (M82) with G92 resets; layers from Z moves when there are no markers', () => {
  const g = ['M82', 'G92 E0', 'G1 X0 Y0 Z.3', 'G1 X10 Y0 E1', 'G1 X10 Y10 E3', 'G92 E0', 'G1 X0 Y10 E.5', 'G1 Z.6', 'G1 X0 Y0 E1.5', 'G1 X5 Y0 E1.4'].join('\n');
  const t = parseGcode(g);
  assert.equal(t.eMode, 'absolute');
  assert.equal(t.layerSource, 'Z moves');
  assert.deepEqual(t.layers.map((l) => l.z), [0.3, 0.6]);
  assert.equal(segs(t, 'other'), 4, 'no FEATURE comments: extrusion is other');
  assert.equal(segs(t, 'travel'), 1, 'the E decrease 1.5 -> 1.4 with XY is travel');
  assert.ok(Math.abs(t.extrudedE - (1 + 2 + 0.5 + 1)) < 1e-9, `E sum ${t.extrudedE}`);
});

test('G2/G3: segments lie on the circle, go the commanded way round, and end exactly at the endpoint', () => {
  const g = ['M83', '; CHANGE_LAYER', '; Z_HEIGHT: 0.2', 'G1 X10 Y0 Z.2', '; FEATURE: Outer wall', 'G3 X0 Y10 I-10 J0 E1', 'G2 X10 Y0 I0 J-10 E1'].join('\n');
  const t = parseGcode(g);
  assert.equal(t.arcs, 2);
  const p = t.kinds.outer.pos;
  const n = p.length / 6;
  assert.ok(n > 20, `a quarter arc of r=10 at 0.01 mm chord error needs many segments (got ${n})`);
  for (let i = 0; i < n; i++) {
    for (const o of [0, 3]) {
      assert.ok(Math.abs(Math.hypot(p[6 * i + o], p[6 * i + o + 1]) - 10) < 1e-3, 'every vertex on r=10');
      // CCW (10,0)->(0,10) and CW (0,10)->(10,0) about the origin are both the short quarter in +X+Y
      assert.ok(p[6 * i + o] >= -1e-6 && p[6 * i + o + 1] >= -1e-6, 'an arc went the wrong way round');
    }
  }
  const last = Array.from(p.slice(6 * (n - 1) + 3, 6 * n)).map((v) => Math.round(v * 1e4) / 1e4);
  assert.deepEqual(last, [10, 0, 0.2]);
  assert.ok(Math.abs(t.extrudedE - 2) < 1e-9);
  // CW from (0,10) to (-10,0) about the origin is the LONG way (270 degrees, through -Y)
  const long = parseGcode(['M83', '; CHANGE_LAYER', 'G1 X0 Y10 Z.2', 'G2 X-10 Y0 I0 J-10 E1'].join('\n')).kinds.other.pos;
  let minY = Infinity;
  for (let i = 1; i < long.length; i += 3) minY = Math.min(minY, long[i]);
  assert.ok(minY < -9.99, `G2 took the short way (min y ${minY})`);
  // R form: a quarter circle from (10,0) to (0,10), CCW, R10 -> centre (0,0)
  const r = parseGcode(['M83', '; CHANGE_LAYER', 'G1 X10 Y0 Z.2', 'G3 X0 Y10 R10 E1'].join('\n'));
  const q = r.kinds.other.pos;
  for (let i = 0; i < q.length; i += 3) assert.ok(Math.abs(Math.hypot(q[i], q[i + 1]) - 10) < 1e-3);
});

test('refusals: no E mode, an arc that defines no centre, words without spaces, a file with no extrusion', () => {
  assert.throws(() => parseGcode(['; CHANGE_LAYER', 'G1 X0 Y0 Z.2', 'G1 X10 Y0 E1'].join('\n')), (e) => e instanceof GcodeParseError && /M82 or M83/.test(e.message) && e.line === 3);
  assert.throws(() => parseGcode(['M83', '; CHANGE_LAYER', 'G1 X0 Y0 Z.2', 'G2 X10 Y0 E1'].join('\n')), /neither I\/J nor R/);
  assert.throws(() => parseGcode(['M83', '; CHANGE_LAYER', 'G1X10Y0E1'].join('\n')), /without spaces/);
  assert.throws(() => parseGcode(['M83', '; CHANGE_LAYER', 'G1 X0 Y0 Z.2', 'G1 X10 Y0'].join('\n')), /not one extruding move/);
  assert.throws(() => parseGcode(''), GcodeParseError);
});

// ── the real file ─────────────────────────────────────────────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '../..');
const FDM = path.join(APP, 'target/release/fdmslice');
const ORCA = path.join(os.homedir(), '.config/OrcaSlicer');
const MACHINE = path.join(ORCA, 'system/BBL/machine/Bambu Lab X2D 0.4 nozzle.json');
const DEFAULTS = path.join(APP, 'tools/print3d-bridge/orca-defaults-x2d.config');
const SCAD = path.resolve(APP, '../../hardware/cad/2bee_household/pot_saucer_18cm_3d.scad');

/** A second, deliberately naive reading of the same text: line-by-line regexes, no shared code with the parser. */
function independentCounts(text: string) {
  const lines = text.split('\n');
  const first = lines.findIndex((l) => l.startsWith('; CHANGE_LAYER'));
  const end = lines.findIndex((l) => l.startsWith('; MACHINE_END_GCODE_START'));
  let e = 0, moves = 0, arcs = 0;
  const features = new Map<string, number>();
  let feat = '';
  for (let i = first; i < (end < 0 ? lines.length : end); i++) {
    const l = lines[i];
    const fm = /^; FEATURE: (.*)$/.exec(l);
    if (fm) feat = fm[1].trim();
    const m = /^G([0-3]) (.*)$/.exec(l.split(';')[0].trim());
    if (!m) continue;
    const xy = /(^| )[XY]-?[\d.]/.test(m[2]) || (m[1] >= '2' && /(^| )[IJ]/.test(m[2]));
    const em = /(?:^| )E(-?[\d.]+)/.exec(m[2]);
    if (m[1] >= '2') arcs++;
    if (xy && em && Number(em[1]) > 0) {
      e += Number(em[1]);
      moves++;
      features.set(feat, (features.get(feat) ?? 0) + 1);
    }
  }
  return { layers: lines.filter((l) => l.startsWith('; CHANGE_LAYER')).length, e, moves, arcs, features };
}

test('REAL FILE: the pot saucer sliced by 2bee.fdm parses to the layers, extrusion and features its G-code states', { timeout: 120000 }, (t) => {
  if (!fs.existsSync(FDM) || !fs.existsSync(MACHINE) || !fs.existsSync(SCAD)) {
    t.skip(`PENDING: needs ${FDM} (cargo build --release -p twobee-fdm), the X2D preset files under ${ORCA}, and ${SCAD}`);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcode-path-'));
  try {
    const mesh = meshScene(parseScad(fs.readFileSync(SCAD, 'utf8'), { render: true }).scene);
    const tri = new Float32Array(mesh.parts.reduce((n, p) => n + p.positions.length, 0));
    let o = 0;
    for (const p of mesh.parts) { tri.set(p.positions, o); o += p.positions.length; }
    const stl = path.join(dir, 'saucer.stl');
    fs.writeFileSync(stl, Buffer.from(writeBinaryStl(tri)));
    const out = path.join(dir, 'plate_1.gcode');
    // the same argv shape tools/print3d-bridge/engine.cjs uses for a placed plate
    const r = spawnSync(FDM, ['--presets', '--machine', 'Bambu Lab X2D 0.4 nozzle', '--process', '0.20mm Standard @BBL X2D', '--filament', 'Generic ASA @BBL X2D 0.4 nozzle',
      '--config-dir', ORCA, '--defaults', DEFAULTS, '--set', 'curr_bed_type=Textured PEI Plate', '--report', path.join(dir, 'report.json'), '--out', out, '--auto-walls', `${stl}@128,128`], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const text = fs.readFileSync(out, 'utf8');
    const t0 = performance.now();
    const tp = parseGcode(text);
    const ms = performance.now() - t0;
    const ind = independentCounts(text);

    assert.equal(tp.layerSource, 'CHANGE_LAYER');
    assert.equal(tp.layers.length, ind.layers);
    assert.equal(tp.layers.length, 100, '20 mm at 0.2 mm');
    assert.ok(Math.abs(tp.layers[0].z - 0.2) < 1e-9 && Math.abs(tp.layers[99].z - 20) < 1e-6, `layer Z ${tp.layers[0].z} .. ${tp.layers[99].z}`);
    for (let i = 1; i < tp.layers.length; i++) assert.ok(tp.layers[i].z > tp.layers[i - 1].z, `layer ${i} is not above layer ${i - 1}`);
    assert.ok(Math.abs(tp.extrudedE - ind.e) < 1e-6 * ind.e, `parsed E ${tp.extrudedE} vs the text's ${ind.e}`);
    assert.equal(tp.arcs, ind.arcs);
    // every extruding line produced at least one segment, and an arc produced more than one
    assert.ok(tp.extrusionSegments >= ind.moves, `${tp.extrusionSegments} segments for ${ind.moves} extruding lines`);
    for (const [name, n] of ind.features) assert.ok((tp.features[name] ?? 0) >= n, `feature "${name}": ${tp.features[name]} segments for ${n} lines`);
    assert.deepEqual(tp.unknownFeatures, [], 'every feature 2bee.fdm emitted for the saucer has a colour');
    assert.ok(segs(tp, 'outer') > 0 && segs(tp, 'inner') > 0 && segs(tp, 'infill') > 0 && segs(tp, 'solid') > 0 && segs(tp, 'skirt') > 0);
    // where the part is: a 144.8 mm saucer centred at 128,128
    const bb = tp.bbox!;
    const w = bb.max[0] - bb.min[0];
    assert.ok(Math.abs((bb.min[0] + bb.max[0]) / 2 - 128) < 1 && Math.abs((bb.min[1] + bb.max[1]) / 2 - 128) < 1, `centre ${JSON.stringify(bb)}`);
    assert.ok(w > 144 && w < 165, `extrusion width ${w} mm (the saucer is 144.8 mm, plus its brim)`);
    // per-layer offsets are cumulative and end at the buffer length
    for (const k of PATH_KINDS) {
      const le = tp.kinds[k].layerEnd;
      assert.equal(le.length, tp.layers.length);
      assert.equal(le[le.length - 1], segs(tp, k));
      for (let i = 1; i < le.length; i++) assert.ok(le[i] >= le[i - 1]);
    }
    t.diagnostic(`${(text.length / 1e6).toFixed(2)} MB, ${tp.layers.length} layers, ${tp.extrusionSegments} extrusion + ${tp.travelSegments} travel segments, ${tp.arcs} arcs, parsed in ${ms.toFixed(0)} ms`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
