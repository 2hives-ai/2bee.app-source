//! Fuzzy skin: port of Orca's `Feature/FuzzySkin` (point re-sampling along a loop with a random
//! 3/4..5/4 x point_distance step and a perpendicular displacement drawn from a noise module), plus a
//! port of libnoise's Perlin / Billow / RidgedMulti / Voronoi modules (the deterministic noise types)
//! and the sine "ripple" mode. The classic noise type is uniform random in [-1, 1] in Orca; here it
//! comes from a seeded PRNG so the output is reproducible (compare statistically, not point by point).
use super::adapter as g;
use crate::types::{ExtPath, Feature, PathPt, Polys};

type P = [f64; 2];

// ---------------------------------------------------------------- deterministic PRNG
/// splitmix64-seeded xorshift64*: tiny, portable (wasm friendly), no external dependency.
#[derive(Clone, Debug)]
pub struct Rng(u64);
impl Rng {
    pub fn new(seed: u64) -> Self { let mut s = Rng(seed ^ 0x9E37_79B9_7F4A_7C15); s.next_u64(); s }
    /// Independent stream per (seed, layer, loop).
    pub fn for_loop(seed: u64, layer_id: usize, loop_key: usize) -> Self {
        Rng::new(seed.wrapping_mul(0xD6E8_FEB8_6659_FD93) ^ ((layer_id as u64) << 20) ^ (loop_key as u64).wrapping_mul(0x9E37_79B9))
    }
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform in [0, 1).
    pub fn uniform(&mut self) -> f64 { (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64 }
}

// ---------------------------------------------------------------- libnoise port
mod libnoise {
    include!("vectortable_inc.rs");
    const X_NOISE_GEN: i32 = 1619;
    const Y_NOISE_GEN: i32 = 31337;
    const Z_NOISE_GEN: i32 = 6971;
    const SEED_NOISE_GEN: i32 = 1013;
    const SHIFT_NOISE_GEN: i32 = 8;

    fn scurve3(a: f64) -> f64 { a * a * (3.0 - 2.0 * a) }
    fn lerp(n0: f64, n1: f64, a: f64) -> f64 { (1.0 - a) * n0 + a * n1 }
    fn make_int32_range(n: f64) -> f64 {
        if n >= 1073741824.0 { 2.0 * (n % 1073741824.0) - 1073741824.0 }
        else if n <= -1073741824.0 { 2.0 * (n % 1073741824.0) + 1073741824.0 }
        else { n }
    }
    fn floor_i(x: f64) -> i32 { if x > 0.0 { x as i32 } else { (x as i32) - 1 } }

    fn gradient_noise_3d(fx: f64, fy: f64, fz: f64, ix: i32, iy: i32, iz: i32, seed: i32) -> f64 {
        let mut vi: i32 = X_NOISE_GEN.wrapping_mul(ix)
            .wrapping_add(Y_NOISE_GEN.wrapping_mul(iy))
            .wrapping_add(Z_NOISE_GEN.wrapping_mul(iz))
            .wrapping_add(SEED_NOISE_GEN.wrapping_mul(seed));
        vi ^= vi >> SHIFT_NOISE_GEN;
        vi &= 0xff;
        let b = (vi as usize) << 2;
        (RANDOM_VECTORS[b] * (fx - ix as f64) + RANDOM_VECTORS[b + 1] * (fy - iy as f64) + RANDOM_VECTORS[b + 2] * (fz - iz as f64)) * 2.12
    }
    pub fn gradient_coherent_noise_3d(x: f64, y: f64, z: f64, seed: i32) -> f64 {
        let (x0, y0, z0) = (floor_i(x), floor_i(y), floor_i(z));
        let (x1, y1, z1) = (x0 + 1, y0 + 1, z0 + 1);
        let xs = scurve3(x - x0 as f64);
        let ys = scurve3(y - y0 as f64);
        let zs = scurve3(z - z0 as f64);
        let gn = |ix, iy, iz| gradient_noise_3d(x, y, z, ix, iy, iz, seed);
        let ix0 = lerp(gn(x0, y0, z0), gn(x1, y0, z0), xs);
        let ix1 = lerp(gn(x0, y1, z0), gn(x1, y1, z0), xs);
        let iy0 = lerp(ix0, ix1, ys);
        let ix0 = lerp(gn(x0, y0, z1), gn(x1, y0, z1), xs);
        let ix1 = lerp(gn(x0, y1, z1), gn(x1, y1, z1), xs);
        let iy1 = lerp(ix0, ix1, ys);
        lerp(iy0, iy1, zs)
    }
    fn int_value_noise_3d(x: i32, y: i32, z: i32, seed: i32) -> i32 {
        let mut n: i32 = X_NOISE_GEN.wrapping_mul(x).wrapping_add(Y_NOISE_GEN.wrapping_mul(y)).wrapping_add(Z_NOISE_GEN.wrapping_mul(z)).wrapping_add(SEED_NOISE_GEN.wrapping_mul(seed)) & 0x7fffffff;
        n = (n >> 13) ^ n;
        let inner = n.wrapping_mul(n).wrapping_mul(60493).wrapping_add(19990303);
        n.wrapping_mul(inner).wrapping_add(1376312589) & 0x7fffffff
    }
    pub fn value_noise_3d(x: i32, y: i32, z: i32, seed: i32) -> f64 { 1.0 - int_value_noise_3d(x, y, z, seed) as f64 / 1073741824.0 }

    pub fn perlin(x: f64, y: f64, z: f64, freq: f64, octaves: i32, persistence: f64) -> f64 {
        let (mut x, mut y, mut z) = (x * freq, y * freq, z * freq);
        let (mut value, mut cur) = (0.0, 1.0);
        for o in 0..octaves {
            let s = gradient_coherent_noise_3d(make_int32_range(x), make_int32_range(y), make_int32_range(z), o);
            value += s * cur;
            x *= 2.0; y *= 2.0; z *= 2.0; cur *= persistence;
        }
        value
    }
    pub fn billow(x: f64, y: f64, z: f64, freq: f64, octaves: i32, persistence: f64) -> f64 {
        let (mut x, mut y, mut z) = (x * freq, y * freq, z * freq);
        let (mut value, mut cur) = (0.0, 1.0);
        for o in 0..octaves {
            let s = gradient_coherent_noise_3d(make_int32_range(x), make_int32_range(y), make_int32_range(z), o);
            value += (2.0 * s.abs() - 1.0) * cur;
            x *= 2.0; y *= 2.0; z *= 2.0; cur *= persistence;
        }
        value + 0.5
    }
    pub fn ridged_multi(x: f64, y: f64, z: f64, freq: f64, octaves: i32) -> f64 {
        let (mut x, mut y, mut z) = (x * freq, y * freq, z * freq);
        let (mut value, mut weight) = (0.0, 1.0f64);
        let (offset, gain) = (1.0, 2.0);
        let mut spectral = 1.0f64; // frequency^-h with h=1, lacunarity 2
        for o in 0..octaves {
            let mut s = gradient_coherent_noise_3d(make_int32_range(x), make_int32_range(y), make_int32_range(z), o & 0x7fffffff);
            s = offset - s.abs();
            s *= s;
            s *= weight;
            weight = (s * gain).clamp(0.0, 1.0);
            value += s * spectral;
            x *= 2.0; y *= 2.0; z *= 2.0; spectral *= 0.5;
        }
        value * 1.25 - 1.0
    }
    pub fn voronoi(x: f64, y: f64, z: f64, freq: f64) -> f64 {
        let (x, y, z) = (x * freq, y * freq, z * freq);
        let (xi, yi, zi) = (floor_i(x), floor_i(y), floor_i(z));
        let mut min_dist = 2147483647.0f64;
        let (mut xc, mut yc, mut zc) = (0.0, 0.0, 0.0);
        for zc_ in zi - 2..=zi + 2 { for yc_ in yi - 2..=yi + 2 { for xc_ in xi - 2..=xi + 2 {
            let xp = xc_ as f64 + value_noise_3d(xc_, yc_, zc_, 0);
            let yp = yc_ as f64 + value_noise_3d(xc_, yc_, zc_, 1);
            let zp = zc_ as f64 + value_noise_3d(xc_, yc_, zc_, 2);
            let d = (xp - x).powi(2) + (yp - y).powi(2) + (zp - z).powi(2);
            if d < min_dist { min_dist = d; xc = xp; yc = yp; zc = zp; }
        } } }
        1.0 * value_noise_3d(xc.floor() as i32, yc.floor() as i32, zc.floor() as i32, 0)
    }
}

// ---------------------------------------------------------------- config
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FuzzySkinType { None, External, Hole, All, AllWalls, Disabled }
impl FuzzySkinType {
    pub fn from_key(k: &str) -> Option<Self> {
        Some(match k { "none" => Self::None, "external" => Self::External, "hole" => Self::Hole, "all" => Self::All, "allwalls" => Self::AllWalls, "disabled_fuzzy" => Self::Disabled, _ => return None })
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoiseType { Classic, Perlin, Billow, RidgedMulti, Voronoi, Ripple }
impl NoiseType {
    pub fn from_key(k: &str) -> Option<Self> {
        Some(match k { "classic" => Self::Classic, "perlin" => Self::Perlin, "billow" => Self::Billow, "ridgedmulti" => Self::RidgedMulti, "voronoi" => Self::Voronoi, "ripple" => Self::Ripple, _ => return None })
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FuzzyMode { Displacement, Extrusion, Combined }
impl FuzzyMode {
    pub fn from_key(k: &str) -> Option<Self> {
        Some(match k { "displacement" => Self::Displacement, "extrusion" => Self::Extrusion, "combined" => Self::Combined, _ => return None })
    }
}

/// Orca `FuzzySkinConfig`, lengths in mm. `ripple_offset` is the config percent as a plain number (50 for 50%).
#[derive(Clone, Debug)]
pub struct FuzzyConfig {
    pub kind: FuzzySkinType,
    pub thickness: f64,
    pub point_distance: f64,
    pub first_layer: bool,
    pub noise_type: NoiseType,
    pub noise_scale: f64,
    pub noise_octaves: i32,
    pub noise_persistence: f64,
    pub mode: FuzzyMode,
    pub ripples_per_layer: f64,
    pub ripple_offset: f64,
    pub layers_between_ripple_offset: i32,
    /// Mixed into the PRNG stream (reproducibility knob, no Orca counterpart).
    pub seed: u64,
}
impl Default for FuzzyConfig {
    /// X2D 0.20mm profile defaults (fuzzy_skin = disabled_fuzzy; thickness 0.2, point_distance 0.3).
    fn default() -> Self {
        FuzzyConfig {
            kind: FuzzySkinType::Disabled, thickness: 0.2, point_distance: 0.3, first_layer: false, noise_type: NoiseType::Classic,
            noise_scale: 1.0, noise_octaves: 4, noise_persistence: 0.5, mode: FuzzyMode::Displacement, ripples_per_layer: 15.0,
            ripple_offset: 50.0, layers_between_ripple_offset: 1, seed: 1,
        }
    }
}

/// `Feature::FuzzySkin::should_fuzzify`.
pub fn should_fuzzify(c: &FuzzyConfig, layer_id: i64, loop_idx: usize, is_contour: bool) -> bool {
    if matches!(c.kind, FuzzySkinType::None | FuzzySkinType::Disabled) { return false; }
    if !c.first_layer && layer_id <= 0 { return false; }
    let contours = (loop_idx == 0 && c.kind != FuzzySkinType::Hole) || c.kind == FuzzySkinType::AllWalls;
    let holes = matches!(c.kind, FuzzySkinType::Hole | FuzzySkinType::All | FuzzySkinType::AllWalls) && (loop_idx == 0 || c.kind == FuzzySkinType::AllWalls);
    if is_contour { contours } else { holes }
}

fn noise_value(c: &FuzzyConfig, x: f64, y: f64, z: f64, rng: &mut Rng) -> f64 {
    let f = 1.0 / c.noise_scale;
    match c.noise_type {
        NoiseType::Perlin => libnoise::perlin(x, y, z, f, c.noise_octaves, c.noise_persistence),
        NoiseType::Billow => libnoise::billow(x, y, z, f, c.noise_octaves, c.noise_persistence),
        NoiseType::RidgedMulti => libnoise::ridged_multi(x, y, z, f, c.noise_octaves),
        NoiseType::Voronoi => libnoise::voronoi(x, y, z, f),
        _ => rng.uniform() * 2.0 - 1.0,
    }
}

fn perp_unit(d: P) -> P { let l = d[0].hypot(d[1]); if l == 0.0 { [0.0, 0.0] } else { [-d[1] / l, d[0] / l] } }

// ---------------------------------------------------------------- ripple
fn ripple_phase_shift(c: &FuzzyConfig, layer_id: i64) -> f64 {
    if c.ripple_offset == 0.0 || c.layers_between_ripple_offset <= 0 { return 0.0; }
    let eff = layer_id.max(0) as i32;
    let period = eff / c.layers_between_ripple_offset.max(1);
    (period as f64 * (c.ripple_offset / 100.0) * 2.0 * std::f64::consts::PI) % (2.0 * std::f64::consts::PI)
}
fn ripple_anchor_arc(pts: &[P], closed: bool) -> f64 {
    let np = pts.len();
    let nseg = if closed { np } else { np.saturating_sub(1) };
    let at = |i: usize| pts[i % np];
    let mut anchor = [f64::MAX, f64::MAX];
    let mut found = false;
    for i in 0..nseg {
        let (a, b) = (at(i), at(i + 1));
        if (a[1] <= 0.0 && b[1] >= 0.0) || (a[1] >= 0.0 && b[1] <= 0.0) {
            let t = if (b[1] - a[1]).abs() < 1e-9 { 0.0 } else { a[1] / (a[1] - b[1]) };
            let xc = a[0] + t.clamp(0.0, 1.0) * (b[0] - a[0]);
            if !found || xc < anchor[0] { anchor = [xc, 0.0]; found = true; }
        }
    }
    if !found {
        let mut best = f64::MAX;
        for p in pts { if p[1].abs() < best { best = p[1].abs(); anchor = *p; } }
    }
    let (mut arc, mut best_d, mut acc) = (0.0, f64::MAX, 0.0);
    for i in 0..nseg {
        let (a, b) = (at(i), at(i + 1));
        let s = [b[0] - a[0], b[1] - a[1]];
        let l = s[0].hypot(s[1]);
        if l > 1e-9 {
            let t = (((anchor[0] - a[0]) * s[0] + (anchor[1] - a[1]) * s[1]) / (l * l)).clamp(0.0, 1.0);
            let d2 = (a[0] + s[0] * t - anchor[0]).powi(2) + (a[1] + s[1] * t - anchor[1]).powi(2);
            if d2 < best_d { best_d = d2; arc = acc + t * l; }
        }
        acc += l;
    }
    arc
}
/// Sine ripple along arc length (closed loop or open polyline); widths ride along from the segment end.
fn ripple(pts: &[PathPt], closed: bool, c: &FuzzyConfig, layer_id: i64) -> Vec<PathPt> {
    let amp = c.thickness;
    let n = c.ripples_per_layer;
    let step = c.point_distance;
    if n <= 0.0 || step < 1e-6 { return pts.to_vec(); }
    let xy: Vec<P> = pts.iter().map(|p| [p.x, p.y]).collect();
    let np = xy.len();
    let nseg = if closed { np } else { np - 1 };
    let mut perimeter = 0.0;
    for i in 0..nseg { let (a, b) = (xy[i], xy[(i + 1) % np]); perimeter += (b[0] - a[0]).hypot(b[1] - a[1]); }
    if perimeter < 1e-6 { return pts.to_vec(); }
    let anchor = ripple_anchor_arc(&xy, closed);
    let phase0 = 2.0 * std::f64::consts::PI + ripple_phase_shift(c, layer_id);
    let phase = |s: f64| n * 2.0 * std::f64::consts::PI * (s - anchor) / perimeter + phase0;
    let mut out: Vec<PathPt> = Vec::new();
    let mut acc = 0.0;
    for i in 0..nseg {
        let (a, b) = (xy[i], xy[(i + 1) % np]);
        let seg = [b[0] - a[0], b[1] - a[1]];
        let l = seg[0].hypot(seg[1]);
        if l < 1e-4 { continue; }
        let pu = perp_unit(seg);
        let end = acc + l;
        let mut s = (acc / step).ceil() * step;
        while s < end {
            let t = (s - acc) / l;
            let d = phase(s).sin() * amp;
            out.push(PathPt { x: a[0] + seg[0] * t + pu[0] * d, y: a[1] + seg[1] * t + pu[1] * d, w: pts[(i + 1) % np].w });
            s += step;
        }
        acc = end;
    }
    while out.len() < 3 && np >= 2 { out.push(pts[np - 2]); }
    if out.len() >= 3 { out } else { pts.to_vec() }
}

// ---------------------------------------------------------------- the two fuzzy_* entry points
/// Orca `fuzzy_polyline` (classic wall polygons: constant width, `closed` = loop). The first generated point is
/// the new start; no original vertex survives (Orca behaviour).
pub fn fuzzy_polyline(pts: &[PathPt], closed: bool, slice_z: f64, c: &FuzzyConfig, layer_id: i64, rng: &mut Rng) -> Vec<PathPt> {
    if pts.len() < 3 && closed { return pts.to_vec(); }
    if c.noise_type == NoiseType::Ripple { return ripple(pts, closed, c, layer_id); }
    let min_d = c.point_distance * 3.0 / 4.0;
    let range = c.point_distance / 2.0;
    let mut left_over = rng.uniform() * (min_d / 2.0);
    let mut out: Vec<PathPt> = Vec::with_capacity(pts.len());
    let n = pts.len();
    let mut p0 = if closed { pts[n - 1] } else { pts[0] };
    let mut skip_first = !closed;
    for &p1 in pts {
        if skip_first { skip_first = false; p0 = p1; continue; }
        let d = [p1.x - p0.x, p1.y - p0.y];
        let size = d[0].hypot(d[1]);
        let pu = perp_unit(d);
        let mut dist = left_over;
        while dist < size {
            let (px, py) = (p0.x + d[0] * dist / size, p0.y + d[1] * dist / size);
            let r = noise_value(c, px, py, slice_z, rng) * c.thickness;
            out.push(PathPt { x: px + pu[0] * r, y: py + pu[1] * r, w: p1.w });
            dist += min_d + rng.uniform() * range;
        }
        left_over = dist - size;
        p0 = p1;
    }
    while out.len() < 3 && n >= 2 { out.push(pts[n - 2]); if n == 2 { break; } }
    if out.len() >= 3 { out } else { pts.to_vec() }
}

/// Orca `fuzzy_extrusion_line` (Arachne lines: per-point widths, Extrusion/Combined modes). A closed line
/// repeats its first point at the end; that is preserved.
pub fn fuzzy_extrusion_line(pts: &[PathPt], closed: bool, slice_z: f64, c: &FuzzyConfig, layer_id: i64, rng: &mut Rng) -> Vec<PathPt> {
    if pts.len() < 3 { return pts.to_vec(); }
    if c.noise_type == NoiseType::Ripple { return ripple(pts, closed, c, layer_id); }
    let min_d = c.point_distance * 3.0 / 4.0;
    let range = c.point_distance / 2.0;
    let min_w = 0.01;
    let mut left_over = rng.uniform() * (min_d / 2.0);
    let mut out: Vec<PathPt> = Vec::with_capacity(pts.len());
    let mut p0 = pts[0];
    for &p1 in pts {
        if closed && p0.x == p1.x && p0.y == p1.y { out.push(p1); continue; }
        let d = [p1.x - p0.x, p1.y - p0.y];
        let size = d[0].hypot(d[1]);
        let pu = perp_unit(d);
        let mut dist = left_over;
        while dist < size {
            let (px, py) = (p0.x + d[0] * dist / size, p0.y + d[1] * dist / size);
            let r = noise_value(c, px, py, slice_z, rng) * c.thickness;
            let pt = match c.mode {
                FuzzyMode::Displacement => PathPt { x: px + pu[0] * r, y: py + pu[1] * r, w: p1.w },
                FuzzyMode::Extrusion => PathPt { x: px, y: py, w: (p1.w + r + min_w).max(min_w) },
                FuzzyMode::Combined => { let rad = (p1.w + r + min_w).max(min_w); PathPt { x: px + pu[0] * (rad - p1.w) / 2.0, y: py + pu[1] * (rad - p1.w) / 2.0, w: rad } }
            };
            out.push(pt);
            dist += min_d + rng.uniform() * range;
        }
        left_over = dist - size;
        p0 = p1;
    }
    let n = pts.len();
    while out.len() < 3 { out.push(pts[n - 2]); if n < 3 { break; } }
    let (f, l) = (pts[0], pts[n - 1]);
    if f.x == l.x && f.y == l.y && out.len() >= 2 { let last = *out.last().unwrap(); out[0] = last; }
    if out.len() >= 3 { out } else { pts.to_vec() }
}

/// Fuzzify ONE wall path (an `ExtPath` with `closed`), if the config selects it.
/// `loop_idx` 0 = outermost wall, `is_contour` false = wall around a hole. `arachne_style` selects
/// `fuzzy_extrusion_line` (variable width / closing point repeated) instead of the classic polygon version.
pub fn apply_fuzzy_skin(path: &ExtPath, loop_idx: usize, is_contour: bool, layer_id: i64, slice_z: f64, c: &FuzzyConfig, arachne_style: bool) -> ExtPath {
    if !should_fuzzify(c, layer_id, loop_idx, is_contour) { return path.clone(); }
    let mut rng = Rng::for_loop(c.seed, layer_id.max(0) as usize, loop_idx * 2 + is_contour as usize);
    let mut pts = path.pts.clone();
    // classic polygons carry no repeated closing point; tolerate one anyway
    let repeated = path.closed && pts.len() > 1 && pts[0].x == pts[pts.len() - 1].x && pts[0].y == pts[pts.len() - 1].y;
    if repeated && !arachne_style { pts.pop(); }
    let out = if arachne_style { fuzzy_extrusion_line(&pts, path.closed, slice_z, c, layer_id, &mut rng) } else { fuzzy_polyline(&pts, path.closed, slice_z, c, layer_id, &mut rng) };
    let mut res = path.clone();
    res.pts = out;
    res
}

/// For a layer's wall paths (Outer/Inner/Overhang wall, closed), find which region ring each follows so
/// `is_contour` can be decided: a loop is a "hole" loop when its nearest region ring is a hole.
pub fn loop_is_contour(path: &ExtPath, lslices: &Polys) -> bool {
    let mut best = (f64::MAX, true);
    let sample: Vec<&PathPt> = path.pts.iter().step_by((path.pts.len() / 8).max(1)).collect();
    for poly in lslices {
        for (ring, is_c) in std::iter::once((&poly.contour, true)).chain(poly.holes.iter().map(|h| (h, false))) {
            let n = ring.len();
            let mut tot = 0.0;
            for p in &sample {
                let mut dmin = f64::MAX;
                for i in 0..n {
                    let (a, b) = (ring[i], ring[(i + 1) % n]);
                    let s = [b[0] - a[0], b[1] - a[1]];
                    let l2 = s[0] * s[0] + s[1] * s[1];
                    let t = if l2 == 0.0 { 0.0 } else { (((p.x - a[0]) * s[0] + (p.y - a[1]) * s[1]) / l2).clamp(0.0, 1.0) };
                    dmin = dmin.min((a[0] + s[0] * t - p.x).hypot(a[1] + s[1] * t - p.y));
                }
                tot += dmin;
            }
            if tot < best.0 { best = (tot, is_c); }
        }
    }
    best.1
}

/// Convenience: fuzzify all closed wall paths of one layer. Loop index = order of appearance of
/// InnerWall paths per contour class (OuterWall/OverhangWall-of-outer = 0). Paths that are not closed
/// walls pass through untouched. `lslices` is the layer outline used to classify contour vs hole.
pub fn fuzzify_layer_walls(paths: &[ExtPath], lslices: &Polys, layer_id: i64, slice_z: f64, c: &FuzzyConfig, arachne_style: bool) -> Vec<ExtPath> {
    let mut inner_seen_contour = 0usize;
    let mut inner_seen_hole = 0usize;
    paths.iter().map(|p| {
        let is_wall = matches!(p.feature, Feature::OuterWall | Feature::InnerWall | Feature::OverhangWall);
        if !is_wall || !p.closed { return p.clone(); }
        let is_contour = loop_is_contour(p, lslices);
        let loop_idx = match p.feature {
            Feature::OuterWall => 0,
            _ => { let c = if is_contour { &mut inner_seen_contour } else { &mut inner_seen_hole }; *c += 1; *c }
        };
        apply_fuzzy_skin(p, loop_idx, is_contour, layer_id, slice_z, c_ref(c), arachne_style)
    }).collect()
}
fn c_ref(c: &FuzzyConfig) -> &FuzzyConfig { c }

#[allow(dead_code)]
fn _unused(_: &Polys) { let _ = g::area; }

#[cfg(test)]
mod tests {
    use super::*;

    fn square(hw: f64, w: f64) -> ExtPath {
        let pts = [(-hw, -hw), (hw, -hw), (hw, hw), (-hw, hw)];
        ExtPath { feature: Feature::OuterWall, pts: pts.iter().map(|&(x, y)| PathPt { x, y, w }).collect(), closed: true, layer_h: 0.2, speed: 0.0, flow_ratio: 1.0 }
    }
    fn len(p: &[PathPt], closed: bool) -> f64 {
        let n = p.len();
        let mut l: f64 = p.windows(2).map(|w| (w[1].x - w[0].x).hypot(w[1].y - w[0].y)).sum();
        if closed { l += (p[0].x - p[n - 1].x).hypot(p[0].y - p[n - 1].y); }
        l
    }
    fn cfg() -> FuzzyConfig { FuzzyConfig { kind: FuzzySkinType::External, ..FuzzyConfig::default() } }

    /// Reference values produced by compiling Orca's own vendored libnoise (deps/.../dep_libnoise) with the
    /// exact module parameters fuzzy skin uses (frequency 1, 4 octaves, persistence 0.5, displacement 1).
    #[test]
    fn libnoise_port_matches_reference_values() {
        let pts = [(0.5, 0.3, 0.7), (12.34, -5.6, 2.2), (-3.3, 8.8, 0.1), (100.25, 50.75, 10.5), (0.0, 0.0, 0.0)];
        let want = [
            [0.2898239425, -0.0482649821, -0.1241182948, -0.2817909839],
            [0.3610545884, -0.6528908232, 0.5314591099, -0.5338393236],
            [-0.0542045874, -0.0440885460, 0.1804162374, -0.1266650492],
            [-0.3476702140, 0.0964015034, -0.4424374839, -0.4818304339],
            [0.0, -1.375, 1.34375, 0.3767276248],
        ];
        for (p, w) in pts.iter().zip(want) {
            let got = [libnoise::perlin(p.0, p.1, p.2, 1.0, 4, 0.5), libnoise::billow(p.0, p.1, p.2, 1.0, 4, 0.5),
                       libnoise::ridged_multi(p.0, p.1, p.2, 1.0, 4), libnoise::voronoi(p.0, p.1, p.2, 1.0)];
            for k in 0..4 { assert!((got[k] - w[k]).abs() < 1e-6, "module {k} at {p:?}: {} vs {}", got[k], w[k]); }
        }
    }
    #[test]
    fn should_fuzzify_truth_table() {
        let mk = |k| FuzzyConfig { kind: k, ..FuzzyConfig::default() };
        use FuzzySkinType::*;
        // (type, layer, loop, is_contour) -> fuzzify?
        assert!(should_fuzzify(&mk(External), 5, 0, true));
        assert!(!should_fuzzify(&mk(External), 5, 1, true));
        assert!(!should_fuzzify(&mk(External), 5, 0, false));
        assert!(!should_fuzzify(&mk(Hole), 5, 0, true));
        assert!(should_fuzzify(&mk(Hole), 5, 0, false));
        assert!(should_fuzzify(&mk(All), 5, 0, true) && should_fuzzify(&mk(All), 5, 0, false));
        assert!(!should_fuzzify(&mk(All), 5, 1, true) && !should_fuzzify(&mk(All), 5, 1, false));
        assert!(should_fuzzify(&mk(AllWalls), 5, 3, true) && should_fuzzify(&mk(AllWalls), 5, 3, false));
        assert!(!should_fuzzify(&mk(None), 5, 0, true) && !should_fuzzify(&mk(Disabled), 5, 0, true));
        // first layer is skipped unless asked for
        assert!(!should_fuzzify(&mk(External), 0, 0, true));
        assert!(should_fuzzify(&FuzzyConfig { first_layer: true, ..mk(External) }, 0, 0, true));
    }
    #[test]
    fn deterministic_per_seed_and_different_across_seeds() {
        let p = square(9.79, 0.42);
        let a = apply_fuzzy_skin(&p, 0, true, 10, 2.1, &cfg(), false);
        let b = apply_fuzzy_skin(&p, 0, true, 10, 2.1, &cfg(), false);
        assert_eq!(a.pts, b.pts);
        let c = apply_fuzzy_skin(&p, 0, true, 10, 2.1, &FuzzyConfig { seed: 2, ..cfg() }, false);
        assert_ne!(a.pts, c.pts);
        let d = apply_fuzzy_skin(&p, 0, true, 11, 2.3, &cfg(), false);
        assert_ne!(a.pts, d.pts, "layers must not repeat the same pattern");
    }
    /// Statistics measured on OrcaSlicer 2.5.0-dev (20 mm cube outer wall, 78.28 mm loop, classic noise,
    /// thickness 0.2, point distance 0.3): length +12.8..14.1%, signed displacement sd 0.120 / |max| 0.2,
    /// 248..250 G-code points (arc fitting merges some), mean chord 0.36.
    #[test]
    fn statistics_match_orca_on_the_cube_wall() {
        let p = square(9.79, 0.42);
        let base = len(&p.pts.iter().copied().collect::<Vec<_>>(), true);
        let (mut lens, mut sds) = (vec![], vec![]);
        for seed in 1..=20u64 {
            let o = apply_fuzzy_skin(&p, 0, true, 10, 2.0, &FuzzyConfig { seed, ..cfg() }, false);
            lens.push(len(&o.pts, true) / base);
            let d: Vec<f64> = o.pts.iter().map(|q| (q.x.abs() - 9.79).max(q.y.abs() - 9.79)).collect();
            assert!(d.iter().all(|v| v.abs() <= 0.2 + 1e-9), "displacement exceeds thickness");
            let m = d.iter().sum::<f64>() / d.len() as f64;
            sds.push((d.iter().map(|v| (v - m).powi(2)).sum::<f64>() / d.len() as f64).sqrt());
            assert!(o.pts.len() > 240 && o.pts.len() < 290, "{}", o.pts.len());
        }
        let ml = lens.iter().sum::<f64>() / lens.len() as f64;
        let ms = sds.iter().sum::<f64>() / sds.len() as f64;
        assert!(ml > 1.09 && ml < 1.19, "mean length ratio {ml}");   // Orca 1.128..1.141
        assert!((ms - 0.115).abs() < 0.012, "displacement sd {ms}");  // uniform(-0.2,0.2) sd = 0.1155
    }
    #[test]
    fn point_spacing_follows_three_quarters_to_five_quarters_rule() {
        // a long straight open line: consecutive generated points are 0.225..0.375 apart along the line
        let line: Vec<PathPt> = (0..=100).map(|i| PathPt { x: i as f64, y: 0.0, w: 0.42 }).collect();
        let c = FuzzyConfig { thickness: 0.0, ..cfg() }; // zero displacement isolates the spacing
        let mut rng = Rng::new(7);
        let o = fuzzy_polyline(&line, false, 1.0, &c, 5, &mut rng);
        let gaps: Vec<f64> = o.windows(2).map(|w| w[1].x - w[0].x).collect();
        assert!(gaps.len() > 200);
        assert!(gaps.iter().all(|&g| g >= 0.225 - 1e-9 && g <= 0.375 + 1e-9), "{:?}", gaps.iter().cloned().fold((9.0f64, 0.0f64), |(a, b), g| (a.min(g), b.max(g))));
        let mean = gaps.iter().sum::<f64>() / gaps.len() as f64;
        assert!((mean - 0.30).abs() < 0.01);
    }
    #[test]
    fn disabled_or_unselected_loops_pass_through_untouched() {
        let p = square(5.0, 0.42);
        assert_eq!(apply_fuzzy_skin(&p, 0, true, 5, 1.0, &FuzzyConfig::default(), false).pts, p.pts); // disabled_fuzzy
        assert_eq!(apply_fuzzy_skin(&p, 1, true, 5, 1.0, &cfg(), false).pts, p.pts); // inner wall under External
        assert_eq!(apply_fuzzy_skin(&p, 0, true, 0, 0.1, &cfg(), false).pts, p.pts); // first layer
    }
    #[test]
    fn extrusion_and_combined_modes_change_width() {
        let p = square(9.79, 0.42);
        let mut c = cfg();
        c.mode = FuzzyMode::Extrusion;
        let o = apply_fuzzy_skin(&p, 0, true, 10, 2.0, &c, true);
        let (mn, mx) = o.pts.iter().fold((9.0f64, 0.0f64), |(a, b), q| (a.min(q.w), b.max(q.w)));
        assert!(mx - mn > 0.1 && mn >= 0.01, "{mn} {mx}");
        // geometry is not displaced in pure extrusion mode: every point sits on the original square
        assert!(o.pts.iter().all(|q| ((q.x.abs() - 9.79).abs() < 1e-6 && q.y.abs() <= 9.79 + 1e-6) || ((q.y.abs() - 9.79).abs() < 1e-6 && q.x.abs() <= 9.79 + 1e-6)));
        c.mode = FuzzyMode::Combined;
        let o2 = apply_fuzzy_skin(&p, 0, true, 10, 2.0, &c, true);
        assert!(o2.pts.iter().any(|q| (q.x.abs() - 9.79).abs() > 1e-3 && (q.y.abs() - 9.79).abs() > 1e-3 || ((q.x.abs() - 9.79).abs() > 1e-3 && (q.y.abs() - 9.79).abs() < 1e-6)));
    }
    #[test]
    fn ripple_is_a_deterministic_sine_of_arc_length() {
        let p = square(9.79, 0.42);
        let c = FuzzyConfig { noise_type: NoiseType::Ripple, ..cfg() };
        let a = apply_fuzzy_skin(&p, 0, true, 4, 0.9, &c, false);
        let b = apply_fuzzy_skin(&p, 0, true, 4, 0.9, &FuzzyConfig { seed: 99, ..c.clone() }, false);
        assert_eq!(a.pts, b.pts, "ripple must not depend on the PRNG");
        let d: Vec<f64> = a.pts.iter().map(|q| (q.x.abs() - 9.79).max(q.y.abs() - 9.79)).collect();
        assert!(d.iter().cloned().fold(0.0f64, f64::max) <= 0.2 + 1e-9);
        // 15 ripples over the perimeter -> about 30 sign changes of the displacement
        let flips = d.windows(2).filter(|w| (w[0] > 0.0) != (w[1] > 0.0)).count();
        assert!(flips >= 24 && flips <= 40, "{flips}");
    }
    #[test]
    fn contour_vs_hole_classification() {
        use crate::types::Poly;
        let region = vec![Poly { contour: vec![[-10.0, -10.0], [10.0, -10.0], [10.0, 10.0], [-10.0, 10.0]], holes: vec![vec![[-3.0, -3.0], [-3.0, 3.0], [3.0, 3.0], [3.0, -3.0]]] }];
        assert!(loop_is_contour(&square(9.79, 0.42), &region));
        assert!(!loop_is_contour(&square(3.2, 0.42), &region));
        let walls = vec![square(9.79, 0.42), square(3.2, 0.42)];
        let c = FuzzyConfig { kind: FuzzySkinType::Hole, ..FuzzyConfig::default() };
        let out = fuzzify_layer_walls(&walls, &region, 5, 1.0, &c, false);
        assert_eq!(out[0].pts, walls[0].pts, "contour untouched under hole-only");
        assert_ne!(out[1].pts, walls[1].pts, "hole wall fuzzified");
    }
}
