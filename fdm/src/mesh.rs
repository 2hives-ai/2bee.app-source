//! Lane 1: triangle mesh — STL (binary + ASCII) parsing, vertex welding, placement, validation.
//!
//! Vertices are stored as f64 holding the exact f32 values of the file (Orca reads STL as f32). Welding
//! merges vertices that quantise to the same `WELD_MM` grid cell; triangles that collapse to fewer than
//! three distinct vertices are dropped and COUNTED (never hidden): see `MeshReport`.
use crate::types::FdmError;
use std::collections::HashMap;

/// Weld grid (mm). STL vertices of one corner are bit-identical in sane exporters; this also joins
/// corners that differ by float noise (< 1e-6 mm).
pub const WELD_MM: f64 = 1e-6;

#[derive(Clone, Debug, Default)]
pub struct Mesh {
    pub verts: Vec<[f64; 3]>,
    pub tris: Vec<[u32; 3]>,
    /// Triangles in the file / after dropping the index-degenerate ones.
    pub tris_in_file: usize,
    pub tris_dropped_degenerate: usize,
}

/// Mesh health numbers. Nothing here is a silent fix: the caller decides what is acceptable.
#[derive(Clone, Debug, PartialEq)]
pub struct MeshReport {
    pub vertices: usize,
    pub triangles: usize,
    pub tris_dropped_degenerate: usize,
    /// Zero-area triangles that survived welding (collinear points).
    pub zero_area_tris: usize,
    /// Edges used by exactly one triangle (holes in the surface).
    pub open_edges: usize,
    /// Edges used by more than two triangles.
    pub nonmanifold_edges: usize,
    /// Edges used twice in the SAME direction (inconsistent winding).
    pub flipped_edges: usize,
    /// Signed volume (mm^3); negative = inverted (inside-out) winding.
    pub volume: f64,
    pub bbox_min: [f64; 3],
    pub bbox_max: [f64; 3],
}
impl MeshReport {
    /// Closed, consistently wound 2-manifold.
    pub fn is_watertight(&self) -> bool { self.open_edges == 0 && self.nonmanifold_edges == 0 && self.flipped_edges == 0 }
}

fn q(v: f64) -> i64 { (v / WELD_MM).round() as i64 }

/// Fast deterministic hasher (FxHash multiply-rotate + a murmur finaliser) for the integer-keyed maps in the hot
/// paths. std's default SipHash is DoS-hardened and ~3-5x slower for these keys. Only used for point lookups
/// and inserts, NEVER iterated, so no output can depend on its bucket order.
#[derive(Default, Clone, Copy)]
pub(crate) struct FxHasher { h: u64 }
const FX_K: u64 = 0x517c_c1b7_2722_0a95;
impl std::hash::Hasher for FxHasher {
    #[inline] fn write(&mut self, bytes: &[u8]) {
        for c in bytes.chunks(8) { let mut b = [0u8; 8]; b[..c.len()].copy_from_slice(c); self.write_u64(u64::from_le_bytes(b)); }
    }
    #[inline] fn write_u8(&mut self, i: u8) { self.write_u64(i as u64) }
    #[inline] fn write_u32(&mut self, i: u32) { self.write_u64(i as u64) }
    #[inline] fn write_i64(&mut self, i: i64) { self.write_u64(i as u64) }
    #[inline] fn write_usize(&mut self, i: usize) { self.write_u64(i as u64) }
    #[inline] fn write_u64(&mut self, i: u64) { self.h = (self.h.rotate_left(5) ^ i).wrapping_mul(FX_K); }
    #[inline] fn finish(&self) -> u64 { let mut x = self.h; x ^= x >> 33; x = x.wrapping_mul(0xff51_afd7_ed55_8ccd); x ^= x >> 33; x }
}
#[derive(Default, Clone, Copy)]
pub(crate) struct FxBuild;
impl std::hash::BuildHasher for FxBuild { type Hasher = FxHasher; #[inline] fn build_hasher(&self) -> FxHasher { FxHasher::default() } }

struct Welder { map: HashMap<[i64; 3], u32, FxBuild>, verts: Vec<[f64; 3]> }
impl Welder {
    fn new(cap: usize) -> Self { Welder { map: HashMap::with_capacity_and_hasher(cap, FxBuild), verts: Vec::new() } }
    fn add(&mut self, p: [f64; 3]) -> u32 {
        let k = [q(p[0]), q(p[1]), q(p[2])];
        if let Some(&i) = self.map.get(&k) { return i; }
        let i = self.verts.len() as u32;
        self.verts.push(p);
        self.map.insert(k, i);
        i
    }
}

impl Mesh {
    /// Build from raw triangle soup (9 floats per triangle), welding as it goes.
    pub fn from_soup(tris: &[[f64; 9]]) -> Result<Mesh, FdmError> {
        Mesh::from_soup_iter(tris.len(), tris.iter().copied())
    }

    /// Same as `from_soup` for a lazily produced soup of `n` triangles (the binary STL path uses it so the
    /// 72-byte-per-triangle intermediate array never exists).
    fn from_soup_iter(n: usize, tris: impl Iterator<Item = [f64; 9]>) -> Result<Mesh, FdmError> {
        // typical closed meshes have ~n/2 distinct vertices
        let mut w = Welder::new(n / 2 + 8);
        let mut out = Vec::with_capacity(n);
        let mut dropped = 0;
        for t in tris {
            let t = &t;
            if t.iter().any(|v| !v.is_finite()) { return Err(FdmError::Parse("non-finite vertex coordinate in mesh".into())); }
            let a = w.add([t[0], t[1], t[2]]);
            let b = w.add([t[3], t[4], t[5]]);
            let c = w.add([t[6], t[7], t[8]]);
            if a == b || b == c || a == c { dropped += 1; } else { out.push([a, b, c]); }
        }
        if out.is_empty() { return Err(FdmError::Parse("mesh has no usable triangles".into())); }
        Ok(Mesh { verts: w.verts, tris: out, tris_in_file: n, tris_dropped_degenerate: dropped })
    }

    /// Parse an STL file image. Binary is recognised by its exact size (`84 + 50*n`) — "solid" at the
    /// start does not make a file ASCII (many binary exporters write it). Anything else is ASCII.
    pub fn from_stl(bytes: &[u8]) -> Result<Mesh, FdmError> {
        if bytes.len() >= 84 {
            let n = u32::from_le_bytes([bytes[80], bytes[81], bytes[82], bytes[83]]) as usize;
            if bytes.len() == 84 + 50 * n {
                return Mesh::from_soup_iter(n, (0..n).map(|i| {
                    let o = 84 + i * 50 + 12;
                    let mut t = [0.0f64; 9];
                    for k in 0..9 {
                        let b = &bytes[o + k * 4..o + k * 4 + 4];
                        t[k] = f32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64;
                    }
                    t
                }));
            }
            // size mismatch on a file that is not text -> truncated/corrupt binary
            let head = &bytes[..bytes.len().min(512)];
            let texty = head.iter().all(|&b| b == b'\n' || b == b'\r' || b == b'\t' || (32..127).contains(&b));
            if !texty {
                return Err(FdmError::Parse(format!("binary STL size mismatch: header says {n} triangles ({} bytes), file is {} bytes", 84 + 50 * n, bytes.len())));
            }
        }
        Mesh::from_ascii_stl(&String::from_utf8_lossy(bytes))
    }

    fn from_ascii_stl(text: &str) -> Result<Mesh, FdmError> {
        let mut tris = Vec::new();
        let mut cur: Vec<f64> = Vec::with_capacity(9);
        let mut saw_facet = false;
        for (ln, line) in text.lines().enumerate() {
            let mut it = line.split_whitespace();
            match it.next() {
                Some(w) if w.eq_ignore_ascii_case("facet") => { saw_facet = true; cur.clear(); }
                Some(w) if w.eq_ignore_ascii_case("vertex") => {
                    for _ in 0..3 {
                        let s = it.next().ok_or_else(|| FdmError::Parse(format!("STL line {}: vertex with fewer than 3 coordinates", ln + 1)))?;
                        cur.push(s.parse::<f64>().map_err(|_| FdmError::Parse(format!("STL line {}: bad number '{s}'", ln + 1)))? as f32 as f64);
                    }
                }
                Some(w) if w.eq_ignore_ascii_case("endfacet") => {
                    if cur.len() != 9 { return Err(FdmError::Parse(format!("STL line {}: facet has {} vertex coordinates, expected 9", ln + 1, cur.len()))); }
                    let mut t = [0.0; 9]; t.copy_from_slice(&cur); tris.push(t); cur.clear();
                }
                _ => {}
            }
        }
        if !saw_facet || tris.is_empty() { return Err(FdmError::Parse("no facets found (not an STL?)".into())); }
        Mesh::from_soup(&tris)
    }

    pub fn from_stl_file(path: &std::path::Path) -> Result<Mesh, FdmError> {
        let b = std::fs::read(path).map_err(|e| FdmError::Parse(format!("{}: {e}", path.display())))?;
        Mesh::from_stl(&b)
    }

    /// `(min, max)` corners.
    pub fn bbox(&self) -> ([f64; 3], [f64; 3]) {
        let mut mn = [f64::INFINITY; 3];
        let mut mx = [f64::NEG_INFINITY; 3];
        for v in &self.verts { for a in 0..3 { mn[a] = mn[a].min(v[a]); mx[a] = mx[a].max(v[a]); } }
        (mn, mx)
    }
    pub fn translate(&mut self, d: [f64; 3]) { for v in &mut self.verts { for a in 0..3 { v[a] += d[a]; } } }

    /// Put the object on the bed: bbox centre of XY onto `(cx, cy)`, lowest Z onto 0. Returns the translation.
    pub fn place_on_bed(&mut self, cx: f64, cy: f64) -> [f64; 3] {
        let (mn, mx) = self.bbox();
        let d = [cx - (mn[0] + mx[0]) / 2.0, cy - (mn[1] + mx[1]) / 2.0, -mn[2]];
        self.translate(d);
        d
    }

    /// Edge statistics, volume, bbox. Reported, never repaired.
    pub fn validate(&self) -> MeshReport {
        // Directed edges as sortable u64 keys (a << 32 | b). A sort + run-length count replaces the old
        // HashMap<(u32,u32),u32> + sorted key list: same per-edge counts, same classification, no hashing.
        let mut dir: Vec<u64> = Vec::with_capacity(self.tris.len() * 3);
        let mut zero = 0;
        let mut vol = 0.0;
        for t in &self.tris {
            for k in 0..3 { dir.push(((t[k] as u64) << 32) | t[(k + 1) % 3] as u64); }
            let (a, b, c) = (self.verts[t[0] as usize], self.verts[t[1] as usize], self.verts[t[2] as usize]);
            let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
            if n[0] * n[0] + n[1] * n[1] + n[2] * n[2] < 1e-18 { zero += 1; }
            vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.0;
        }
        dir.sort_unstable();
        // (key, count) runs, ascending
        let mut runs: Vec<(u64, u32)> = Vec::new();
        for &k in &dir { match runs.last_mut() { Some(l) if l.0 == k => l.1 += 1, _ => runs.push((k, 1)) } }
        let count_of = |a: u32, b: u32| -> u32 {
            let key = ((a as u64) << 32) | b as u64;
            runs.binary_search_by_key(&key, |r| r.0).map_or(0, |i| runs[i].1)
        };
        let (mut open, mut nonman, mut flipped) = (0, 0, 0);
        for &(key, f) in &runs {
            let (a, b) = ((key >> 32) as u32, key as u32);
            // visit each undirected edge once: from its (min,max) direction when that exists, else from the lone reverse
            if a > b && count_of(b, a) > 0 { continue; }
            let r = count_of(b, a);
            match (f, r) {
                (1, 1) => {}
                (1, 0) | (0, 1) => open += 1,
                (2, 0) | (0, 2) => flipped += 1,
                _ => nonman += 1,
            }
        }
        let (mn, mx) = self.bbox();
        MeshReport { vertices: self.verts.len(), triangles: self.tris.len(), tris_dropped_degenerate: self.tris_dropped_degenerate, zero_area_tris: zero,
            open_edges: open, nonmanifold_edges: nonman, flipped_edges: flipped, volume: vol, bbox_min: mn, bbox_max: mx }
    }

    /// Vertices of triangle `i`.
    pub fn tri(&self, i: usize) -> [[f64; 3]; 3] {
        let t = self.tris[i];
        [self.verts[t[0] as usize], self.verts[t[1] as usize], self.verts[t[2] as usize]]
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    /// Axis-aligned box [0,x]x[0,y]x[0,z] as a soup of 12 outward-facing triangles.
    pub fn box_soup(x: f64, y: f64, z: f64) -> Vec<[f64; 9]> {
        let c = [[0., 0., 0.], [x, 0., 0.], [x, y, 0.], [0., y, 0.], [0., 0., z], [x, 0., z], [x, y, z], [0., y, z]];
        let quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
        let mut t = vec![];
        for q in quads {
            for tri in [[q[0], q[1], q[2]], [q[0], q[2], q[3]]] {
                let mut a = [0.0; 9];
                for (k, &i) in tri.iter().enumerate() { a[k * 3..k * 3 + 3].copy_from_slice(&c[i]); }
                t.push(a);
            }
        }
        t
    }
    pub fn to_binary_stl(tris: &[[f64; 9]]) -> Vec<u8> {
        let mut b = vec![0u8; 80];
        b.extend((tris.len() as u32).to_le_bytes());
        for t in tris { b.extend([0u8; 12]); for v in t { b.extend((*v as f32).to_le_bytes()); } b.extend([0u8; 2]); }
        b
    }
    pub fn to_ascii_stl(tris: &[[f64; 9]]) -> String {
        let mut s = String::from("solid t\n");
        for t in tris { s += "facet normal 0 0 0\n outer loop\n"; for k in 0..3 { s += &format!("  vertex {} {} {}\n", t[k * 3], t[k * 3 + 1], t[k * 3 + 2]); } s += " endloop\nendfacet\n"; }
        s + "endsolid t\n"
    }
    #[test] fn binary_and_ascii_agree() {
        let soup = box_soup(10.0, 20.0, 30.0);
        let a = Mesh::from_stl(&to_binary_stl(&soup)).unwrap();
        let b = Mesh::from_stl(to_ascii_stl(&soup).as_bytes()).unwrap();
        assert_eq!(a.verts.len(), 8); assert_eq!(a.tris.len(), 12);
        assert_eq!(a.verts, b.verts); assert_eq!(a.tris, b.tris);
        let r = a.validate();
        assert!(r.is_watertight() && (r.volume - 6000.0).abs() < 1e-9 && r.zero_area_tris == 0, "{r:?}");
    }
    #[test] fn binary_with_solid_header_is_binary() {
        let mut b = to_binary_stl(&box_soup(1.0, 1.0, 1.0));
        b[..5].copy_from_slice(b"solid");
        assert_eq!(Mesh::from_stl(&b).unwrap().tris.len(), 12);
    }
    #[test] fn truncated_binary_is_error() {
        let mut b = to_binary_stl(&box_soup(1.0, 1.0, 1.0));
        b.truncate(b.len() - 7);
        assert!(Mesh::from_stl(&b).is_err());
        assert!(Mesh::from_stl(b"hello").is_err());
        assert!(Mesh::from_stl(b"solid x\nfacet normal 0 0 0\nouter loop\nvertex 1 2\nendloop\nendfacet\n").is_err());
    }
    #[test] fn open_and_flipped_reported() {
        let mut soup = box_soup(1.0, 1.0, 1.0);
        soup.pop();
        let r = Mesh::from_soup(&soup).unwrap().validate();
        assert!(r.open_edges > 0 && !r.is_watertight(), "{r:?}");
        let mut soup = box_soup(1.0, 1.0, 1.0);
        let t = soup[0]; soup[0] = [t[3], t[4], t[5], t[0], t[1], t[2], t[6], t[7], t[8]]; // flip one
        let r = Mesh::from_soup(&soup).unwrap().validate();
        assert!(r.flipped_edges > 0 || r.open_edges > 0, "{r:?}");
        // duplicate triangle -> non-manifold edges
        let mut soup = box_soup(1.0, 1.0, 1.0); soup.push(soup[0]);
        let r = Mesh::from_soup(&soup).unwrap().validate();
        assert!(r.nonmanifold_edges > 0, "{r:?}");
    }
    /// The pre-optimisation validate() edge classification (HashMap of directed edges), kept as an oracle.
    fn ref_edges(m: &Mesh) -> (usize, usize, usize) {
        let mut dir: HashMap<(u32, u32), u32> = HashMap::new();
        for t in &m.tris { for k in 0..3 { *dir.entry((t[k], t[(k + 1) % 3])).or_insert(0) += 1; } }
        let (mut open, mut nonman, mut flipped) = (0, 0, 0);
        let mut seen: HashMap<(u32, u32), ()> = HashMap::new();
        let mut keys: Vec<_> = dir.keys().copied().collect();
        keys.sort();
        for &(a, b) in &keys {
            if seen.insert((a.min(b), a.max(b)), ()).is_some() { continue; }
            let f = dir.get(&(a, b)).copied().unwrap_or(0);
            let r = dir.get(&(b, a)).copied().unwrap_or(0);
            match (f, r) { (1, 1) => {}, (1, 0) | (0, 1) => open += 1, (2, 0) | (0, 2) => flipped += 1, _ => nonman += 1 }
        }
        (open, nonman, flipped)
    }
    #[test] fn validate_matches_reference_implementation() {
        let mut meshes = vec![];
        meshes.push(Mesh::from_soup(&box_soup(1.0, 2.0, 3.0)).unwrap());
        for drop in 0..12 { let mut s = box_soup(1.0, 1.0, 1.0); s.remove(drop); meshes.push(Mesh::from_soup(&s).unwrap()); }
        for flip in 0..12 { let mut s = box_soup(1.0, 1.0, 1.0); let t = s[flip]; s[flip] = [t[3], t[4], t[5], t[0], t[1], t[2], t[6], t[7], t[8]]; meshes.push(Mesh::from_soup(&s).unwrap()); }
        for dup in 0..12 { let mut s = box_soup(1.0, 1.0, 1.0); s.push(s[dup]); meshes.push(Mesh::from_soup(&s).unwrap()); }
        { let mut s = box_soup(1.0, 1.0, 1.0); s.push(s[0]); s.push(s[0]); s.push(s[0]); meshes.push(Mesh::from_soup(&s).unwrap()); } // 4x same edge
        // pseudo-random triangle soup over a small vertex pool: every edge multiplicity and orientation shows up
        let mut x: u64 = 88172645463325252;
        let mut rnd = move |n: u64| { x ^= x << 13; x ^= x >> 7; x ^= x << 17; x % n };
        for _ in 0..20 {
            let pool: Vec<[f64; 3]> = (0..9).map(|i| [i as f64, (i * i % 7) as f64, (i % 3) as f64]).collect();
            let soup: Vec<[f64; 9]> = (0..40).map(|_| { let (a, b, c) = (pool[rnd(9) as usize], pool[rnd(9) as usize], pool[rnd(9) as usize]); [a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]] }).collect();
            if let Ok(m) = Mesh::from_soup(&soup) { meshes.push(m); }
        }
        let (mut watertight, mut not) = (0, 0);
        for m in &meshes {
            let r = m.validate();
            assert_eq!((r.open_edges, r.nonmanifold_edges, r.flipped_edges), ref_edges(m));
            if r.is_watertight() { watertight += 1 } else { not += 1 }
        }
        assert!(watertight >= 1 && not >= 30, "oracle population must contain both kinds ({watertight}/{not})");
    }
    #[test] fn degenerates_counted_not_hidden() {
        let mut soup = box_soup(1.0, 1.0, 1.0);
        soup.push([0., 0., 0., 0., 0., 0., 1., 1., 1.]);
        let m = Mesh::from_soup(&soup).unwrap();
        assert_eq!(m.tris_dropped_degenerate, 1); assert_eq!(m.tris_in_file, 13);
        assert!(Mesh::from_soup(&[[f64::NAN; 9]]).is_err());
    }
    #[test] fn weld_noise() {
        let mut soup = box_soup(1.0, 1.0, 1.0);
        soup[3][0] += 4e-7; // within weld cell
        assert_eq!(Mesh::from_soup(&soup).unwrap().verts.len(), 8);
    }
    #[test] fn placement() {
        let mut m = Mesh::from_soup(&box_soup(10.0, 20.0, 30.0)).unwrap();
        m.translate([5.0, -7.0, 3.0]);
        let d = m.place_on_bed(128.0, 128.0);
        let (mn, mx) = m.bbox();
        assert!((mn[2]).abs() < 1e-12 && ((mn[0] + mx[0]) / 2.0 - 128.0).abs() < 1e-12 && ((mn[1] + mx[1]) / 2.0 - 128.0).abs() < 1e-12);
        assert!((d[2] + 3.0).abs() < 1e-12);
    }
}
