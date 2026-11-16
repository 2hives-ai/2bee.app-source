// VENDORED from pnp's 2bee.3d: /home/gbacs/build/web-slicer/beds.js.js at commit 65227d3 (unchanged vs HEAD on 2026-10-15).
// Source sha256: 81b14c1a46b7d40c101d6e0907e1be3f5d07b5e436bbc5584a582bcead5d2e63
// Only edits: this 3-line header and require('./x') -> require('./x.cjs'). Re-vendor rather than edit; see README.md.
'use strict';
// beds.js: pure helpers for multiple-bed planning (no Orca, no HTTP): geometry of one STL, the four assignment strategies,
// and the validator for an assignment that comes from outside (the AI). server.js does the real arrangement of each bed with Orca.
//
// Bed numbers are 1-based everywhere ("Bed 1"). An ASSIGNMENT is an array bedOf[objectIndex] = bed number.
const jobs = require('./jobs.cjs');

const GAP = 8;            // mm of spacing the capacity estimate adds around every footprint (Orca's own arrange spacing is a bit smaller)
const FILL = 0.62;        // fraction of the bed area the estimate allows to be filled: a PRE-estimate only, Orca's real arrangement decides
const LAYER_MM = 0.2;     // heuristic only (time estimate for the balance strategy)

function volumeOf(t) { let v = 0; for (let i = 0; i < t.length; i += 9) {
  v += (t[i] * (t[i + 4] * t[i + 8] - t[i + 5] * t[i + 7]) - t[i + 1] * (t[i + 3] * t[i + 8] - t[i + 5] * t[i + 6]) + t[i + 2] * (t[i + 3] * t[i + 7] - t[i + 4] * t[i + 6])) / 6; } return Math.abs(v); }

// Smallest axis-aligned XY box over rotations 0..175 deg (5 deg steps): can the part lie on a W x D bed at all?
function minFootprint(t, bedWD) {
  const step = Math.max(1, Math.floor(t.length / 3 / 40000)), pts = [];
  for (let i = 0; i < t.length; i += 3 * step) pts.push(t[i], t[i + 1]);
  let best = null, fitsRot = false;
  for (let a = 0; a < 180; a += 5) {
    const c = Math.cos(a * Math.PI / 180), s = Math.sin(a * Math.PI / 180); let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < pts.length; i += 2) { const x = pts[i] * c - pts[i + 1] * s, y = pts[i] * s + pts[i + 1] * c; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const w = x1 - x0, d = y1 - y0;
    if (bedWD && w <= bedWD[0] && d <= bedWD[1]) fitsRot = true;
    if (!best || w * d < best.w * best.d) best = { w, d, rot: a };
  }
  best.fitsRot = fitsRot; return best;
}

// Per object facts used by the strategies. tris = Float32Array of the STL.
function objInfo(tris, slot, name, bed) {
  const bb = jobs.bboxOf(tris), w = bb.max[0] - bb.min[0], d = bb.max[1] - bb.min[1], h = bb.max[2] - bb.min[2];
  const mf = minFootprint(tris, bed ? [bed.w, bed.d] : null), vol = volumeOf(tris);
  const area = (w + GAP) * (d + GAP);
  // heuristic print time: 35 % of the volume is extruded (walls + infill + skins) at ~10 mm3/s, plus ~8 s per layer. Labelled "heuristic" everywhere it is shown.
  const timeSec = vol * 0.35 / 10 + (h / LAYER_MM) * 8;
  return { slot, name, w, d, h, vol, area, minW: mf.w, minD: mf.d, fitsRot: mf.fitsRot, timeSec };
}
// Does it fit the bed alone (any rotation) and in height? -> null or the reason text
function tooBigReason(info, bed) {
  const f = (v) => Math.round(v * 10) / 10;
  if (info.h > bed.h + 1e-6) return `too tall for the bed: ${f(info.h)} mm high, the printer's limit is ${f(bed.h)} mm`;
  const fits = (w, d) => w <= bed.w + 1e-6 && d <= bed.d + 1e-6;
  if (!(fits(info.w, info.d) || fits(info.d, info.w) || info.fitsRot))
    return `too big for the bed: ${f(info.w)} x ${f(info.d)} mm footprint (smallest rotated box ${f(info.minW)} x ${f(info.minD)} mm), the bed is ${f(bed.w)} x ${f(bed.d)} mm`;
  return null;
}

const capacity = (bed) => bed.w * bed.d * FILL;
// Next-fit by estimated area, in the given order. Returns bedOf (1-based) for the indices in `order`.
function nextFit(order, infos, bed, bedOf, firstBed) {
  let b = firstBed, used = 0;
  for (const i of order) {
    if (used > 0 && used + infos[i].area > capacity(bed)) { b++; used = 0; }
    bedOf[i] = b; used += infos[i].area;
  }
  return b;
}

// ---- strategies: (infos, ids, bed, opts) -> bedOf (array over ALL indices, undefined for ids not in `ids`)
const STRATEGIES = {
  fit: { label: 'Fit as many as possible on bed 1', hint: 'Orca arranges as many parts as fit on bed 1, the rest go to bed 2, 3 ...', fn: null },
  filament: { label: 'Group by filament', hint: 'Parts of the same filament slot share a bed and no bed mixes slots: no filament changes, no wipe tower (may need one more bed).',
    fn(infos, ids, bed) {
      const by = new Map(); for (const i of ids) { const k = infos[i].slot; if (!by.has(k)) by.set(k, []); by.get(k).push(i); }
      const groups = [...by.entries()].sort((a, b) => b[1].reduce((s, i) => s + infos[i].area, 0) - a[1].reduce((s, i) => s + infos[i].area, 0) || (a[0] < b[0] ? -1 : 1));
      // every slot starts its own bed(s): no bed mixes slots, so no filament change (and no wipe tower) at all, at the price of maybe one more bed
      const bedOf = []; let next = 1;
      for (const [, g] of groups) next = nextFit(g.sort((x, y) => infos[y].area - infos[x].area || x - y), infos, bed, bedOf, next) + 1;
      return bedOf;
    } },
  balance: { label: 'Balance print time across beds', hint: 'Spreads the parts so every bed takes about the same time (a size/height estimate, not a slice).',
    fn(infos, ids, bed) {
      const total = ids.reduce((s, i) => s + infos[i].area, 0), k = Math.max(1, Math.ceil(total / capacity(bed)));
      const beds = Array.from({ length: k }, () => ({ area: 0, time: 0 })), bedOf = [];
      for (const i of [...ids].sort((x, y) => infos[y].timeSec - infos[x].timeSec || x - y)) {
        let cand = beds.map((b, n) => n).filter((n) => beds[n].area + infos[i].area <= capacity(bed));
        if (!cand.length) { beds.push({ area: 0, time: 0 }); cand = [beds.length - 1]; }
        const n = cand.sort((a, b) => beds[a].time - beds[b].time || a - b)[0];
        beds[n].area += infos[i].area; beds[n].time += infos[i].timeSec; bedOf[i] = n + 1;
      }
      return bedOf;
    } },
  tall: { label: 'Keep tall parts apart', hint: 'Parts taller than the limit (default 100 mm) get their own bed(s); the rest share the other beds.',
    fn(infos, ids, bed, opts) {
      const lim = Number(opts && opts.tallMm) > 0 ? Number(opts.tallMm) : 100, bedOf = [];
      const tall = ids.filter((i) => infos[i].h > lim).sort((x, y) => infos[y].h - infos[x].h || x - y), rest = ids.filter((i) => infos[i].h <= lim).sort((x, y) => infos[y].area - infos[x].area || x - y);
      let b = 0; if (tall.length) b = nextFit(tall, infos, bed, bedOf, 1);
      if (rest.length) nextFit(rest, infos, bed, bedOf, b + 1);
      return bedOf;
    } },
};
const strategyList = () => Object.entries(STRATEGIES).map(([id, s]) => ({ id, label: s.label, hint: s.hint }));

// ---- validate an assignment that came from outside (the AI, a saved job): every object exactly once, valid indices, bed numbers 1..maxBeds.
// Input: array of {object, bed}. Returns { ok:true, bedOf:[...] } or { ok:false, reason }. Never throws, never trusts a field it does not need.
function validateAssignment(list, nObjects, maxBeds) {
  if (!Array.isArray(list)) return { ok: false, reason: 'assignment is not a list' };
  if (list.length !== nObjects) return { ok: false, reason: `assignment lists ${list.length} objects, the job has ${nObjects}: every object must be assigned exactly once` };
  const bedOf = new Array(nObjects).fill(null);
  for (const e of list) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return { ok: false, reason: 'assignment entry is not an object' };
    const o = e.object, b = e.bed;
    if (!Number.isInteger(o) || o < 0 || o >= nObjects) return { ok: false, reason: `object index ${JSON.stringify(o)} is not a valid object (0..${nObjects - 1})` };
    if (!Number.isInteger(b) || b < 1) return { ok: false, reason: `bed ${JSON.stringify(b)} for object ${o} is not a whole number, 1 or more` };
    if (bedOf[o] !== null) return { ok: false, reason: `object ${o} is assigned twice` };
    bedOf[o] = b;
  }
  const used = [...new Set(bedOf)].sort((a, b) => a - b);
  if (used.some((b, i) => b !== i + 1)) return { ok: false, reason: `beds must be numbered 1..n without gaps (got ${used.join(', ')})` };
  return { ok: true, bedOf };
}


// =========================== arrangement objectives: candidates scored from REAL slices ===========================
// For one bed the server arranges the same objects several ways, slices each way with Orca and measures the G-code (gcodeFacts + a few geometry facts).
// A candidate is scored against the DEFAULT arrangement (Orca's own): score = sum over metrics of weight * relative change (negative = better than the default).
// The default stays unless a candidate beats it by more than MARGIN. Nothing is claimed that was not measured: the reason text is built from the measured numbers.
const OBJECTIVES = {
  fastest:  { label: 'Fastest',      blurb: 'shortest estimated print time (Orca\'s own estimate); travel and retractions count a little because they cost time',
              w: { time: 1.00, travel: 0.10, retract: 0.05, support: 0.05, overhang: 0.00, contact: 0.00, slow: 0.05, centre: 0.00, tall: 0.00 } },
  quality:  { label: 'Best quality', blurb: 'least support and overhang, most first-layer contact, fewest layers cooled/slowed to the minimum layer time, parts near the bed centre, tall slender parts kept central; time counts little',
              w: { time: 0.15, travel: 0.15, retract: 0.15, support: 0.50, overhang: 0.40, contact: 0.30, slow: 0.35, centre: 0.15, tall: 0.30 } },
  balanced: { label: 'Balanced',     blurb: 'time first, quality second: half the weight on time, the rest spread over support, overhang, contact, slowed layers and travel',
              w: { time: 0.50, travel: 0.10, retract: 0.10, support: 0.25, overhang: 0.20, contact: 0.15, slow: 0.20, centre: 0.08, tall: 0.15 } },
};
const DEFAULT_OBJECTIVE = 'balanced';
// relative change is measured against max(default value, floor), so a metric that is 0 in the default still has a scale
const FLOORS = { time: 60, travel: 500, retract: 20, support: 100, overhang: 100, contact: 200, slow: 3, centre: 20, tall: 1 };
const HIGHER_BETTER = { contact: true };
const MARGIN = 0.02;          // a candidate must beat the default by this much (2 % of one fully weighted metric) to replace it
const MAX_CANDIDATES = 4;     // slices per bed, the default one included: at most 3 extra
const METRIC_UNITS = { time: 's', travel: 'mm', retract: '', support: 'mm', overhang: 'mm', contact: 'mm', slow: ' layers', centre: 'mm', tall: '' };

// total time text of Orca ("1d 2h 3m 4s") -> seconds
function secs(t) { const m = String(t || '').match(/(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/); return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0; }
const dur = (s) => { s = Math.round(Math.abs(s)); if (s < 90) return s + ' s'; if (s < 5400) return Math.floor(s / 60) + ' min' + (s % 60 >= 10 && s < 600 ? ' ' + (s % 60) + ' s' : ''); return Math.floor(s / 3600) + ' h ' + Math.round(s % 3600 / 60) + ' min'; };

// One pass over Orca's G-code: the measurable facts the objectives use. Pure.
//   layers, travelMm (non-extruding XY moves after the first layer change), retractions (negative-E moves), supportMm / overhangMm (extruded path length of
//   the Support* / Overhang wall features), firstLayerMm (extruded path of layer 1, skirt excluded), slowLayers (layers 2.. whose estimated time is under
//   the slow-down-layer-time of the filament: those are the layers Orca slows or that run hot), layerSecEst (crude: path / programmed feed, no acceleration).
function gcodeFacts(text) {
  const g = (re) => { const m = text.match(re); return m ? Number(m[1]) : NaN; };
  const slowLimit = g(/^; slow_down_layer_time = (\d+(?:\.\d+)?)/m);
  let layer = 0, feat = '', x = 0, y = 0, f = 6000, relE = true, e = 0;
  const lt = [0], F = { travelMm: 0, retractions: 0, supportMm: 0, overhangMm: 0, firstLayerMm: 0 };
  for (const raw of text.split('\n')) {
    const c = raw.charCodeAt(0);
    if (c === 59) { if (raw.startsWith('; CHANGE_LAYER')) { layer++; lt[layer] = 0; } else if (raw.startsWith('; FEATURE:')) feat = raw.slice(10).trim(); continue; }
    if (c === 77) { if (raw.startsWith('M83')) relE = true; else if (raw.startsWith('M82')) relE = false; continue; }
    if (c !== 71) continue;
    if (raw.startsWith('G92')) { const m = raw.match(/E(-?[\d.]+)/); if (m) e = +m[1]; continue; }
    if (!/^G[0-3] /.test(raw)) continue;
    const mx = raw.match(/ X(-?[\d.]+)/), my = raw.match(/ Y(-?[\d.]+)/), me = raw.match(/ E(-?[\d.]+)/), mf = raw.match(/ F(-?[\d.]+)/);
    if (mf) f = +mf[1];
    const nx = mx ? +mx[1] : x, ny = my ? +my[1] : y, d = Math.hypot(nx - x, ny - y);
    let de = 0; if (me) { const v = +me[1]; de = relE ? v : v - e; if (!relE) e = v; }
    x = nx; y = ny;
    if (layer < 1) continue;
    if (f > 0 && d > 0) lt[layer] += d / (f / 60);
    if (de < 0) F.retractions++;
    if (de > 0 && d > 0) {
      if (layer === 1 && feat !== 'Skirt') F.firstLayerMm += d;
      if (/^Support/.test(feat)) F.supportMm += d; else if (feat === 'Overhang wall') F.overhangMm += d;
    } else if (de <= 0 && d > 0) F.travelMm += d;
  }
  F.layers = Math.max(0, lt.length - 1); F.slowLimit = slowLimit;
  F.slowLayers = Number.isFinite(slowLimit) ? lt.slice(2).filter((t) => t < slowLimit).length : 0;
  for (const k of ['travelMm', 'supportMm', 'overhangMm', 'firstLayerMm']) F[k] = Math.round(F[k] * 10) / 10;
  return F;
}

// ---- compact packing (our own candidate): shelf packing of the rotated footprints, the whole cluster centred on the bed.
// items: [{w, d}] (mm, footprint incl. rotation). bed: {x0,y0,x1,y1}. -> [{cx, cy}] in the same order, or null when it does not fit.
function packRects(items, bed, gap, margin) {
  margin = margin == null ? 5 : margin;
  const W = bed.x1 - bed.x0 - 2 * margin, D = bed.y1 - bed.y0 - 2 * margin;
  if (!items.length) return [];
  const order = items.map((it, i) => i).sort((a, b) => items[b].d - items[a].d || items[b].w - items[a].w || a - b);
  const area = items.reduce((s, it) => s + (it.w + gap) * (it.d + gap), 0), maxw = Math.max(...items.map((it) => it.w));
  let best = null;
  for (let R = Math.max(maxw, Math.sqrt(area)); R <= W + 1e-6 + 5; R += 5) {
    const rowW = Math.min(R, W), rows = []; let cur = null;
    for (const i of order) {
      const it = items[i];
      if (!cur || cur.w + (cur.items.length ? gap : 0) + it.w > rowW + 1e-6) { cur = { items: [], w: 0, h: 0 }; rows.push(cur); }
      cur.w += (cur.items.length ? gap : 0) + it.w; cur.h = Math.max(cur.h, it.d); cur.items.push(i);
    }
    const bw = Math.max(...rows.map((r) => r.w)), bh = rows.reduce((s, r) => s + r.h, 0) + gap * (rows.length - 1);
    if (bw > W + 1e-6 || bh > D + 1e-6) continue;
    const cost = Math.max(bw, bh) * 1000 + bw * bh / 1000;
    if (!best || cost < best.cost - 1e-9) best = { cost, rows, bw, bh };
  }
  if (!best) return null;
  const out = new Array(items.length), cx0 = (bed.x0 + bed.x1) / 2, cy0 = (bed.y0 + bed.y1) / 2;
  let yy = cy0 - best.bh / 2;
  for (const r of best.rows) {
    let xx = cx0 - r.w / 2;
    for (const i of r.items) { out[i] = { cx: xx + items[i].w / 2, cy: yy + r.h / 2 }; xx += items[i].w + gap; }
    yy += r.h + gap;
  }
  return out;
}

// metrics of one measured candidate: facts = gcodeFacts, timeSec, geometry = {centre, tall}
const metricsOf = (c) => ({ time: c.timeSec, travel: c.facts.travelMm, retract: c.facts.retractions, support: c.facts.supportMm, overhang: c.facts.overhangMm,
  contact: c.facts.firstLayerMm, slow: c.facts.slowLayers, centre: c.geo.centre, tall: c.geo.tall });
// score of c against the default arrangement ref (both: metricsOf). Negative = better than the default.
function scoreVs(m, ref, objective) {
  const w = OBJECTIVES[objective].w; let s = 0; const parts = {};
  for (const k of Object.keys(w)) {
    if (!w[k]) continue;
    const base = Math.max(ref[k], FLOORS[k]), d = HIGHER_BETTER[k] ? (ref[k] - m[k]) / base : (m[k] - ref[k]) / base;
    parts[k] = Math.max(-1, Math.min(3, d)) * w[k]; s += parts[k];
  }
  return { score: s, parts };
}
// A win must also be MATERIAL, not a few seconds on a long print: at least one measured gain that a person would notice.
function material(m, ref) {
  return (ref.time - m.time) >= Math.max(30, 0.01 * ref.time) || (ref.support - m.support) >= 25 || (ref.overhang - m.overhang) >= Math.max(25, 0.1 * ref.overhang)
    || (ref.slow - m.slow) >= 5 || (ref.tall - m.tall) >= 0.5 || (m.contact - ref.contact) >= Math.max(100, 0.15 * ref.contact) || (ref.travel - m.travel) >= Math.max(500, 0.05 * ref.travel);
}
// cands[0] MUST be the default arrangement. -> { chosen: index, scores: [..], kept: bool }
function pickBest(cands, objective) {
  if (!OBJECTIVES[objective]) throw new Error('unknown objective ' + objective);
  const ref = metricsOf(cands[0]), scores = cands.map((c) => scoreVs(metricsOf(c), ref, objective).score);
  let best = 0; for (let i = 1; i < cands.length; i++) if (scores[i] < scores[best] - 1e-12 && scores[i] < -MARGIN && material(metricsOf(cands[i]), ref)) best = i;
  return { chosen: best, scores, kept: best === 0 };
}
// plain-language reason from the measured numbers only
function explainPick(cands, pick, objective) {
  const o = OBJECTIVES[objective], d = cands[0], c = cands[pick.chosen], md = metricsOf(d), mc = metricsOf(c), n = cands.length - 1;
  if (pick.kept) {
    if (n === 0) return `Kept Orca's default arrangement: no alternative arrangement could be built for this bed (${o.label}).`;
    const alt = cands.slice(1).map((x, i) => ({ x, s: pick.scores[i + 1] })).sort((a, b) => a.s - b.s)[0];
    const dt = alt.x.timeSec - d.timeSec;
    return `Kept Orca's default arrangement for ${o.label}: none of the ${n} other arrangement${n > 1 ? 's' : ''} I sliced was measurably better (best of them, ${alt.x.label}: ${dt === 0 ? 'same time' : dur(dt) + (dt < 0 ? ' faster' : ' slower')}, support ${alt.x.facts.supportMm} mm).`;
  }
  const dt = c.timeSec - d.timeSec, bits = [];
  bits.push(dt === 0 ? 'same print time' : `${dur(dt)} ${dt < 0 ? 'faster' : 'slower'} (${(Math.abs(dt) / Math.max(1, d.timeSec) * 100).toFixed(1)} %, ${c.res && c.res.stats ? c.res.stats.totalTime : ''} vs ${d.res && d.res.stats ? d.res.stats.totalTime : ''})`);
  bits.push(`support ${mc.support} mm` + (mc.support !== md.support ? ` (default ${md.support} mm)` : ''));
  if (Math.abs(mc.overhang - md.overhang) >= 10) bits.push(`overhang walls ${mc.overhang} mm (default ${md.overhang} mm)`);
  if (Math.abs(mc.travel - md.travel) >= 100) bits.push(`travel ${Math.round(mc.travel)} mm (default ${Math.round(md.travel)} mm)`);
  if (mc.slow !== md.slow) bits.push(`${mc.slow} layers at the minimum layer time (default ${md.slow})`);
  if (Math.abs(mc.contact - md.contact) >= 50) bits.push(`first layer ${Math.round(mc.contact)} mm of extrusion (default ${Math.round(md.contact)} mm)`);
  if (Math.abs(mc.centre - md.centre) >= 5) bits.push(`parts ${Math.round(mc.centre)} mm from the bed centre on average (default ${Math.round(md.centre)} mm)`);
  return `Chosen for ${o.label}: ${c.label}: ${bits.join('; ')} (compared with Orca's default arrangement, ${n} alternative${n > 1 ? 's' : ''} sliced).` + (c.id === 'flat' ? ' A part laid on its side prints with its layer lines along its length, which changes its strength: switch off "Allow laying tall parts flat" to keep every part upright.' : '');
}

module.exports = { OBJECTIVES, DEFAULT_OBJECTIVE, FLOORS, MARGIN, MAX_CANDIDATES, METRIC_UNITS, secs, dur, gcodeFacts, packRects, metricsOf, scoreVs, pickBest, material, explainPick, objInfo, tooBigReason, minFootprint, volumeOf, STRATEGIES, strategyList, validateAssignment, capacity, FILL };
