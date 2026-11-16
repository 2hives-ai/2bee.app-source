//! fdmslice model.stl reference.gcode out.gcode  -- run the pipeline with the settings of an Orca G-code.
//!
//! Placement: Orca's `arrange` turns the part (any angle: a hex nut came out at 17 deg, a T at 180) and puts it
//! somewhere on the bed. We recover both from the reference G-code, not from guesses about arrange: the
//! OUTER-WALL polylines of up to 10 reference layers (first layer, last layer, and evenly spaced layers between)
//! are compared with the mesh cross-section at the same heights, offset inward by half a wall, for every rotation
//! about Z (0.5 deg grid, then 0.05 deg refinement of the best minima), and the translation comes from a few
//! ICP-style iterations. Score = symmetric mean nearest-point distance in mm (smaller is better).
//! Symmetric footprints (cube, cylinder, regular polygons) leave several rotations tied; the smallest |angle|
//! among the tied ones is taken and the tie is reported (a one-layer-footprint comparison cannot separate them).
//! `FDM_ROT=<deg>` forces a rotation (the translation is still fitted); `FDM_PLACE=bbox` restores the old
//! behaviour (rotation 0/90 by footprint size, centre = reference outer-wall bbox centre).
use twobee_fdm::{gcode_parse, geom, mesh::Mesh, pipeline, slice};

/// One refusal path for every input problem: `REFUSED: <reason>` on stderr, exit 3, never a panic trace.
fn refuse(why: &str) -> ! { eprintln!("fdmslice: REFUSED: {why}"); std::process::exit(3) }

fn main() {
    // any panic outside the guarded pipeline still ends as a refusal (exit 3), not exit 101
    if std::panic::catch_unwind(run).is_err() { refuse("internal error (panic outside the pipeline guard; see trace above)"); }
}

type P = [f64; 2];

// ------------------------------------------------------------------------------------------------ reference parse

/// Outer-wall geometry of one reference layer: raw polylines (arcs expanded).
struct RefLayer { z: f64, h: f64, lines: Vec<Vec<P>> }

fn num(tok: &str) -> Option<f64> { tok.get(1..).and_then(|s| s.parse::<f64>().ok()) }

/// Walk the reference G-code and collect, per layer, the polylines of `Outer wall` / `Overhang wall` extrusions.
fn parse_reference(g: &str) -> Vec<RefLayer> {
    let mut layers: Vec<RefLayer> = Vec::new();
    let (mut z, mut h) = (0.0f64, 0.0f64);
    let mut feat = String::new();
    let mut pos: P = [f64::NAN, f64::NAN];
    let mut cur: Vec<P> = Vec::new();
    let mut have_layer = false;
    let flush = |cur: &mut Vec<P>, layers: &mut Vec<RefLayer>| {
        if cur.len() >= 2 { if let Some(l) = layers.last_mut() { l.lines.push(std::mem::take(cur)); } }
        cur.clear();
    };
    for line in g.lines() {
        if let Some(r) = line.strip_prefix("; FEATURE:") { flush(&mut cur, &mut layers); feat = r.trim().to_string(); continue; }
        if let Some(r) = line.strip_prefix("; Z_HEIGHT:") { z = r.trim().parse().unwrap_or(z); continue; }
        if let Some(r) = line.strip_prefix("; LAYER_HEIGHT:") {
            h = r.trim().parse().unwrap_or(h);
            flush(&mut cur, &mut layers);
            layers.push(RefLayer { z, h, lines: Vec::new() });
            have_layer = true;
            continue;
        }
        let is_move = line.starts_with("G1 ") || line.starts_with("G0 ") || line.starts_with("G2 ") || line.starts_with("G3 ");
        if !is_move { continue; }
        let (mut x, mut y, mut e, mut i_, mut j_) = (None, None, None, None, None);
        for tok in line.split_whitespace().skip(1) {
            if tok.starts_with(';') { break; }
            match &tok[..1] { "X" => x = num(tok), "Y" => y = num(tok), "E" => e = num(tok), "I" => i_ = num(tok), "J" => j_ = num(tok), _ => {} }
        }
        let new = [x.unwrap_or(pos[0]), y.unwrap_or(pos[1])];
        let extruding = e.map_or(false, |v| v > 0.0) && (x.is_some() || y.is_some());
        let wall = feat == "Outer wall" || feat == "Overhang wall";
        if extruding && wall && have_layer && pos[0].is_finite() {
            if cur.is_empty() { cur.push(pos); }
            if line.starts_with("G2 ") || line.starts_with("G3 ") {
                if let (Some(i), Some(j)) = (i_, j_) {
                    let c = [pos[0] + i, pos[1] + j];
                    let r = (pos[0] - c[0]).hypot(pos[1] - c[1]);
                    let (a0, a1) = ((pos[1] - c[1]).atan2(pos[0] - c[0]), (new[1] - c[1]).atan2(new[0] - c[0]));
                    let ccw = line.starts_with("G3 ");
                    let mut d = a1 - a0;
                    if ccw { while d <= 0.0 { d += std::f64::consts::TAU; } } else { while d >= 0.0 { d -= std::f64::consts::TAU; } }
                    let n = ((d.abs() * r / 0.3).ceil() as usize).clamp(2, 400);
                    for k in 1..=n { let a = a0 + d * k as f64 / n as f64; cur.push([c[0] + r * a.cos(), c[1] + r * a.sin()]); }
                } else { cur.push(new); }
            } else { cur.push(new); }
        } else {
            flush(&mut cur, &mut layers);
        }
        pos = new;
    }
    flush(&mut cur, &mut layers);
    layers.retain(|l| !l.lines.is_empty());
    layers
}

/// `n` points spread evenly (by arc length) over all the polylines / rings; closed rings include the closing segment.
fn resample(lines: &[(Vec<P>, bool)], n: usize) -> Vec<P> {
    let seglen = |a: P, b: P| (b[0] - a[0]).hypot(b[1] - a[1]);
    let total: f64 = lines.iter().map(|(l, closed)| {
        let mut s: f64 = l.windows(2).map(|w| seglen(w[0], w[1])).sum();
        if *closed && l.len() > 2 { s += seglen(l[l.len() - 1], l[0]); }
        s
    }).sum();
    if total <= 0.0 { return Vec::new(); }
    let step = total / n as f64;
    let mut out = Vec::with_capacity(n + lines.len());
    let mut carry = 0.0; // distance already travelled since the last emitted point
    for (l, closed) in lines {
        let mut pts: Vec<P> = l.clone();
        if *closed && pts.len() > 2 { pts.push(pts[0]); }
        if pts.len() < 2 { continue; }
        out.push(pts[0]);
        carry = 0.0;
        for w in pts.windows(2) {
            let d = seglen(w[0], w[1]);
            let mut t = step - carry;
            while t <= d {
                let f = if d > 0.0 { t / d } else { 0.0 };
                out.push([w[0][0] + (w[1][0] - w[0][0]) * f, w[0][1] + (w[1][1] - w[0][1]) * f]);
                t += step;
            }
            carry = d - (t - step);
        }
    }
    let _ = carry;
    out
}

// ------------------------------------------------------------------------------------------------ the fit

struct Layer2 { orca: Vec<P>, ours: Vec<P> } // ours in mesh coordinates, orca in bed coordinates

fn rot(p: P, c: P, s: f64, co: f64) -> P { let (x, y) = (p[0] - c[0], p[1] - c[1]); [c[0] + x * co - y * s, c[1] + x * s + y * co] }

fn bbox_of(pts: impl Iterator<Item = P>) -> Option<[f64; 4]> {
    let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    let mut any = false;
    for p in pts { any = true; b[0] = b[0].min(p[0]); b[1] = b[1].min(p[1]); b[2] = b[2].max(p[0]); b[3] = b[3].max(p[1]); }
    if any { Some(b) } else { None }
}

fn nearest_d2(p: P, set: &[P]) -> f64 {
    let mut best = f64::MAX;
    for q in set { let d = (p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2); if d < best { best = d; } }
    best
}

/// Symmetric mean nearest-point distance for rotation `deg` (about `c0`) and translation `t` (added after rotation).
fn score(layers: &[Layer2], c0: P, deg: f64, t: P) -> f64 {
    let (s, co) = deg.to_radians().sin_cos();
    let mut tot = 0.0;
    let mut cnt = 0.0;
    for l in layers {
        let mine: Vec<P> = l.ours.iter().map(|&p| { let r = rot(p, c0, s, co); [r[0] + t[0], r[1] + t[1]] }).collect();
        let a: f64 = l.orca.iter().map(|&p| nearest_d2(p, &mine).sqrt()).sum::<f64>() / l.orca.len() as f64;
        let b: f64 = mine.iter().map(|&p| nearest_d2(p, &l.orca).sqrt()).sum::<f64>() / mine.len() as f64;
        tot += 0.5 * (a + b);
        cnt += 1.0;
    }
    tot / cnt
}

/// Translation aligning the selected layers' bounding-box centres for rotation `deg`.
fn bbox_translation(layers: &[Layer2], c0: P, deg: f64) -> P {
    let (s, co) = deg.to_radians().sin_cos();
    let ob = bbox_of(layers.iter().flat_map(|l| l.orca.iter().copied())).unwrap();
    let mb = bbox_of(layers.iter().flat_map(|l| l.ours.iter().map(move |&p| rot(p, c0, s, co)))).unwrap();
    [(ob[0] + ob[2]) / 2.0 - (mb[0] + mb[2]) / 2.0, (ob[1] + ob[3]) / 2.0 - (mb[1] + mb[3]) / 2.0]
}

/// A few ICP-style steps: move by the mean displacement from each reference point to its nearest point of ours.
fn icp_translation(layers: &[Layer2], c0: P, deg: f64, mut t: P) -> P {
    let (s, co) = deg.to_radians().sin_cos();
    for _ in 0..6 {
        let (mut dx, mut dy, mut n) = (0.0, 0.0, 0.0);
        for l in layers {
            let mine: Vec<P> = l.ours.iter().map(|&p| { let r = rot(p, c0, s, co); [r[0] + t[0], r[1] + t[1]] }).collect();
            for &o in &l.orca {
                let mut best = (f64::MAX, [0.0, 0.0]);
                for q in &mine { let d = (o[0] - q[0]).powi(2) + (o[1] - q[1]).powi(2); if d < best.0 { best = (d, *q); } }
                dx += o[0] - best.1[0]; dy += o[1] - best.1[1]; n += 1.0;
            }
        }
        // trimmed correction: use half the mean displacement to stay stable when the match is partly wrong
        t = [t[0] + 0.7 * dx / n, t[1] + 0.7 * dy / n];
    }
    t
}

struct Fit { deg: f64, score: f64, trans: P, ties: Vec<f64>, c0: P, how: String }

fn fit_rotation(mesh: &Mesh, layers: &[Layer2], arrange_cands: &[f64]) -> Fit {
    let (mn, mx) = mesh.bbox();
    let c0 = [(mn[0] + mx[0]) / 2.0, (mn[1] + mx[1]) / 2.0];
    let threads = slice::default_threads();
    let coarse_deg: Vec<f64> = (0..720).map(|i| i as f64 * 0.5).collect();
    let coarse: Vec<f64> = slice::par_map(&coarse_deg, threads, |_, &d| {
        let t = bbox_translation(layers, c0, d);
        score(layers, c0, d, t)
    });
    // local minima of the circular score curve, best first
    let n = coarse.len();
    let mut minima: Vec<usize> = (0..n).filter(|&i| coarse[i] <= coarse[(i + n - 1) % n] && coarse[i] <= coarse[(i + 1) % n]).collect();
    minima.sort_by(|&a, &b| coarse[a].partial_cmp(&coarse[b]).unwrap().then(a.cmp(&b)));
    minima.truncate(8);
    // the axis-aligned rotations are always candidates: symmetric footprints then resolve to them, not to noise
    for q in [0usize, 180, 360, 540] { if !minima.contains(&q) { minima.push(q); } }
    // refine each candidate: 0.05 deg grid within +-0.5 deg, translation by bbox centres then ICP
    let refined: Vec<(f64, f64, P)> = slice::par_map(&minima, threads, |_, &i| {
        let mut best = (f64::MAX, coarse_deg[i], [0.0, 0.0]);
        for k in -10..=10 {
            let d = coarse_deg[i] + k as f64 * 0.05;
            let t = bbox_translation(layers, c0, d);
            let sc = score(layers, c0, d, t);
            if sc < best.0 { best = (sc, d, t); }
        }
        let t = icp_translation(layers, c0, best.1, best.2);
        let sc = score(layers, c0, best.1, t);
        (sc, best.1, t)
    });
    let best_sc = refined.iter().map(|r| r.0).fold(f64::MAX, f64::min);
    let wrap = |d: f64| { let m = d.rem_euclid(360.0); if m > 180.0 { m - 360.0 } else { m } };
    // Orca's arrange only ever picks (min-area-bbox rotation + k*45 deg): score exactly those angles
    // arrange_cands is ordered (edge, k): index % 8 is k, so k = 0 (the pure min-area rotation) wins ties
    let cand: Vec<(f64, f64, P)> = arrange_cands.iter().map(|&d| {
        let t = icp_translation(layers, c0, d, bbox_translation(layers, c0, d));
        (score(layers, c0, d, t), d, t)
    }).collect();
    let kof = |d: f64| arrange_cands.iter().position(|&x| x == d).map_or(99, |i| i % 8);
    let cbest = cand.iter().map(|r| r.0).fold(f64::MAX, f64::min);
    if !cand.is_empty() && cbest <= best_sc * 1.15 + 0.03 {
        // tied candidates (symmetric footprint): smallest |angle|
        let tol = cbest * 1.05 + 0.01;
        let mut tied: Vec<&(f64, f64, P)> = cand.iter().filter(|r| r.0 <= tol).collect();
        tied.sort_by(|a, b| kof(a.1).cmp(&kof(b.1)).then(wrap(a.1).abs().partial_cmp(&wrap(b.1).abs()).unwrap()).then(a.1.partial_cmp(&b.1).unwrap()));
        let pick = *tied[0];
        return Fit { deg: pick.1.rem_euclid(360.0), score: pick.0, trans: pick.2, ties: tied.iter().map(|r| r.1.rem_euclid(360.0)).collect(), c0,
            how: format!("arrange set (min-area bbox + k*45 deg), free-fit best {:.3} mm", best_sc) };
    }
    // otherwise the free fit: tied minima (within 5% + 0.01 mm of the best): symmetric footprint; prefer the smallest |angle|
    let tol = best_sc * 1.05 + 0.01;
    let mut tied: Vec<&(f64, f64, P)> = refined.iter().filter(|r| r.0 <= tol).collect();
    tied.sort_by(|a, b| wrap(a.1).abs().partial_cmp(&wrap(b.1).abs()).unwrap().then(a.1.partial_cmp(&b.1).unwrap()));
    let mut pick = *tied[0];
    // snap to the nearest multiple of 90 deg when that fits as well (the refinement grid picks noise otherwise)
    let snapped = (pick.1 / 90.0).round() * 90.0;
    if (pick.1 - snapped).abs() < 0.75 && (pick.1 - snapped).abs() > 1e-9 {
        let t = icp_translation(layers, c0, snapped, bbox_translation(layers, c0, snapped));
        let sc = score(layers, c0, snapped, t);
        if sc <= pick.0 * 1.5 + 0.01 { pick = (sc, snapped, t); }
    }
    Fit { deg: pick.1.rem_euclid(360.0), score: pick.0, trans: pick.2, ties: tied.iter().map(|r| r.1.rem_euclid(360.0)).collect(), c0,
        how: format!("free fit (outside the arrange set; arrange-set best {:.3} mm)", cbest) }
}

/// Candidate rotations of Orca's arrange: for the min-area bounding box of the XY convex hull (edge direction `e`,
/// rotation that aligns it to X is `-e`), `-e + k*45 deg`, k = 0..7.
fn arrange_candidates(hp: &[P]) -> Vec<f64> {
    if hp.len() < 3 { return Vec::new(); }
    let n = hp.len();
    let mut best: Vec<(f64, f64)> = Vec::new(); // (area, edge angle)
    for i in 0..n {
        let (a, b) = (hp[i], hp[(i + 1) % n]);
        let e = (b[1] - a[1]).atan2(b[0] - a[0]);
        let (s, c) = (-e).sin_cos();
        let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
        for p in hp { let x = p[0] * c - p[1] * s; let y = p[0] * s + p[1] * c; lo[0] = lo[0].min(x); hi[0] = hi[0].max(x); lo[1] = lo[1].min(y); hi[1] = hi[1].max(y); }
        best.push(((hi[0] - lo[0]) * (hi[1] - lo[1]), e));
    }
    let amin = best.iter().map(|b| b.0).fold(f64::MAX, f64::min);
    let mut out: Vec<f64> = Vec::new();
    for (a, e) in &best {
        if *a <= amin * (1.0 + 1e-6) {
            for k in 0..8 { out.push((-e.to_degrees() + 45.0 * k as f64).rem_euclid(360.0)); }
        }
    }
    out
}

/// Convex hull of the XY projection (monotone chain).
fn hull(mut pts: Vec<P>) -> Vec<P> {
    pts.sort_by(|a, b| a[0].partial_cmp(&b[0]).unwrap().then(a[1].partial_cmp(&b[1]).unwrap()));
    pts.dedup();
    if pts.len() < 3 { return pts; }
    let cross = |o: P, a: P, b: P| (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    let mut h: Vec<P> = Vec::new();
    for &p in &pts { while h.len() >= 2 && cross(h[h.len() - 2], h[h.len() - 1], p) <= 0.0 { h.pop(); } h.push(p); }
    let lower = h.len() + 1;
    for &p in pts.iter().rev().skip(1) { while h.len() >= lower && cross(h[h.len() - 2], h[h.len() - 1], p) <= 0.0 { h.pop(); } h.push(p); }
    h.pop();
    h
}

/// Placement fitted to the reference's outer walls. Returns (placement, report line) or the reason it could not be fitted.
fn fit_placement(mesh: &Mesh, reference: &str) -> Result<(pipeline::Placement, String), String> {
    let ref_layers = parse_reference(reference);
    if ref_layers.is_empty() { return Err("reference has no Outer wall moves".into()); }
    // pick up to 10 layers: first, last, evenly spaced between; skip layers with a trivially short wall
    let usable: Vec<usize> = (0..ref_layers.len()).filter(|&i| ref_layers[i].lines.iter().map(|l| l.len()).sum::<usize>() >= 4).collect();
    if usable.is_empty() { return Err("reference outer walls are too short".into()); }
    let k = usable.len().min(10);
    let mut sel: Vec<usize> = (0..k).map(|i| usable[if k == 1 { 0 } else { i * (usable.len() - 1) / (k - 1) }]).collect();
    sel.dedup();
    // object z of the reference layers: its first wall layer sits on the bed (no raft handling: refused upstream)
    let z0 = ref_layers[0].z - ref_layers[0].h;
    let (mn, _) = mesh.bbox();
    let mut m = mesh.clone();
    m.translate([0.0, 0.0, -mn[2]]);
    let specs: Vec<slice::LayerSpec> = sel.iter().map(|&i| { let l = &ref_layers[i]; slice::LayerSpec { lo: l.z - l.h - z0, hi: l.z - z0, slice_z: l.z - l.h / 2.0 - z0 } }).collect();
    let sliced = slice::slice_mesh(&m, &specs, slice::SliceOptions::default());
    let mut layers: Vec<Layer2> = Vec::new();
    for (si, &i) in sel.iter().enumerate() {
        let region = &sliced.layers[si].region;
        if region.is_empty() { continue; }
        let inner = geom::offset(region, -0.21);
        let use_region = if inner.is_empty() { region } else { &inner };
        let mut rings: Vec<(Vec<P>, bool)> = Vec::new();
        for p in use_region { rings.push((p.contour.clone(), true)); for h in &p.holes { rings.push((h.clone(), true)); } }
        let ours = resample(&rings, 300);
        let lines: Vec<(Vec<P>, bool)> = ref_layers[i].lines.iter().map(|l| (l.clone(), false)).collect();
        let orca = resample(&lines, 300);
        if ours.len() < 4 || orca.len() < 4 { continue; }
        layers.push(Layer2 { orca, ours });
    }
    if layers.is_empty() { return Err("the mesh has no cross-section at the reference layer heights".into()); }
    let hp0 = hull(mesh.verts.iter().map(|v| [v[0], v[1]]).collect());
    let mut fit = fit_rotation(mesh, &layers, &arrange_candidates(&hp0));
    if let Some(f) = std::env::var("FDM_ROT").ok().and_then(|s| s.parse::<f64>().ok()) {
        let t = bbox_translation(&layers, fit.c0, f);
        let t = icp_translation(&layers, fit.c0, f, t);
        fit = Fit { deg: f.rem_euclid(360.0), score: score(&layers, fit.c0, f, t), trans: t, ties: vec![], c0: fit.c0, how: "forced by FDM_ROT".into() };
    }
    // convert: translation `t` moves the rotated mesh (rotated about c0); the pipeline rotates about c0 then moves the
    // rotated vertex-bbox centre to `center`. Rotated bbox centre from the convex hull (exact for the bbox).
    let hp = hull(mesh.verts.iter().map(|v| [v[0], v[1]]).collect());
    let (s, co) = fit.deg.to_radians().sin_cos();
    let b = bbox_of(hp.iter().map(|&p| rot(p, fit.c0, s, co))).unwrap();
    let c1 = [(b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0];
    // Centre: Orca arrange centres the rotated object's bounding box on one bed point (measured: the outer-wall bounding
    // box centre of the reference is exactly (138.25, 128.0) on every one of 46 corpus models, rotated or not), so the
    // centre is taken from the reference outer-wall bounding box, not from the ICP translation (which only ranks the
    // rotations and is good to ~0.05 mm on rotated meshes).
    let wb = bbox_of(ref_layers.iter().flat_map(|l| l.lines.iter().flat_map(|x| x.iter().copied()))).unwrap();
    let center = [(wb[0] + wb[2]) / 2.0, (wb[1] + wb[3]) / 2.0];
    let _ = (c1, fit.trans);
    let msg = format!("placement fit: rotate {:.2} deg, centre ({:.3}, {:.3}), mean outer-wall distance {:.3} mm over {} layer(s) [{}]{}",
        if fit.deg.abs() < 1e-9 { 0.0 } else { fit.deg }, center[0], center[1], fit.score, layers.len(), fit.how,
        if fit.ties.len() > 1 { format!(", {} tied rotations ({})", fit.ties.len(), fit.ties.iter().map(|d| format!("{d:.1}")).collect::<Vec<_>>().join("/")) } else { String::new() });
    Ok((pipeline::Placement { rotate_z_deg: if fit.deg.abs() < 1e-9 { 0.0 } else { fit.deg }, center }, msg))
}

/// The old placement: reference outer-wall bbox centre, rotation 0 or 90 by footprint size.
fn bbox_placement(mesh: &Mesh, reference: &str) -> Result<pipeline::Placement, String> {
    let ls = parse_reference(reference);
    let b = bbox_of(ls.iter().flat_map(|l| l.lines.iter().flat_map(|x| x.iter().copied()))).ok_or("reference has no Outer wall moves (cannot derive the placement)")?;
    let (ow, oh) = (b[2] - b[0], b[3] - b[1]);
    let (mut lo, mut hi) = ([f64::MAX; 2], [f64::MIN; 2]);
    for v in &mesh.verts { for k in 0..2 { lo[k] = lo[k].min(v[k]); hi[k] = hi[k].max(v[k]); } }
    if lo[0] > hi[0] { return Err("mesh has no vertices".into()); }
    let (w, h) = (hi[0] - lo[0], hi[1] - lo[1]);
    let rot = if ((w - ow).abs() + (h - oh).abs()) <= ((h - ow).abs() + (w - oh).abs()) { 0.0 } else { 90.0 };
    Ok(pipeline::Placement { rotate_z_deg: rot, center: [(b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0] })
}

// ------------------------------------------------------------------------------------------------ presets mode
//
// fdmslice --presets --machine M --process P --filament F [--config-dir DIR] [--defaults FILE] [--set k=v]... [--fset k=v]...
//          [--arrange-only] [--auto-walls] [--out out.gcode] --report report.json  model.stl[@X,Y] ...
//
// The settings come from Orca PRESET FILES (JSON under DIR, default ~/.config/OrcaSlicer), never from an Orca G-code
// and never from the orca-slicer binary: this is the mode tools/print3d-bridge runs by default (2bee_app, 2026-10-16).
// `--defaults FILE` is a CONFIG_BLOCK holding the values Orca compiles in for keys no preset sets; only keys still
// unset after the presets are taken from it. Without it the pipeline refuses on the first such key it needs.
// `--set` overrides a process/machine key, `--fset` a filament key. Objects carry `@X,Y` (all or none): the bed point
// their XY bounding-box centre goes to, no rotation (a caller that wants a rotation or a tilt bakes it into the STL);
// none = our arrange (fdm/src/arrange.rs) places them. `--arrange-only` places and does not slice; an object that does
// not fit with the others is listed in `leftover` (greedy, largest footprint first), it is never squeezed in.
// The report is JSON; on a refusal it is written too ({"ok":false,"error":...}), exit 3. Bad invocation: exit 2.
// One filament only: a multi-filament job is refused (presets for several filaments are not merged here yet).

fn presets_refuse(report: Option<&str>, why: &str) -> ! {
    if let Some(r) = report { let _ = std::fs::write(r, serde_json::json!({ "ok": false, "engine": "twobee-fdm", "error": why }).to_string()); }
    refuse(why)
}

fn run_presets(a: &[String]) {
    use twobee_fdm::config::{Config, ExtruderSetup, PresetDirs};
    use twobee_fdm::arrange;
    let usage = "usage: fdmslice --presets --machine M --process P --filament F [--config-dir DIR] [--defaults FILE] [--set k=v]... [--fset k=v]... [--oset N:k=v]... [--arrange-only] [--auto-walls] [--out out.gcode] --report report.json model.stl[@X,Y] ...";
    let bad = |m: &str| -> ! { eprintln!("fdmslice: {m}\n{usage}"); std::process::exit(2) };
    let (mut machine, mut process, mut filament, mut dir, mut out, mut report, mut defaults) = (None, None, None, None, None, None, None::<String>);
    let (mut sets, mut fsets, mut models, mut arrange_only, mut auto_walls) = (Vec::<(String, String)>::new(), Vec::<(String, String)>::new(), Vec::<String>::new(), false, false);
    let mut osets: Vec<(usize, String, String)> = Vec::new();
    let mut i = 0;
    while i < a.len() {
        let k = a[i].as_str();
        let mut val = || -> String { i += 1; a.get(i).cloned().unwrap_or_else(|| bad(&format!("{k} needs a value"))) };
        let kv = |s: String| -> (String, String) { match s.split_once('=') { Some((k, v)) if !k.trim().is_empty() => (k.trim().to_string(), v.to_string()), _ => bad(&format!("{s:?}: want key=value")) } };
        match k {
            "--machine" => machine = Some(val()),
            "--process" => process = Some(val()),
            "--filament" => { if filament.is_some() { bad("one --filament only: multi-filament jobs are not wired in presets mode"); } filament = Some(val()) }
            "--config-dir" => dir = Some(val()),
            "--defaults" => defaults = Some(val()),
            "--out" => out = Some(val()),
            "--report" => report = Some(val()),
            "--set" => { let v = val(); sets.push(kv(v)) }
            "--fset" => { let v = val(); fsets.push(kv(v)) }
            "--oset" => {
                let v = val();
                let Some((n, rest)) = v.split_once(':') else { bad(&format!("--oset {v:?}: want N:key=value")) };
                let n: usize = n.trim().parse().unwrap_or_else(|_| bad(&format!("--oset {v:?}: N must be a model index (0-based)")));
                let (k, val) = kv(rest.to_string());
                osets.push((n, k, val))
            }
            "--arrange-only" => arrange_only = true,
            "--auto-walls" => auto_walls = true,
            s if s.starts_with("--") => bad(&format!("unknown flag {s}")),
            _ => models.push(a[i].clone()),
        }
        i += 1;
    }
    let report = report.unwrap_or_else(|| bad("--report is required"));
    let r = Some(report.as_str());
    let (Some(machine), Some(process), Some(filament)) = (machine, process, filament) else { bad("--machine, --process and --filament are required") };
    if models.is_empty() { bad("no model given"); }
    if !arrange_only && out.is_none() { bad("--out is required unless --arrange-only"); }
    let dirs = match dir { Some(d) => PresetDirs { root: d.into(), user: "default".into() }, None => PresetDirs::default_orca().unwrap_or_else(|e| presets_refuse(r, &e.to_string())) };
    if !dirs.root.is_dir() { presets_refuse(r, &format!("preset directory {} does not exist", dirs.root.display())); }
    let mut cfg = Config::from_presets(&dirs, &machine, &process, &filament, &ExtruderSetup::default()).unwrap_or_else(|e| presets_refuse(r, &format!("presets: {e}")));
    let preset_keys = cfg.len();
    // Orca's compiled defaults: the keys no preset sets (Orca fills them from PrintConfig.cpp). Read from a CONFIG_BLOCK
    // snapshot file; only keys the presets left unset are taken, so a preset value always wins.
    let default_keys = match &defaults {
        Some(f) => { let d = Config::from_gcode_file(std::path::Path::new(f)).unwrap_or_else(|e| presets_refuse(r, &format!("defaults {f}: {e}"))); cfg.fill_missing(&d) }
        None => 0,
    };
    // Values Orca computes per job and writes into the CONFIG_BLOCK, for the one shape this mode accepts (one filament,
    // printed by extruder 1 = the left, Direct Drive extruder of ExtruderSetup::default()). The X2D start G-code indexes
    // filament_map; without it the template does not render. A --set of the same key wins.
    cfg.set("filament_map", "1");
    for (k, v) in &sets { cfg.set(k, v); }
    for (k, v) in &fsets { cfg.set(k, v); } // one filament: a filament key holds one value
    // objects
    let mut objs: Vec<pipeline::JobObject> = Vec::new();
    for m in &models {
        let (path, at) = match m.rsplit_once('@') {
            Some((p, xy)) => {
                let v: Vec<f64> = xy.split(',').filter_map(|t| t.trim().parse().ok()).filter(|f: &f64| f.is_finite()).collect();
                if v.len() != 2 { bad(&format!("bad placement {xy:?}: want X,Y")); }
                (p.to_string(), Some(pipeline::ObjPlacement { rotate_z_deg: 0.0, center: [v[0], v[1]] }))
            }
            None => (m.clone(), None),
        };
        let stl = std::fs::read(&path).unwrap_or_else(|e| presets_refuse(r, &format!("cannot read model {path}: {e}")));
        let name = std::path::Path::new(&path).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or(path);
        objs.push(pipeline::JobObject { name, stl, placement: at, filament_index: 0, overrides: Vec::new() });
    }
    // --oset N:key=value: per-object settings (pipeline::OBJECT_OVERRIDE_KEYS). Checked here against the final plate
    // config, before anything is written: a refusal is exit 2 with no G-code and no report.
    if !osets.is_empty() && arrange_only { bad("--oset does not apply to --arrange-only (nothing is sliced)"); }
    for (n, k, v) in &osets {
        if *n >= objs.len() { bad(&format!("--oset {n}:{k}: there are {} model(s), indexes 0..{}", objs.len(), objs.len() - 1)); }
        if let Some(e) = objs[*n].overrides.iter_mut().find(|(ek, _)| ek == k) { e.1 = v.clone(); } else { objs[*n].overrides.push((k.clone(), v.clone())); }
    }
    if let Err(e) = pipeline::check_object_overrides(&cfg, &objs) { bad(&format!("--oset: {e}")); }
    let placed_n = objs.iter().filter(|o| o.placement.is_some()).count();
    if placed_n != 0 && placed_n != objs.len() { bad("give every model @X,Y or none"); }
    let mut settings = serde_json::json!({ "configDir": dirs.root.display().to_string(), "machine": machine, "process": process, "filament": filament,
        "presetKeys": preset_keys, "defaults": defaults, "defaultKeys": default_keys, "set": sets.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>(), "fset": fsets.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>() });

    if arrange_only {
        if placed_n != 0 { bad("--arrange-only takes models without @X,Y"); }
        let meshes: Vec<Mesh> = objs.iter().map(|o| Mesh::from_stl(&o.stl).unwrap_or_else(|e| presets_refuse(r, &format!("{}: {e}", o.name)))).collect();
        let try_set = |set: &[usize]| -> Result<Vec<arrange::MeshPlacement>, String> {
            let items: Vec<arrange::SceneItem> = set.iter().map(|&k| arrange::SceneItem { name: objs[k].name.clone(), mesh: &meshes[k], filament: 0 }).collect();
            pipeline::guard(|| arrange::arrange_scene(&items, &cfg).map_err(twobee_fdm::types::FdmError::Geometry)).map_err(|e| e.to_string())
        };
        let all: Vec<usize> = (0..objs.len()).collect();
        let (kept, placed) = match try_set(&all) {
            Ok(p) => (all.clone(), p),
            Err(e) if e.contains("does not fit") => {
                // greedy: largest footprint first; an object that does not fit with those kept is left over
                let area = |k: usize| { let (mn, mx) = meshes[k].bbox(); (mx[0] - mn[0]) * (mx[1] - mn[1]) };
                let mut order = all.clone();
                order.sort_by(|&x, &y| area(y).partial_cmp(&area(x)).unwrap_or(std::cmp::Ordering::Equal).then(x.cmp(&y)));
                let mut kept: Vec<usize> = Vec::new();
                for k in order { let mut t = kept.clone(); t.push(k); t.sort(); if try_set(&t).is_ok() { kept = t; } }
                if kept.is_empty() { presets_refuse(r, &format!("arrange: {e}")); }
                let p = try_set(&kept).unwrap_or_else(|e| presets_refuse(r, &format!("arrange: {e}")));
                (kept, p)
            }
            Err(e) => presets_refuse(r, &format!("arrange: {e}")),
        };
        let leftover: Vec<usize> = all.iter().copied().filter(|k| !kept.contains(k)).collect();
        let objects: Vec<serde_json::Value> = placed.iter().map(|p| {
            let k = kept[p.index];
            let (mn, mx) = meshes[k].bbox();
            let cpre = [(mn[0] + mx[0]) / 2.0, (mn[1] + mx[1]) / 2.0];
            let (s, c) = p.rotation.sin_cos();
            let (x, y) = (cpre[0] - p.c0[0], cpre[1] - p.c0[1]);
            // where the object's own XY bbox centre lands, and the turn about it (the page's placement convention)
            serde_json::json!({ "input_index": k, "name": objs[k].name, "rotate_z_deg": p.rotation.to_degrees(), "pre_center": [c * x - s * y + p.origin[0], s * x + c * y + p.origin[1]] })
        }).collect();
        let rep = serde_json::json!({ "ok": true, "engine": "twobee-fdm", "mode": "arrange", "settings": settings, "objects": objects, "leftover": leftover });
        std::fs::write(&report, rep.to_string()).unwrap_or_else(|e| refuse(&format!("cannot write {report}: {e}")));
        eprintln!("fdmslice: arranged {} of {} object(s)", kept.len(), objs.len());
        return;
    }

    let out = out.unwrap();
    // --auto-walls (improve::wallfill): when a thin wall would leave narrow zig-zag strips, slice the candidates and keep
    // the one whose EMITTED G-code retracts least. The geometry only decides whether to look; the G-code decides.
    // An explicit --set of wall_loops or wall_generator wins (no candidates are tried).
    let mut auto: Vec<serde_json::Value> = Vec::new();
    let mut chosen: Option<Result<pipeline::JobOutput, twobee_fdm::types::FdmError>> = None;
    if auto_walls && !sets.iter().any(|(k, _)| k == "wall_loops" || k == "wall_generator") {
        let mut hint: Option<twobee_fdm::improve::wallfill::WallFill> = None;
        for o in &objs {
            let Ok(mesh) = Mesh::from_stl(&o.stl) else { continue };
            let Ok(sliced) = pipeline::guard(|| slice::slice(&mesh, &cfg)) else { continue };
            if let Some(w) = twobee_fdm::improve::wallfill::thin_wall_loops(&sliced.layers, &cfg) {
                if hint.as_ref().map_or(true, |b| w.to_loops > b.to_loops) { hint = Some(w); }
            }
        }
        if let Some(h) = hint {
            let n0 = h.from_loops;
            let gen0 = cfg.raw("wall_generator").map(|g| g.trim().to_string()).unwrap_or_else(|| "classic".into());
            let mut cands: Vec<(i64, String)> = vec![(n0, gen0.clone()), (n0 + 1, gen0.clone())];
            if h.to_loops > n0 + 1 { cands.push((h.to_loops, gen0.clone())); }
            if gen0 != "arachne" { cands.push((n0, "arachne".into())); cands.push((n0 + 1, "arachne".into())); }
            // One Config per candidate, KEPT after the slice: the winner's is the object that produced the emitted G-code,
            // so its values and its read tracker (unreadKeys) are what the report states. (Until 2026-11-12 the configs
            // were dropped in the threads and the report read `cfg`, which ran none of the candidates.)
            let cand_cfgs: Vec<twobee_fdm::config::Config> = cands.iter().map(|(n, g)| {
                let mut c = twobee_fdm::config::Config::from_map(cfg.raw_map().clone());
                c.set("wall_loops", &n.to_string());
                c.set("wall_generator", g);
                c
            }).collect();
            let results: Vec<Result<pipeline::JobOutput, twobee_fdm::types::FdmError>> = std::thread::scope(|sc| {
                let hs: Vec<_> = cand_cfgs.iter().map(|c| {
                    let objs = &objs;
                    sc.spawn(move || pipeline::guard(|| pipeline::slice_job_with_config(objs, c, &pipeline::JobOptions::default())))
                }).collect();
                hs.into_iter().map(|h| h.join().unwrap_or_else(|_| Err(twobee_fdm::types::FdmError::Geometry("candidate slice panicked".into())))).collect()
            });
            let score = |g: &str| -> (usize, f64) {
                let retracts = g.lines().filter(|l| l.starts_with("G1 E-")).count();
                let secs = g.lines().find_map(|l| l.split_once("total estimated time: ").map(|(_, t)| t.to_string())).map(|t| {
                    let mut tot = 0.0; let mut num = String::new();
                    for ch in t.chars() { if ch.is_ascii_digit() { num.push(ch) } else { let v: f64 = num.parse().unwrap_or(0.0); num.clear(); tot += v * match ch { 'd' => 86400.0, 'h' => 3600.0, 'm' => 60.0, 's' => 1.0, _ => 0.0 }; } }
                    tot
                }).unwrap_or(f64::MAX);
                (retracts, secs)
            };
            let scored: Vec<Option<(usize, f64)>> = results.iter().map(|r| r.as_ref().ok().map(|o| score(&o.gcode))).collect();
            let table: Vec<String> = cands.iter().zip(&scored).map(|((n, g), s)| match s { Some((r, t)) => format!("{n} loops {g}: {r} retractions, {:.0} min", t / 60.0), None => format!("{n} loops {g}: failed") }).collect();
            let base = scored[0];
            let mut best = 0usize;
            if let Some((r0, t0)) = base {
                for (i, s) in scored.iter().enumerate().skip(1) {
                    let Some((r, t)) = *s else { continue };
                    let (rb, _) = scored[best].unwrap();
                    // at least 10% fewer retractions than the preset, and not slower than it
                    if (r as f64) <= 0.9 * r0 as f64 && t <= t0 * 1.0 + 1.0 && r < rb { best = i; }
                }
            }
            if best != 0 {
                let (n, g) = &cands[best];
                cfg = cand_cfgs.into_iter().nth(best).unwrap();
                let (r0, _) = base.unwrap();
                let (r1, _) = scored[best].unwrap();
                auto.push(serde_json::json!({ "key": "wall_loops,wall_generator", "old": format!("{n0},{gen0}"), "value": format!("{n},{g}"),
                    "reason": format!("{}; tried {} -> kept the fewest retractions ({r0} -> {r1})", h.reason, table.join("; ")) }));
                chosen = Some(results.into_iter().nth(best).unwrap());
            } else {
                auto.push(serde_json::json!({ "key": "wall_loops", "old": n0.to_string(), "value": n0.to_string(),
                    "reason": format!("{}; tried {} -> no candidate was 10% better without being slower, preset kept", h.reason, table.join("; ")) }));
            }
        }
    }
    match chosen.unwrap_or_else(|| pipeline::slice_job_with_config(&objs, &cfg, &pipeline::JobOptions::default())) {
        Ok(o) => {
            std::fs::write(&out, &o.gcode).unwrap_or_else(|e| presets_refuse(r, &format!("cannot write {out}: {e}")));
            let objects: Vec<serde_json::Value> = o.objects.iter().map(|s| serde_json::json!({ "input_index": s.input_index, "name": s.name, "rotate_z_deg": s.rotate_z_deg,
                "center": s.center, "bbox": s.bbox, "height": s.height, "layers": s.layers, "print_position": s.print_position,
                "overrides": s.overrides.iter().map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone()))).collect::<serde_json::Map<String, serde_json::Value>>() })).collect();
            // `cfg` is the Config that produced `o.gcode` (the winning candidate's, under --auto-walls). The wall settings it
            // ran with are stated in `settings`, read off its map without marking them read.
            let used = |k: &str| cfg.raw_map().get(k).map(|v| v.trim().trim_matches('"').to_string());
            settings["wall_loops"] = serde_json::json!(used("wall_loops"));
            settings["wall_generator"] = serde_json::json!(used("wall_generator"));
            let unread = cfg.unread_keys();
            let rep = serde_json::json!({ "ok": true, "engine": "twobee-fdm", "mode": "slice", "settings": settings, "layers": o.layers, "open_loops": o.open_loops,
                "issues": o.issues, "objects": objects, "unreadKeys": unread.len(), "auto": auto });
            std::fs::write(&report, rep.to_string()).unwrap_or_else(|e| refuse(&format!("cannot write {report}: {e}")));
            eprintln!("fdmslice: {} object(s), {} layers, open loops {}, {} issue(s)", o.objects.len(), o.layers, o.open_loops, o.issues.len());
        }
        Err(e) => presets_refuse(r, &e.to_string()),
    }
}

/// fdmslice --multi reference.gcode out.gcode a.stl b.stl ...  -> Orca-style arrange + one G-code for all objects.
fn run_multi(a: &[String]) {
    if a.len() < 5 { eprintln!("usage: fdmslice --multi reference.gcode out.gcode a.stl [b.stl ...]"); std::process::exit(2); }
    let reff = match std::fs::read(&a[2]) { Ok(b) => String::from_utf8_lossy(&b).into_owned(), Err(e) => refuse(&format!("cannot read reference {}: {e}", a[2])) };
    let objs: Vec<pipeline::JobObject> = a[4..].iter().map(|p| {
        let stl = std::fs::read(p).unwrap_or_else(|e| refuse(&format!("cannot read model {p}: {e}")));
        let name = std::path::Path::new(p).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_else(|| p.clone());
        pipeline::JobObject { name, stl, placement: None, filament_index: 0, overrides: Vec::new() }
    }).collect();
    match pipeline::slice_job(&objs, &reff, &pipeline::JobOptions::default()) {
        Ok(o) => {
            if let Err(e) = std::fs::write(&a[3], &o.gcode) { refuse(&format!("cannot write {}: {e}", a[3])); }
            eprintln!("fdmslice: {} objects, {} layers, open loops {}, {} issue(s)", o.objects.len(), o.layers, o.open_loops, o.issues.len());
            for s in &o.objects { eprintln!("  object {:>2} {:<22} rot {:7.2} centre ({:.3}, {:.3}) bbox {:.3},{:.3} - {:.3},{:.3} layers {}", s.print_position, s.name, s.rotate_z_deg, s.center[0], s.center[1], s.bbox[0], s.bbox[1], s.bbox[2], s.bbox[3], s.layers); }
            for i in o.issues.iter().take(8) { eprintln!("  issue: {i}"); }
        }
        Err(e) => { eprintln!("fdmslice: REFUSED: {e}"); std::process::exit(3); }
    }
}

fn run() {
    let a: Vec<String> = std::env::args().collect();
    if a.get(1).map(|s| s.as_str()) == Some("--multi") { return run_multi(&a); }
    if a.get(1).map(|s| s.as_str()) == Some("--presets") { return run_presets(&a[2..]); }
    if a.len() < 4 { eprintln!("usage: fdmslice model.stl reference.gcode out.gcode"); std::process::exit(2); }
    let stl = match std::fs::read(&a[1]) { Ok(b) => b, Err(e) => refuse(&format!("cannot read model {}: {e}", a[1])) };
    let reff = match std::fs::read(&a[2]) { Ok(b) => String::from_utf8_lossy(&b).into_owned(), Err(e) => refuse(&format!("cannot read reference {}: {e}", a[2])) };
    if let Err(e) = gcode_parse::parse(&reff) { refuse(&format!("reference G-code does not parse: {e}")); }
    let m = match Mesh::from_stl(&stl) { Ok(m) => m, Err(e) => refuse(&e.to_string()) };
    let old = std::env::var("FDM_PLACE").map_or(false, |v| v == "bbox");
    let pl = if old {
        bbox_placement(&m, &reff).unwrap_or_else(|e| refuse(&e))
    } else {
        match fit_placement(&m, &reff) {
            Ok((p, msg)) => { eprintln!("fdmslice: {msg}"); p }
            Err(why) => {
                // never silently: say the fit was not possible, then fall back to the bounding-box placement
                eprintln!("fdmslice: placement fit not possible ({why}); using bounding-box placement");
                bbox_placement(&m, &reff).unwrap_or_else(|e| refuse(&e))
            }
        }
    };
    if std::env::var("FDM_FITONLY").is_ok() { eprintln!("fdmslice: FITONLY rotate {:.3} centre {:.3} {:.3}", pl.rotate_z_deg, pl.center[0], pl.center[1]); return; }
    match pipeline::slice_gcode(&stl, &reff, pl) {
        Ok(o) => {
            if let Err(e) = std::fs::write(&a[3], &o.gcode) { refuse(&format!("cannot write {}: {e}", a[3])); }
            eprintln!("fdmslice: {} layers, rotate {:.2}, open loops {}, {} issue(s)", o.layers, pl.rotate_z_deg, o.open_loops, o.issues.len());
            for i in o.issues.iter().take(8) { eprintln!("  issue: {i}"); }
        }
        Err(e) => { eprintln!("fdmslice: REFUSED: {e}"); std::process::exit(3); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn box_soup(x: f64, y: f64, z: f64) -> Vec<[f64; 9]> {
        let (a, b) = (-x / 2.0, x / 2.0);
        let (c, d) = (-y / 2.0, y / 2.0);
        let v = [[a, c, 0.0], [b, c, 0.0], [b, d, 0.0], [a, d, 0.0], [a, c, z], [b, c, z], [b, d, z], [a, d, z]];
        let f = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)];
        f.iter().map(|&(i, j, k)| [v[i][0], v[i][1], v[i][2], v[j][0], v[j][1], v[j][2], v[k][0], v[k][1], v[k][2]]).collect()
    }

    /// A reference G-code with a rectangle outer wall (w x d, inset 0.21 per side) turned by `deg` about `c`, 5 layers.
    fn reference(w: f64, d: f64, deg: f64, c: P) -> String {
        let (s, co) = deg.to_radians().sin_cos();
        let (hx, hy) = (w / 2.0 - 0.21, d / 2.0 - 0.21);
        let corners = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy], [-hx, -hy]];
        let mut g = String::from("; CONFIG_BLOCK_START\n; CONFIG_BLOCK_END\n");
        for l in 1..=5 {
            g += &format!("; CHANGE_LAYER\n; Z_HEIGHT: {}\n; LAYER_HEIGHT: 0.2\n; FEATURE: Outer wall\n", 0.2 * l as f64);
            let p0 = corners[0];
            g += &format!("G1 X{:.4} Y{:.4} F9000\n", c[0] + p0[0] * co - p0[1] * s, c[1] + p0[0] * s + p0[1] * co);
            for p in &corners[1..] { g += &format!("G1 X{:.4} Y{:.4} E.5 F3000\n", c[0] + p[0] * co - p[1] * s, c[1] + p[0] * s + p[1] * co); }
        }
        g
    }

    #[test]
    fn parse_reference_reads_outer_wall_polylines_per_layer() {
        let l = parse_reference(&reference(30.0, 10.0, 0.0, [100.0, 100.0]));
        assert_eq!(l.len(), 5);
        assert!((l[2].z - 0.6).abs() < 1e-9 && (l[2].h - 0.2).abs() < 1e-9);
        assert_eq!(l[0].lines.len(), 1);
        assert_eq!(l[0].lines[0].len(), 5); // start point + 4 extruding corners
    }

    #[test]
    fn free_fit_finds_an_arbitrary_rotation_not_just_multiples_of_90() {
        for deg in [17.0, 123.0, 301.5] {
            let mesh = Mesh::from_soup(&box_soup(30.0, 10.0, 1.0)).unwrap();
            let g = reference(30.0, 10.0, deg, [138.25, 128.0]);
            let (pl, msg) = fit_placement(&mesh, &g).unwrap();
            // a rectangle is symmetric under 180 deg: accept the angle or its half-turn partner
            let d = (pl.rotate_z_deg - deg).rem_euclid(180.0);
            assert!(d < 0.6 || d > 179.4, "wanted {deg}, got {} ({msg})", pl.rotate_z_deg);
            assert!((pl.center[0] - 138.25).abs() < 0.05 && (pl.center[1] - 128.0).abs() < 0.05, "{:?}", pl.center);
        }
    }

    #[test]
    fn a_wrong_rotation_scores_clearly_worse_negative_control() {
        let mesh = Mesh::from_soup(&box_soup(30.0, 10.0, 1.0)).unwrap();
        let g = reference(30.0, 10.0, 17.0, [138.25, 128.0]);
        // build the same layers fit_placement uses, then score a wrong angle against the right one
        let rl = parse_reference(&g);
        let (mn, _) = mesh.bbox();
        let mut m = mesh.clone();
        m.translate([0.0, 0.0, -mn[2]]);
        let specs: Vec<slice::LayerSpec> = rl.iter().map(|l| slice::LayerSpec { lo: l.z - l.h, hi: l.z, slice_z: l.z - l.h / 2.0 }).collect();
        let sl = slice::slice_mesh(&m, &specs, slice::SliceOptions::default());
        let layers: Vec<Layer2> = rl.iter().zip(&sl.layers).map(|(r, s)| {
            let inner = geom::offset(&s.region, -0.21);
            let rings: Vec<(Vec<P>, bool)> = inner.iter().map(|p| (p.contour.clone(), true)).collect();
            Layer2 { orca: resample(&r.lines.iter().map(|l| (l.clone(), false)).collect::<Vec<_>>(), 300), ours: resample(&rings, 300) }
        }).collect();
        let c0 = [0.0, 0.0];
        let good = { let t = bbox_translation(&layers, c0, 17.0); score(&layers, c0, 17.0, t) };
        let bad = { let t = bbox_translation(&layers, c0, 57.0); score(&layers, c0, 57.0, t) };
        assert!(good < 0.12, "{good}");
        assert!(bad > 5.0 * good && bad > 1.0, "good {good} bad {bad}");
    }

    #[test]
    fn arrange_set_gives_the_exact_angle_when_the_reference_follows_orcas_rule() {
        // the mesh is a box already turned by -23 deg in its own frame; arrange rotates it back by +23 (min-area bbox)
        let (s, c) = (-23f64).to_radians().sin_cos();
        let tris: Vec<[f64; 9]> = box_soup(30.0, 10.0, 1.0).iter().map(|t| {
            let mut o = *t;
            for k in 0..3 { let (x, y) = (t[3 * k], t[3 * k + 1]); o[3 * k] = x * c - y * s; o[3 * k + 1] = x * s + y * c; }
            o
        }).collect();
        let mesh = Mesh::from_soup(&tris).unwrap();
        let g = reference(30.0, 10.0, 0.0, [138.25, 128.0]);
        let (pl, msg) = fit_placement(&mesh, &g).unwrap();
        // 23 deg or its half-turn partner (the rectangle is symmetric), exactly, because it comes from the candidate set
        let d = (pl.rotate_z_deg - 23.0).rem_euclid(180.0);
        assert!(d < 0.01 || d > 179.99, "got {} ({msg})", pl.rotate_z_deg);
        assert!(msg.contains("arrange set"), "{msg}");
    }

    #[test]
    fn arrange_candidates_are_min_area_edge_plus_k_times_45() {
        // rectangle turned by 20 deg: min-area bbox edge direction 20 deg -> rotation -20 (=340) + 45k
        let (s, c) = 20f64.to_radians().sin_cos();
        let hp: Vec<P> = [[-15.0, -5.0], [15.0, -5.0], [15.0, 5.0], [-15.0, 5.0]].iter().map(|p| [p[0] * c - p[1] * s, p[0] * s + p[1] * c]).collect();
        let cand = arrange_candidates(&hull(hp));
        assert!(cand.iter().any(|d| (d - 340.0).abs() < 1e-6), "{cand:?}");
        assert!(cand.iter().any(|d| ((d + 20.0).rem_euclid(45.0)).min(45.0 - (d + 20.0).rem_euclid(45.0)) > 1e-6) == false, "all candidates must be 340 + 45k: {cand:?}");
    }
}
