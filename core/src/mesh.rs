//! STL intake — a mesh enters as a **SECTION**, and says so.
//!
//! # The rule this module is built around
//!
//! 🔴 **An STL is a 3D triangle mesh. This engine is 2.5D profile/pocket CAM for
//! a 3-axis router.** There is exactly one honest thing to do with a mesh here:
//! intersect it with a horizontal plane and cut the closed contours that fall
//! out. That is a **section**, not surfacing.
//!
//! The failure this module exists to prevent is not a crash. It is an operator
//! importing a 3D part, expecting the shape they modelled, and receiving a flat
//! slice through it — which posts, simulates, gates green and cuts a
//! **plausible-looking wrong part**. Nothing downstream can notice, because
//! every contour it was handed is a real contour of a real solid. So the word
//! *section* and the Z it was taken at are stated in the note that reaches the
//! screen, on every single import, alongside the unit assumption.
//!
//! Three refusals, in the same spirit as the DXF path:
//!
//! 1. **A chain that does not close is NAMED**, with its endpoints. An open
//!    chain means the mesh has a hole or a non-manifold edge at that Z; closing
//!    it invents a wall the model never had, and dropping it cuts a part with a
//!    side missing.
//! 2. **A plane that crosses nothing gives a REASON**, never an empty success.
//!    "Zero contours" and "your Z is above the part" look identical to a caller
//!    and only the second is actionable.
//! 3. **A face lying exactly in the plane is REPORTED, not sliced.** A face in
//!    the plane has an area, not a boundary; feeding its three edges into the
//!    chainer manufactures a loop that is not an outline of anything.
//!
//! # 3D surfacing does not exist here, and this is not a step towards it
//!
//! No Z-level roughing, no waterline, no scallop, no ball-nose stepover. This
//! module hands the existing 2.5D operations one flat outline. If a part needs
//! surfacing, this tool must refuse it — and it does, by only ever offering a
//! section and naming it as one.

use crate::geometry::{Contour, Vertex};
use crate::import::{chain, Imported, Piece};

/// One triangle: three corners, each `[x, y, z]` in the STL's own numbers.
/// Millimetres by assumption — see [`section`], which says so out loud.
pub type Tri = [[f64; 3]; 3];

/// A parsed STL, plus everything about the file that could not be turned into a
/// triangle. `problems` is carried through to the caller for the same reason
/// `Imported::unsupported` exists: a facet silently discarded at parse time is a
/// feature silently missing from the cut.
#[derive(Clone, Debug, Default)]
pub struct Mesh {
    pub tris: Vec<Tri>,
    pub problems: Vec<String>,
}

impl Mesh {
    /// The Z range the mesh actually occupies. `None` for an empty mesh.
    ///
    /// Reported whenever a section finds nothing, because "z = 5 is above this
    /// part" is a fixable statement and "no contours" is not.
    pub fn z_span(&self) -> Option<(f64, f64)> {
        let mut lo = f64::INFINITY;
        let mut hi = f64::NEG_INFINITY;
        for t in &self.tris {
            for v in t {
                lo = lo.min(v[2]);
                hi = hi.max(v[2]);
            }
        }
        if lo.is_finite() && hi.is_finite() {
            Some((lo, hi))
        } else {
            None
        }
    }

    /// At most `budget` triangles, for **DISPLAY ONLY**.
    ///
    /// 🔴 **What this costs, stated before it is used anywhere.** When the mesh
    /// is over budget this keeps every `k`-th triangle and DROPS the rest. The
    /// result is not a simplified model of the same solid — it is a **DIFFERENT
    /// SOLID**, with holes exactly where the dropped facets were. It has no
    /// closed surface, its bounds may be smaller than the real part's, and
    /// sectioning it would produce an outline the operator never modelled.
    ///
    /// So it may be **drawn** and nothing else. It must never be sectioned,
    /// measured, offset, used to decide a Z, or shown as evidence of what will
    /// be cut. Everything the engine actually cuts is computed from the FULL
    /// mesh in [`section`], which never sees this function.
    ///
    /// An STL is a triangle SOUP — no shared vertices, no edges, no topology —
    /// so there is nothing here to collapse an edge against. A real decimation
    /// (quadric error, edge collapse) needs a connected model to work on, and
    /// inventing that connectivity from float equality is its own class of
    /// silent defect. Dropping whole triangles is the one reduction that cannot
    /// move a vertex that survives: every triangle in the result is a triangle
    /// of the original, at its original coordinates.
    ///
    /// ⚠ `budget` is a count of triangles and is clamped UP to 1, never treated
    /// as "no limit". A zero that means "everything" is the sentinel that ships
    /// the expensive case by accident; deciding whether a mesh is wanted at all
    /// belongs to the caller, and [`crate::fixtures::plan_report_import_bytes_with_surface_and_mesh`]
    /// makes that decision explicit by taking an `Option`.
    pub fn display_sample(&self, budget: usize) -> Vec<&Tri> {
        let budget = budget.max(1);
        if self.tris.len() <= budget {
            return self.tris.iter().collect();
        }
        let k = self.tris.len().div_ceil(budget).max(1);
        self.tris.iter().step_by(k).collect()
    }
}

/// Triangle count if — and only if — `data` is a binary STL.
///
/// 🔴 **The trap this function exists for: a binary STL may begin with the
/// bytes `solid`.** The 80-byte header is free-form and plenty of exporters
/// write a name into it, so sniffing the first five characters classifies a
/// binary file as ASCII. The ASCII parser then finds no `facet` lines, returns
/// an empty mesh, and the import reports "nothing to cut" for a perfectly good
/// part — or worse, some other parser is handed 3 MB of float soup.
///
/// So the test is arithmetic, not textual: a binary STL is exactly
/// `80 (header) + 4 (count) + 50 * count` bytes long. Nothing else has to be
/// trusted about the file.
///
/// ⚠ Residual, stated rather than hidden: an ASCII STL whose byte length
/// happens to satisfy that equation for the u32 sitting at offset 80 would be
/// misread. That u32 is four bytes of ASCII text, so it is enormous
/// (≥ 0x20202020 for spaces) and the product overflows any real file length —
/// which is why the equation, not a range check, is the discriminator.
pub fn binary_triangle_count(data: &[u8]) -> Option<usize> {
    if data.len() < 84 {
        return None;
    }
    let n = u32::from_le_bytes([data[80], data[81], data[82], data[83]]) as usize;
    if n == 0 {
        return None;
    }
    let want = 84usize.checked_add(n.checked_mul(50)?)?;
    if want == data.len() {
        Some(n)
    } else {
        None
    }
}

/// Does this look like an ASCII STL? Content only — the extension is a claim by
/// whoever named the file, and a wrong claim here silently changes what gets cut.
fn looks_like_ascii_stl(text: &str) -> bool {
    // Compared as BYTES, not by slicing the &str: `&head[..5]` panics when byte
    // 5 lands inside a multi-byte character, and a parser that panics on an odd
    // file has refused nothing — it has taken the worker down with it.
    let head = text.trim_start().as_bytes();
    if head.len() < 5 || !head[..5].eq_ignore_ascii_case(b"solid") {
        return false;
    }
    // Bounded scan: the keyword appears on the second line of any real ASCII
    // STL. Lowercasing the whole file to answer a yes/no question about its
    // first few lines is a needless copy of an arbitrarily large buffer.
    text.lines()
        .take(64)
        .any(|l| l.trim_start().to_ascii_lowercase().starts_with("facet normal"))
}

/// Is this an STL at all, by content?
pub fn looks_like_stl(data: &[u8]) -> bool {
    if binary_triangle_count(data).is_some() {
        return true;
    }
    std::str::from_utf8(data).map(looks_like_ascii_stl).unwrap_or(false)
}

/// Detect an OBJ file by looking for `v ` vertex lines.
///
/// OBJ is a text format with no magic number. A file that contains at least
/// one `v x y z` line and at least one `f ...` line is likely an OBJ.
/// This is a heuristic — a DXF or SVG that happens to contain these patterns
/// would false-positive, but the content-based dispatch runs STL first, then
/// this, then DXF/SVG, so collisions are unlikely in practice.
pub fn looks_like_obj(text: &str) -> bool {
    let mut has_v = false;
    let mut has_f = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("v ") {
            has_v = true;
        } else if trimmed.starts_with("f ") {
            has_f = true;
        }
        if has_v && has_f {
            return true;
        }
    }
    false
}

/// Parse an OBJ file into a `Mesh` of triangles.
///
/// Handles `v x y z` vertices and `f v1 v2 v3 ...` faces. Face indices are
/// 1-indexed and may be `v`, `v/vt`, `v/vt/vn`, or `v//vn` — only the vertex
/// index is used. Polygon faces (4+ vertices) are fan-triangulated.
///
/// Normals (`vn`), texture coordinates (`vt`), groups (`g`), objects (`o`),
/// materials (`mtllib`/`usemtl`), and lines (`l`) are silently skipped —
/// they are irrelevant for sectioning.
pub fn parse_obj(text: &str) -> Mesh {
    let mut mesh = Mesh::default();
    let mut verts: Vec<[f64; 3]> = Vec::new();

    for (lineno, line) in text.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let Some(tag) = parts.next() else { continue };

        match tag {
            "v" => {
                let coords: Vec<Option<f64>> = parts.take(3).map(|s| s.parse().ok()).collect();
                if let [Some(x), Some(y), Some(z)] = coords.as_slice() {
                    verts.push([*x, *y, *z]);
                } else {
                    mesh.problems.push(format!(
                        "OBJ line {}: vertex with fewer than 3 coordinates — skipped",
                        lineno + 1
                    ));
                }
            }
            "f" => {
                let face_indices: Vec<usize> = parts
                    .filter_map(|tok| {
                        // Face format: v, v/vt, v/vt/vn, or v//vn
                        // Take only the first number (vertex index).
                        let v_str = tok.split('/').next()?;
                        let idx: i64 = v_str.parse().ok()?;
                        // 1-indexed; negative = relative to current vertex count
                        let abs = if idx > 0 {
                            idx as usize
                        } else {
                            (verts.len() as i64 + idx) as usize
                        };
                        if abs >= 1 && abs <= verts.len() {
                            Some(abs - 1) // 0-indexed
                        } else {
                            None
                        }
                    })
                    .collect();

                if face_indices.len() < 3 {
                    mesh.problems.push(format!(
                        "OBJ line {}: face with fewer than 3 valid vertices — skipped",
                        lineno + 1
                    ));
                    continue;
                }

                // Fan triangulation: v0-v1-v2, v0-v2-v3, v0-v3-v4, ...
                for i in 1..face_indices.len() - 1 {
                    let a = verts[face_indices[0]];
                    let b = verts[face_indices[i]];
                    let c = verts[face_indices[i + 1]];
                    mesh.tris.push([a, b, c]);
                }
            }
            // Everything else (vn, vt, o, g, s, mtllib, usemtl, l, p) is silently skipped.
            _ => {}
        }
    }

    mesh
}

/// Parse an OBJ file and section it at `z_mm`.
pub fn parse_obj_section(text: &str, z_mm: f64, tol: f64) -> Imported {
    let mesh = parse_obj(text);
    if mesh.tris.is_empty() {
        let mut out = Imported::default();
        out.unit_note = format!(
            "OBJ SECTION at z = {z_mm:.3}mm — one flat slice through a 3D mesh, NOT 3D surfacing"
        );
        out.unsupported
            .push("the OBJ file contains no valid faces — there is nothing to section".into());
        out.unsupported.extend(mesh.problems.iter().cloned());
        return out;
    }
    let mut result = section(&mesh, z_mm, tol);
    // Override the unit note to say OBJ instead of STL
    result.unit_note = format!(
        "OBJ SECTION at z = {z_mm:.3}mm — one flat slice through a 3D mesh, NOT 3D surfacing. \
         OBJ carries no units — millimetres ASSUMED, not read"
    );
    result
}

/// Detect a 3MF file by its ZIP magic bytes (`PK\x03\x04`).
pub fn looks_like_3mf(data: &[u8]) -> bool {
    data.len() >= 4 && data[0] == 0x50 && data[1] == 0x4B && data[2] == 0x03 && data[3] == 0x04
}

/// Parse a 3MF file into a `Mesh` of triangles.
///
/// 3MF is a ZIP archive containing XML. The main model is typically at
/// `3D/3dmodel.model`. The XML has `<vertices>` with `<vertex x y z />`
/// and `<triangles>` with `<triangle v1 v2 v3 />` (0-indexed).
///
/// Units are declared in the XML (`unit` attribute on `<model>`), but we
/// report millimetres assumed — same policy as STL and OBJ.
pub fn parse_3mf(data: &[u8]) -> Mesh {
    let mut mesh = Mesh::default();

    let archive = match zip::ZipArchive::new(std::io::Cursor::new(data)) {
        Ok(a) => a,
        Err(e) => {
            mesh.problems.push(format!("3MF: cannot open ZIP archive: {e} — NOT imported"));
            return mesh;
        }
    };

    // Find the 3D model file. Common paths: 3D/3dmodel.model, 3D/model.model
    // or any .model file under 3D/.
    let mut archive = archive;
    let model_path = {
        let mut found: Option<String> = None;
        for name in archive.file_names() {
            let lower = name.to_lowercase();
            if lower == "3d/3dmodel.model" {
                found = Some(name.to_string());
                break;
            }
            if found.is_none() && lower.starts_with("3d/") && lower.ends_with(".model") {
                found = Some(name.to_string());
            }
        }
        found
    };

    let Some(path) = model_path else {
        mesh.problems.push(
            "3MF: no 3D model file found (expected 3D/3dmodel.model) — NOT imported".into(),
        );
        return mesh;
    };

    let xml = match archive.by_name(&path) {
        Ok(mut file) => {
            let mut buf = String::new();
            if let Err(e) = std::io::Read::read_to_string(&mut file, &mut buf) {
                mesh.problems.push(format!("3MF: cannot read {path}: {e} — NOT imported"));
                return mesh;
            }
            buf
        }
        Err(e) => {
            mesh.problems.push(format!("3MF: cannot open {path}: {e} — NOT imported"));
            return mesh;
        }
    };

    // Simple XML parsing — no dependency needed. The 3MF schema is predictable:
    // <vertices><vertex x="..." y="..." z="..." /></vertices>
    // <triangles><triangle v1="..." v2="..." v3="..." /></triangles>
    let mut verts: Vec<[f64; 3]> = Vec::new();
    for line in xml.lines() {
        let trimmed = line.trim();
        if trimmed.contains("<vertex") {
            let x = extract_xml_attr(trimmed, "x").unwrap_or(0.0);
            let y = extract_xml_attr(trimmed, "y").unwrap_or(0.0);
            let z = extract_xml_attr(trimmed, "z").unwrap_or(0.0);
            verts.push([x, y, z]);
        } else if trimmed.contains("<triangle") {
            let v1 = extract_xml_attr(trimmed, "v1").unwrap_or(0.0) as usize;
            let v2 = extract_xml_attr(trimmed, "v2").unwrap_or(0.0) as usize;
            let v3 = extract_xml_attr(trimmed, "v3").unwrap_or(0.0) as usize;
            if v1 < verts.len() && v2 < verts.len() && v3 < verts.len() {
                mesh.tris.push([verts[v1], verts[v2], verts[v3]]);
            } else {
                mesh.problems.push(format!(
                    "3MF: triangle references vertex out of range (v1={v1}, v2={v2}, v3={v3}, {} verts) — skipped",
                    verts.len()
                ));
            }
        }
    }

    if mesh.tris.is_empty() && mesh.problems.is_empty() {
        mesh.problems.push(
            "3MF: model file contains no triangles — there is nothing to section".into(),
        );
    }

    mesh
}

/// Parse a 3MF file and section it at `z_mm`.
pub fn parse_3mf_section(data: &[u8], z_mm: f64, tol: f64) -> Imported {
    let mesh = parse_3mf(data);
    if mesh.tris.is_empty() {
        let mut out = Imported::default();
        out.unit_note = format!(
            "3MF SECTION at z = {z_mm:.3}mm — one flat slice through a 3D mesh, NOT 3D surfacing"
        );
        out.unsupported.extend(mesh.problems.iter().cloned());
        return out;
    }
    let mut result = section(&mesh, z_mm, tol);
    result.unit_note = format!(
        "3MF SECTION at z = {z_mm:.3}mm — one flat slice through a 3D mesh, NOT 3D surfacing. \
         3MF units may be declared in the file — millimetres ASSUMED"
    );
    result
}

/// Extract a floating-point XML attribute value from a tag string.
///
/// Looks for `name="value"` or `name='value'` and parses the value as f64.
fn extract_xml_attr(tag: &str, name: &str) -> Option<f64> {
    // Try double quotes first, then single quotes
    for quote in ['"', '\''] {
        let pattern = format!("{name}={quote}");
        if let Some(start) = tag.find(&pattern) {
            let val_start = start + pattern.len();
            if let Some(end) = tag[val_start..].find(quote) {
                return tag[val_start..val_start + end].parse().ok();
            }
        }
    }
    None
}

/// Detect a STEP file by its ISO-10303-21 header.
///
/// 🔴 THIS EXISTS SO THAT STEP CAN BE **NAMED AND REFUSED**, never so that it can
/// be read. Without it a `.step` file falls through to the DXF reader, which
/// finds no entities it recognises and returns an empty import — and an empty
/// import is indistinguishable from a valid empty drawing. Naming the format is
/// what turns a silent nothing into a refusal the operator can act on.
pub fn looks_like_step(text: &str) -> bool {
    text.contains("ISO-10303-21") || text.contains("FILE_SCHEMA")
}

/// The one sentence every host says when a STEP file arrives. **One message,
/// three doors** — `import::parse_bytes` (the browser), `fixtures.rs` (the gate
/// harness) and the CLI all refuse with this exact text, because a format
/// accepted at one host and refused at another reads as a regression to
/// everyone who meets it (gate `HOST`'s whole subject).
pub const STEP_REFUSAL: &str = "STEP (ISO-10303-21) is a B-rep solid format and this tool does NOT read it — the file was NOT imported, and nothing has been sectioned or cut from it. It is REFUSED rather than approximated. Export the part as STL, OBJ or 3MF from the CAD system that owns it: those are triangle meshes, and sectioning a mesh by intersecting it with one horizontal plane is the whole of what this tool claims to do.";

/// Refuse a STEP file, by name, with zero geometry.
///
/// # Why this replaced a working reader (2026-08-28)
///
/// There WAS a STEP reader here — about 1,000 lines of hand-rolled entity
/// parsing, and it produced contours that looked entirely plausible. It was
/// removed rather than fixed, and the reason is this module's own opening rule:
/// **the failure to prevent is not a crash, it is a plausible-looking wrong
/// part.** The reader manufactured exactly that, three ways at once:
///
/// 1. **Vertical walls were dropped in silence.** Only planar faces whose
///    surface Z was within 0.1 mm of the section Z contributed; every other
///    planar face hit a bare `continue` with no counter and no message. On a
///    prismatic part — the ordinary case — the section at a mid-height Z **is**
///    the set of vertical walls crossing that plane, and those were precisely
///    the faces thrown away. What came back was "the flat faces that happen to
///    lie at this Z", which is not a section of anything.
/// 2. **Every cylindrical face emitted a FULL circle at the section plane**,
///    regardless of whether the cylinder reached that Z, which way its axis
///    pointed, or how far round it actually went. A horizontal hole, a fillet
///    and a counterbore that stops above the plane all came back as a complete
///    circle in the cut.
/// 3. **The two hosts did not even agree.** The browser went through the
///    B-rep contour extractor; the CLI tessellated planar faces only and
///    sectioned the triangles. Same file, two different parts, and no gate
///    drove STEP on either path.
///
/// Nothing downstream could notice any of it: every contour handed on was a
/// real contour, so it posted, simulated, gated green and would have cut. A
/// reader that is wrong in this direction is worse than no reader, so there is
/// now no reader. If STEP is wanted, it needs a real B-rep kernel and a gate
/// that drives it against one — not a thousand lines of string matching.
pub fn refuse_step() -> Imported {
    let mut out = Imported::default();
    out.unit_note =
        "STEP file REFUSED — nothing was imported, so there is no section and no section Z".into();
    out.unsupported.push(STEP_REFUSAL.into());
    out
}

/// Read a binary STL: 80-byte header, `u32` triangle count, then 50 bytes per
/// triangle (12 little-endian `f32` — a normal we ignore and three corners —
/// plus a 2-byte attribute word).
///
/// The stored normal is deliberately discarded. It is redundant with the winding
/// and is wrong in a great many files in the wild; trusting it would make the
/// section depend on a field no exporter is obliged to get right.
pub fn parse_binary_stl(data: &[u8]) -> Mesh {
    let mut mesh = Mesh::default();
    let Some(n) = binary_triangle_count(data) else {
        mesh.problems
            .push("binary STL: the declared triangle count does not match the file length — NOT imported".into());
        return mesh;
    };
    mesh.tris.reserve(n);
    let f32_at = |o: usize| -> f64 {
        f32::from_le_bytes([data[o], data[o + 1], data[o + 2], data[o + 3]]) as f64
    };
    for i in 0..n {
        let base = 84 + i * 50 + 12; // skip the normal
        let mut t: Tri = [[0.0; 3]; 3];
        for (c, corner) in t.iter_mut().enumerate() {
            for (k, slot) in corner.iter_mut().enumerate() {
                *slot = f32_at(base + c * 12 + k * 4);
            }
        }
        mesh.tris.push(t);
    }
    mesh
}

/// Read an ASCII STL. Keywords are matched case-insensitively; a facet that does
/// not carry exactly three vertices is reported by its index rather than
/// quietly skipped.
pub fn parse_ascii_stl(text: &str) -> Mesh {
    let mut mesh = Mesh::default();
    let mut loop_verts: Vec<[f64; 3]> = Vec::new();
    let mut in_loop = false;
    let mut facet_index = 0usize;

    for raw in text.lines() {
        let line = raw.trim();
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("facet") {
            facet_index += 1;
        } else if lower.starts_with("outer loop") {
            in_loop = true;
            loop_verts.clear();
        } else if lower.starts_with("vertex") {
            let nums: Vec<f64> = line
                .split_whitespace()
                .skip(1)
                .filter_map(|s| s.parse::<f64>().ok())
                .collect();
            if nums.len() == 3 {
                loop_verts.push([nums[0], nums[1], nums[2]]);
            } else {
                mesh.problems.push(format!(
                    "ASCII STL facet {facet_index}: a vertex line carried {} numbers, not 3 — the facet was NOT imported",
                    nums.len()
                ));
                in_loop = false;
            }
        } else if lower.starts_with("endloop") {
            if in_loop {
                if loop_verts.len() == 3 {
                    mesh.tris.push([loop_verts[0], loop_verts[1], loop_verts[2]]);
                } else {
                    // 🔴 Not a skip. A 4-sided "facet" is a quad some exporter
                    // wrote into a triangle format; guessing a triangulation
                    // invents an edge, and dropping it leaves a hole that shows
                    // up later as an unclosed section chain with no explanation.
                    mesh.problems.push(format!(
                        "ASCII STL facet {facet_index}: {} vertices, not 3 — NOT imported",
                        loop_verts.len()
                    ));
                }
            }
            in_loop = false;
            loop_verts.clear();
        }
    }
    mesh
}

/// Parse an STL, choosing the reader by CONTENT.
///
/// Returns `None` when the bytes are not an STL at all — the caller decides what
/// that means, rather than this module inventing an empty mesh that reads
/// downstream as "a valid part with no geometry".
pub fn parse_stl(data: &[u8]) -> Option<Mesh> {
    if binary_triangle_count(data).is_some() {
        return Some(parse_binary_stl(data));
    }
    let text = std::str::from_utf8(data).ok()?;
    if looks_like_ascii_stl(text) {
        return Some(parse_ascii_stl(text));
    }
    None
}

/// Distance from `q` to the infinite line through `p` and `r`.
fn perp_distance(q: (f64, f64), p: (f64, f64), r: (f64, f64)) -> f64 {
    let (dx, dy) = (r.0 - p.0, r.1 - p.1);
    let len = (dx * dx + dy * dy).sqrt();
    if len < 1e-12 {
        return ((q.0 - p.0).powi(2) + (q.1 - p.1).powi(2)).sqrt();
    }
    ((q.0 - p.0) * dy - (q.1 - p.1) * dx).abs() / len
}

/// Drop vertices that lie on the straight line between their neighbours.
///
/// 🔴 The physical failure this guards is gate **G10, block rate**. A flat wall
/// in a mesh is two triangles, so a sectioned box wall arrives as two collinear
/// segments; a finely tessellated model arrives as hundreds. Feeding those to
/// the post emits one `G1` per tessellation artefact, which starves the planner
/// and stutters the finish on a surface that is geometrically a single straight
/// cut.
///
/// ⚠ What is given up, stated plainly: a vertex is removed only when its
/// perpendicular deviation is within `tol` — the **same** tolerance the caller
/// already accepted for deciding two endpoints are the same point. A section
/// vertex is an artefact of tessellation, not a design intent, so nothing the
/// drawing asserted is being approximated away. Arcs are never touched (a mesh
/// section has none, and if one ever appears it is left exactly alone).
fn drop_collinear(c: &mut Contour, tol: f64) {
    if !c.closed || c.verts.len() < 4 || c.verts.iter().any(|v| v.bulge != 0.0) {
        return;
    }
    let mut i = 0usize;
    while c.verts.len() > 3 && i < c.verts.len() {
        let n = c.verts.len();
        let p = c.verts[(i + n - 1) % n];
        let q = c.verts[i];
        let r = c.verts[(i + 1) % n];
        if perp_distance((q.x, q.y), (p.x, p.y), (r.x, r.y)) <= tol {
            c.verts.remove(i);
        } else {
            i += 1;
        }
    }
}

/// How close to the plane a vertex must be to count as ON it.
///
/// Deliberately near-exact rather than `tol`: a `tol`-wide band (0.01–0.02 mm in
/// practice) would snap every crossing within that band onto the plane and move
/// the section, which is the approximation this lane refuses to make. Its only
/// job is to keep an exactly-modelled coplanar face from being read as a
/// crossing.
const ON_PLANE_MM: f64 = 1e-9;

/// Add a crossing point unless the triangle already produced the same one.
///
/// A vertex sitting on the plane is found twice — once as a vertex, once as the
/// end of an edge — and a duplicate would turn a two-point crossing into a
/// three-point one, which reads as a degenerate mesh that is not degenerate.
fn push_unique(pts: &mut Vec<(f64, f64)>, p: (f64, f64), tol: f64) {
    if !pts.iter().any(|q| (q.0 - p.0).abs() <= tol && (q.1 - p.1).abs() <= tol) {
        pts.push(p);
    }
}

/// Section a mesh at `z_mm` and return contours the existing 2.5D operations can
/// cut.
///
/// The returned `unit_note` **names the section and its Z**, because that note is
/// the one string that always reaches the screen (`fixtures.rs` pushes it into
/// every report). An operator who imported a 3D part must be told that what they
/// are looking at is one slice through it — before the spindle turns, not after
/// they measure the part.
pub fn section(mesh: &Mesh, z_mm: f64, tol: f64) -> Imported {
    let mut out = Imported::default();
    // 🔴 Two facts in one always-visible line, and neither may be dropped:
    // - SECTION: a flat slice of a 3D mesh, not the 3D shape and not surfacing.
    // - UNITS: an STL file format carries no unit declaration at all. Same
    //   failure as a DXF with no $INSUNITS — an inch model imports 25.4x small
    //   with a perfectly plausible outline, and only a ruler on the finished
    //   part disagrees. The assumption is made because there is nothing else to
    //   do; it is REPORTED every time.
    out.unit_note = format!(
        "STL SECTION at z = {z_mm:.3}mm — one flat slice through a 3D mesh, NOT 3D surfacing. \
         STL carries no units — millimetres ASSUMED, not read"
    );
    out.unsupported.extend(mesh.problems.iter().cloned());

    if mesh.tris.is_empty() {
        out.unsupported
            .push("the STL contains no triangles — there is nothing to section".into());
        return out;
    }

    let mut pieces: Vec<Piece> = Vec::new();
    let mut coplanar = 0usize;
    let mut grazed = 0usize;
    let mut slivers = 0usize;
    let mut ambiguous = 0usize;

    for t in &mesh.tris {
        let d = [t[0][2] - z_mm, t[1][2] - z_mm, t[2][2] - z_mm];
        let on = |k: usize| d[k].abs() <= ON_PLANE_MM;

        if on(0) && on(1) && on(2) {
            // A face lying IN the plane has an area, not a boundary. Its three
            // edges would chain into a loop that outlines a triangle of the
            // tessellation rather than any feature of the part.
            coplanar += 1;
            continue;
        }
        if d.iter().all(|v| *v > ON_PLANE_MM) || d.iter().all(|v| *v < -ON_PLANE_MM) {
            continue;
        }

        let mut pts: Vec<(f64, f64)> = Vec::with_capacity(3);
        for k in 0..3 {
            if on(k) {
                push_unique(&mut pts, (t[k][0], t[k][1]), tol);
            }
        }
        for (a, b) in [(0usize, 1usize), (1, 2), (2, 0)] {
            if d[a].abs() <= ON_PLANE_MM || d[b].abs() <= ON_PLANE_MM {
                continue;
            }
            if (d[a] > 0.0) == (d[b] > 0.0) {
                continue;
            }
            let f = d[a] / (d[a] - d[b]);
            push_unique(
                &mut pts,
                (
                    t[a][0] + f * (t[b][0] - t[a][0]),
                    t[a][1] + f * (t[b][1] - t[a][1]),
                ),
                tol,
            );
        }

        match pts.len() {
            2 => {
                let len = ((pts[1].0 - pts[0].0).powi(2) + (pts[1].1 - pts[0].1).powi(2)).sqrt();
                if len <= tol {
                    // Shorter than the tolerance the chainer uses to decide two
                    // points are the same point, so it cannot be chained at all.
                    slivers += 1;
                    continue;
                }
                pieces.push(Piece {
                    verts: vec![
                        Vertex::line(pts[0].0, pts[0].1),
                        Vertex::line(pts[1].0, pts[1].1),
                    ],
                    closed: false,
                });
            }
            0 | 1 => grazed += 1,
            _ => ambiguous += 1,
        }
    }

    if coplanar > 0 {
        out.unsupported.push(format!(
            "{coplanar} triangle face(s) lie exactly in the section plane at z = {z_mm:.3}mm — a face in the plane \
             has an area, not an outline, and was NOT imported; move the section Z off the face"
        ));
    }
    if grazed > 0 {
        out.unsupported.push(format!(
            "{grazed} triangle(s) only touch the plane at z = {z_mm:.3}mm at a point or an edge and contribute no \
             cuttable boundary — a feature that starts or ends exactly at this Z will be MISSING from the section"
        ));
    }
    if slivers > 0 {
        out.unsupported.push(format!(
            "{slivers} section segment(s) came out shorter than the {tol}mm chaining tolerance and could NOT be \
             chained — a feature smaller than that tolerance is not in the imported outline"
        ));
    }
    if ambiguous > 0 {
        out.unsupported.push(format!(
            "{ambiguous} triangle(s) produced more than two crossing points at z = {z_mm:.3}mm, which a plane \
             section cannot do for a valid triangle — those triangles were NOT imported; the mesh is degenerate there"
        ));
    }

    if pieces.is_empty() {
        // 🔴 Requirement, not politeness: an empty success here is
        // indistinguishable from "this part has no geometry at all", and the
        // operator has no way to discover that their Z simply missed the solid.
        let span = match mesh.z_span() {
            Some((lo, hi)) => format!("the mesh spans z = {lo:.3}..{hi:.3}mm"),
            None => "the mesh has no extent".to_string(),
        };
        out.unsupported.push(format!(
            "the section at z = {z_mm:.3}mm crossed no geometry; {span}"
        ));
        return out;
    }

    let (chained, open) = chain(pieces, tol);
    out.open_contours = open;
    for mut c in chained {
        if c.closed {
            drop_collinear(&mut c, tol);
            out.contours.push(c);
        } else {
            // 🔴 Named, with its ends, exactly as an unreadable DXF entity is.
            // An open chain is a hole or a non-manifold edge in the mesh at this
            // Z. Closing it invents a wall the model never had; dropping it cuts
            // a part with a side missing and nothing downstream can tell.
            let a = c.verts[0];
            let b = c.verts[c.verts.len() - 1];
            out.unsupported.push(format!(
                "an open section chain of {} point(s) from ({:.3}, {:.3}) to ({:.3}, {:.3}) at z = {z_mm:.3}mm did \
                 NOT close — the mesh has a hole or a non-manifold edge there; it was NOT imported as a cuttable loop",
                c.verts.len(),
                a.x,
                a.y,
                b.x,
                b.y
            ));
            out.contours.push(c);
        }
    }

    out
}

/// Parse and section in one step — the entry point [`crate::import`] dispatches
/// a `.stl` (of either flavour) into.
pub fn parse_stl_section(data: &[u8], z_mm: f64, tol: f64) -> Imported {
    match parse_stl(data) {
        Some(mesh) => section(&mesh, z_mm, tol),
        None => {
            let mut out = Imported::default();
            out.unit_note = format!(
                "STL SECTION at z = {z_mm:.3}mm — one flat slice through a 3D mesh, NOT 3D surfacing"
            );
            out.unsupported.push(
                "the file is not a readable STL — it is neither a binary STL of its own declared triangle count \
                 nor an ASCII STL with facets; NOT imported"
                    .into(),
            );
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An axis-aligned box from (0,0,0) to (sx,sy,sz), 12 triangles, closed.
    fn box_tris(sx: f64, sy: f64, sz: f64) -> Vec<Tri> {
        let c = |i: usize| -> [f64; 3] {
            [
                if i & 1 == 0 { 0.0 } else { sx },
                if i & 2 == 0 { 0.0 } else { sy },
                if i & 4 == 0 { 0.0 } else { sz },
            ]
        };
        // Six quads as corner-index pairs of triangles.
        let quads: [[usize; 4]; 6] = [
            [0, 1, 3, 2], // z = 0
            [4, 6, 7, 5], // z = sz
            [0, 2, 6, 4], // x = 0
            [1, 5, 7, 3], // x = sx
            [0, 4, 5, 1], // y = 0
            [2, 3, 7, 6], // y = sy
        ];
        let mut out = Vec::new();
        for q in quads {
            out.push([c(q[0]), c(q[1]), c(q[2])]);
            out.push([c(q[0]), c(q[2]), c(q[3])]);
        }
        out
    }

    fn ascii_stl(tris: &[Tri]) -> String {
        let mut s = String::from("solid test\n");
        for t in tris {
            s.push_str("  facet normal 0 0 0\n    outer loop\n");
            for v in t {
                s.push_str(&format!("      vertex {} {} {}\n", v[0], v[1], v[2]));
            }
            s.push_str("    endloop\n  endfacet\n");
        }
        s.push_str("endsolid test\n");
        s
    }

    fn binary_stl(tris: &[Tri], header: &str) -> Vec<u8> {
        let mut out = vec![0u8; 80];
        let h = header.as_bytes();
        let n = h.len().min(80);
        out[..n].copy_from_slice(&h[..n]);
        out.extend_from_slice(&(tris.len() as u32).to_le_bytes());
        for t in tris {
            for _ in 0..3 {
                out.extend_from_slice(&0f32.to_le_bytes()); // normal, ignored
            }
            for v in t {
                for k in 0..3 {
                    out.extend_from_slice(&(v[k] as f32).to_le_bytes());
                }
            }
            out.extend_from_slice(&0u16.to_le_bytes()); // attribute word
        }
        out
    }

    #[test]
    fn a_binary_stl_parses_every_triangle() {
        let tris = box_tris(10.0, 20.0, 30.0);
        let bytes = binary_stl(&tris, "exported by nothing in particular");
        assert_eq!(binary_triangle_count(&bytes), Some(12));
        let m = parse_stl(&bytes).expect("binary STL was not recognised");
        assert!(m.problems.is_empty(), "{:?}", m.problems);
        assert_eq!(m.tris.len(), 12);
        let (lo, hi) = m.z_span().unwrap();
        assert!((lo - 0.0).abs() < 1e-6 && (hi - 30.0).abs() < 1e-6, "span {lo}..{hi}");
    }

    #[test]
    fn an_ascii_stl_parses_every_triangle() {
        let tris = box_tris(10.0, 20.0, 30.0);
        let m = parse_stl(ascii_stl(&tris).as_bytes()).expect("ASCII STL was not recognised");
        assert!(m.problems.is_empty(), "{:?}", m.problems);
        assert_eq!(m.tris.len(), 12);
    }

    #[test]
    fn a_binary_stl_whose_header_begins_with_solid_is_still_read_as_binary() {
        // 🔴 The trap. The 80-byte header is free-form and plenty of exporters
        // write a name into it that starts with "solid". Sniffing the first five
        // characters classifies a binary file as ASCII, the ASCII reader finds
        // no facets, and a perfectly good part imports as "nothing to cut".
        let tris = box_tris(10.0, 10.0, 10.0);
        let bytes = binary_stl(&tris, "solid COMPONENT-A exported 2026-08-08");
        assert!(
            bytes.starts_with(b"solid"),
            "the fixture does not reproduce the trap it is testing"
        );
        assert_eq!(binary_triangle_count(&bytes), Some(12), "length arithmetic did not fire");
        let m = parse_stl(&bytes).expect("STL not recognised at all");
        assert_eq!(m.tris.len(), 12, "the binary body was read as ASCII text");
    }

    #[test]
    fn a_cube_sectioned_mid_height_gives_one_four_sided_loop() {
        // Each wall of the box is TWO triangles, so the raw section is 8
        // collinear segments. What must come out is the square the operator
        // would recognise — and only 4 blocks, per gate G10.
        let m = Mesh { tris: box_tris(40.0, 25.0, 18.0), problems: Vec::new() };
        let r = section(&m, 9.0, 0.01);
        assert!(r.unsupported.is_empty(), "{:?}", r.unsupported);
        assert_eq!(r.open_contours, 0, "the section did not close");
        let closed: Vec<&Contour> = r.contours.iter().filter(|c| c.closed).collect();
        assert_eq!(closed.len(), 1, "expected one loop, got {}", closed.len());
        assert_eq!(
            closed[0].verts.len(),
            4,
            "expected a 4-sided loop, got {:?}",
            closed[0].verts
        );
        let (x0, y0, x1, y1) = closed[0].bounds().unwrap();
        assert!((x0).abs() < 1e-9 && (x1 - 40.0).abs() < 1e-9, "x {x0}..{x1}");
        assert!((y0).abs() < 1e-9 && (y1 - 25.0).abs() < 1e-9, "y {y0}..{y1}");
    }

    #[test]
    fn a_curved_wall_is_not_flattened_by_the_collinear_pass() {
        // 🔴 The risk the collinear pass introduces: it is a simplification, and
        // a simplification that ate a curve would cut a facetted hole as a
        // straight-sided one. A 32-sided cylinder deviates 0.38mm per vertex —
        // far outside the 0.01mm tolerance — so every side must survive.
        let (r, n, h) = (20.0_f64, 32usize, 10.0_f64);
        let p = |k: usize, z: f64| -> [f64; 3] {
            let a = std::f64::consts::TAU * (k % n) as f64 / n as f64;
            [r * a.cos(), r * a.sin(), z]
        };
        let mut tris: Vec<Tri> = Vec::new();
        for k in 0..n {
            tris.push([p(k, 0.0), p(k + 1, 0.0), p(k + 1, h)]);
            tris.push([p(k, 0.0), p(k + 1, h), p(k, h)]);
        }
        let m = Mesh { tris, problems: Vec::new() };
        let s = section(&m, 5.0, 0.01);
        let closed: Vec<&Contour> = s.contours.iter().filter(|c| c.closed).collect();
        assert_eq!(closed.len(), 1, "{:?}", s.unsupported);
        assert_eq!(
            closed[0].verts.len(),
            n,
            "the collinear pass ate a curve: {} sides left of {n}",
            closed[0].verts.len()
        );
    }

    #[test]
    fn the_note_names_the_section_and_the_z_it_was_taken_at() {
        // 🔴 The one thing that stops a 3D part being cut flat and plausible.
        // This note is the string `fixtures.rs` pushes into every report, so it
        // is what the operator actually sees.
        let m = Mesh { tris: box_tris(10.0, 10.0, 10.0), problems: Vec::new() };
        let r = section(&m, 5.0, 0.01);
        let note = r.unit_note.to_ascii_lowercase();
        assert!(note.contains("section"), "the note does not say section: {}", r.unit_note);
        assert!(r.unit_note.contains("5.000"), "the note does not give the Z: {}", r.unit_note);
        // Same refusal the DXF path makes for a missing $INSUNITS.
        assert!(
            r.unit_note.contains("ASSUMED"),
            "the unit assumption was silent: {}",
            r.unit_note
        );
    }

    #[test]
    fn a_section_above_the_mesh_explains_itself_instead_of_returning_empty_success() {
        // 🔴 "Zero contours" and "your Z missed the part" are indistinguishable
        // to a caller, and only the second one can be acted on.
        let mut tris = box_tris(10.0, 10.0, 28.0);
        for t in &mut tris {
            for v in t.iter_mut() {
                v[2] += 12.0; // the solid now spans z = 12..40
            }
        }
        let m = Mesh { tris, problems: Vec::new() };
        let r = section(&m, 5.0, 0.01);
        assert!(r.contours.is_empty());
        let why = r.unsupported.join(" | ");
        assert!(why.contains("crossed no geometry"), "{why}");
        assert!(why.contains("12.000") && why.contains("40.000"), "the span was not reported: {why}");
    }

    #[test]
    fn an_open_edge_is_named_not_dropped() {
        // 🔴 A wall missing from the mesh becomes a wall missing from the cut,
        // and the outline still LOOKS like a part. Remove one side of the box
        // and the section can no longer close.
        let mut tris = box_tris(40.0, 25.0, 18.0);
        tris.retain(|t| !t.iter().all(|v| v[0] == 0.0)); // drop the x = 0 face
        let m = Mesh { tris, problems: Vec::new() };
        let r = section(&m, 9.0, 0.01);
        assert_eq!(r.open_contours, 1, "an open chain was reported as closed");
        let named = r.unsupported.join(" | ");
        assert!(named.contains("did NOT close"), "the open chain was not named: {named}");
        assert!(named.contains("open section chain"), "{named}");
        assert!(
            r.contours.iter().all(|c| !c.closed),
            "an unclosed chain was passed off as a cuttable loop"
        );
    }

    #[test]
    fn a_face_lying_in_the_section_plane_is_reported_not_sliced() {
        // The plane is put exactly on the top face. Those two triangles have an
        // area in the plane, not a boundary — chaining their edges would produce
        // an outline of the tessellation, not of the part.
        let m = Mesh { tris: box_tris(10.0, 10.0, 6.0), problems: Vec::new() };
        let r = section(&m, 6.0, 0.01);
        let why = r.unsupported.join(" | ");
        assert!(why.contains("lie exactly in the section plane"), "{why}");
        assert!(why.contains("NOT imported"), "{why}");
    }

    #[test]
    fn a_facet_that_is_not_a_triangle_is_reported_by_index() {
        let stl = "solid s\n facet normal 0 0 0\n  outer loop\n   vertex 0 0 0\n   vertex 1 0 0\n  endloop\n endfacet\nendsolid s\n";
        let m = parse_stl(stl.as_bytes()).expect("not recognised as ASCII STL");
        assert!(m.tris.is_empty());
        assert_eq!(m.problems.len(), 1, "{:?}", m.problems);
        assert!(m.problems[0].contains("facet 1"), "{:?}", m.problems);
        assert!(m.problems[0].contains("NOT imported"), "{:?}", m.problems);
    }

    #[test]
    fn an_odd_file_is_refused_rather_than_panicked_on() {
        // A parser that panics has refused nothing — it has taken the worker
        // down with it, and the browser reports no reason at all. Multi-byte
        // leading characters, a 4-byte file, and empty input all had to be
        // survivable before this could be called a refusal.
        for probe in [
            "日本語のファイルです".as_bytes(),
            b"sol",
            b"",
            &[0xff, 0xfe, 0x00, 0x01],
        ] {
            assert!(!looks_like_stl(probe), "{probe:?} was mistaken for an STL");
            let r = parse_stl_section(probe, 5.0, 0.01);
            assert!(!r.unsupported.is_empty(), "a bad file was accepted silently");
        }
    }

    #[test]
    fn a_file_that_is_not_an_stl_is_refused_by_name() {
        let r = parse_stl_section(b"0\nSECTION\n2\nENTITIES\n0\nEOF\n", 5.0, 0.01);
        assert!(r.contours.is_empty());
        assert!(
            r.unsupported.iter().any(|u| u.contains("not a readable STL")),
            "{:?}",
            r.unsupported
        );
    }

    #[test]
    fn obj_box_sections_at_mid_height() {
        // An OBJ box from (0,0,0) to (10,10,10), sectioned at z=5.
        let obj = "\
# test box
v 0 0 0
v 10 0 0
v 10 10 0
v 0 10 0
v 0 0 10
v 10 0 10
v 10 10 10
v 0 10 10
f 1 2 3 4
f 5 7 6 8
f 1 2 6 5
f 2 3 7 6
f 3 4 8 7
f 4 1 5 8
";
        let mesh = parse_obj(obj);
        assert!(mesh.tris.len() == 12, "box should have 12 triangles, got {}", mesh.tris.len());
        let r = section(&mesh, 5.0, 0.01);
        assert!(r.unsupported.is_empty(), "{:?}", r.unsupported);
        assert!(!r.contours.is_empty(), "section at z=5 should find contours");
        // The section should be a 10x10 square
        let closed: Vec<_> = r.contours.iter().filter(|c| c.closed).collect();
        assert_eq!(closed.len(), 1, "should have exactly one closed contour");
        let (x0, y0, x1, y1) = closed[0].bounds().unwrap();
        assert!((x0).abs() < 0.1 && (x1 - 10.0).abs() < 0.1, "x {x0}..{x1}");
        assert!((y0).abs() < 0.1 && (y1 - 10.0).abs() < 0.1, "y {y0}..{y1}");
    }

    #[test]
    fn obj_with_slash_face_format() {
        // OBJ faces can be v/vt/vn, v//vn, or v — all should work.
        let obj = "\
v 0 0 0
v 10 0 0
v 10 10 0
v 0 0 10
v 10 0 10
v 10 10 10
f 1/1/1 2/2/1 3/3/1
f 4//1 5//1 6//1
";
        let mesh = parse_obj(obj);
        assert_eq!(mesh.tris.len(), 2, "should have 2 triangles, got {}", mesh.tris.len());
    }

    #[test]
    fn obj_empty_file_produces_reason() {
        let mesh = parse_obj("# empty\n");
        assert!(mesh.tris.is_empty());
        let r = parse_obj_section("# empty\n", 5.0, 0.01);
        assert!(
            r.unsupported.iter().any(|u| u.contains("no valid faces")),
            "{:?}",
            r.unsupported
        );
    }

    #[test]
    fn obj_negative_indices() {
        // OBJ supports negative indices (relative to current vertex count).
        let obj = "\
v 0 0 0
v 10 0 0
v 10 10 0
v 0 0 10
v 10 0 10
v 10 10 10
f -3 -2 -1
f -3 -2 -1
";
        let mesh = parse_obj(obj);
        assert_eq!(mesh.tris.len(), 2, "negative indices should resolve, got {}", mesh.tris.len());
    }

    /// Create a minimal 3MF ZIP archive in memory with the given vertices and triangles.
    #[cfg(test)]
    fn make_3mf(verts: &[[f64; 3]], tris: &[[usize; 3]]) -> Vec<u8> {
        use std::io::Write;
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            zip.start_file("[Content_Types].xml", options).unwrap();
            zip.write_all(b"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\
                <Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
                <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
                <Default Extension=\"model\" ContentType=\"application/vnd.ms-package.3dmanufacturing-3dmodel+xml\"/>\
                </Types>").unwrap();
            zip.start_file("3D/3dmodel.model", options).unwrap();
            let mut xml = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
                <model unit=\"millimeter\" xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\">\n\
                <resources><object id=\"1\"><mesh><vertices>\n");
            for v in verts {
                xml.push_str(&format!("  <vertex x=\"{}\" y=\"{}\" z=\"{}\"/>\n", v[0], v[1], v[2]));
            }
            xml.push_str("</vertices><triangles>\n");
            for t in tris {
                xml.push_str(&format!("  <triangle v1=\"{}\" v2=\"{}\" v3=\"{}\"/>\n", t[0], t[1], t[2]));
            }
            xml.push_str("</triangles></mesh></object></resources>\n\
                <build><item objectid=\"1\"/></build></model>");
            zip.write_all(xml.as_bytes()).unwrap();
            zip.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn threemf_box_sections_at_mid_height() {
        // A 10x10x10 box, same geometry as the OBJ test.
        let verts: Vec<[f64; 3]> = vec![
            [0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [10.0, 10.0, 0.0], [0.0, 10.0, 0.0],
            [0.0, 0.0, 10.0], [10.0, 0.0, 10.0], [10.0, 10.0, 10.0], [0.0, 10.0, 10.0],
        ];
        let tris: Vec<[usize; 3]> = vec![
            [0,1,2],[0,2,3], // z=0
            [4,6,5],[4,7,6], // z=10
            [0,4,5],[0,5,1], // y=0
            [1,5,6],[1,6,2], // x=10
            [2,6,7],[2,7,3], // y=10
            [3,7,4],[3,4,0], // x=0
        ];
        let data = make_3mf(&verts, &tris);
        assert!(looks_like_3mf(&data), "should detect 3MF by magic bytes");
        let r = parse_3mf_section(&data, 5.0, 0.01);
        assert!(r.unsupported.is_empty(), "{:?}", r.unsupported);
        assert!(!r.contours.is_empty(), "section at z=5 should find contours");
        let closed: Vec<_> = r.contours.iter().filter(|c| c.closed).collect();
        assert_eq!(closed.len(), 1, "should have exactly one closed contour");
        let (x0, y0, x1, y1) = closed[0].bounds().unwrap();
        assert!((x0).abs() < 0.1 && (x1 - 10.0).abs() < 0.1, "x {x0}..{x1}");
        assert!((y0).abs() < 0.1 && (y1 - 10.0).abs() < 0.1, "y {y0}..{y1}");
    }

    #[test]
    fn threemf_not_a_zip_is_reported() {
        let data = b"this is not a zip file";
        let r = parse_3mf_section(data, 5.0, 0.01);
        assert!(r.unsupported.iter().any(|u| u.contains("cannot open ZIP")), "{:?}", r.unsupported);
    }

    #[test]
    fn threemf_missing_model_file_is_reported() {
        use std::io::Write;
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("readme.txt", options).unwrap();
            zip.write_all(b"no model here").unwrap();
            zip.finish().unwrap();
        }
        let data = buf.into_inner();
        let r = parse_3mf_section(&data, 5.0, 0.01);
        assert!(r.unsupported.iter().any(|u| u.contains("no 3D model file")), "{:?}", r.unsupported);
    }

    #[test]
    fn step_file_is_detected() {
        let step = "\
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Test'), '2;1');
FILE_NAME('test.stp', '2026-01-01', (''), (''), '', '', '');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));
ENDSEC;
DATA;
#1 = CARTESIAN_POINT('', (0.0, 0.0, 0.0));
ENDSEC;
END-ISO-10303-21;
";
        assert!(looks_like_step(step), "should detect STEP by header");
        assert!(!looks_like_step("not a step file"), "should not false-positive");
    }

    #[test]
    fn a_step_file_is_refused_by_name_and_yields_no_geometry() {
        // 🔴 THE FILE THAT MATTERS IS THIS ONE, not an empty header. The reader
        // that was removed on 2026-08-28 returned "no geometry found" on trivial
        // input — which is what the two tests here used to assert — and returned
        // a plausible CONTOUR on input like this. A test that only ever fed it
        // files with no faces could not have caught that, and did not.
        let step = "\
ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Test'), '2;1');
FILE_NAME('test.stp', '2026-01-01', (''), (''), '', '', '');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));
ENDSEC;
DATA;
#1 = CARTESIAN_POINT('', (0.0, 0.0, 5.0));
#2 = CARTESIAN_POINT('', (10.0, 0.0, 5.0));
#3 = CARTESIAN_POINT('', (10.0, 10.0, 5.0));
#4 = CARTESIAN_POINT('', (0.0, 10.0, 5.0));
#5 = DIRECTION('', (0.0, 0.0, 1.0));
#6 = DIRECTION('', (1.0, 0.0, 0.0));
#7 = AXIS2_PLACEMENT_3D('', #1, #5, #6);
#8 = PLANE('', #7);
#9 = VERTEX_POINT('', #1);
#10 = VERTEX_POINT('', #2);
#11 = VERTEX_POINT('', #3);
#12 = VERTEX_POINT('', #4);
#13 = LINE('', #1, #6);
#14 = EDGE_CURVE('', #9, #10, #13, .T.);
#15 = EDGE_CURVE('', #10, #11, #13, .T.);
#16 = EDGE_CURVE('', #11, #12, #13, .T.);
#17 = EDGE_CURVE('', #12, #9, #13, .T.);
#18 = ORIENTED_EDGE('', *, *, #14, .T.);
#19 = ORIENTED_EDGE('', *, *, #15, .T.);
#20 = ORIENTED_EDGE('', *, *, #16, .T.);
#21 = ORIENTED_EDGE('', *, *, #17, .T.);
#22 = EDGE_LOOP('', (#18, #19, #20, #21));
#23 = FACE_OUTER_BOUND('', #22, .T.);
#24 = ADVANCED_FACE('', (#23), #8, .T.);
ENDSEC;
END-ISO-10303-21;
";
        assert!(looks_like_step(step));
        let r = refuse_step();
        assert!(
            r.contours.is_empty(),
            "a refusal must emit NO geometry, got {} contour(s)",
            r.contours.len()
        );
        assert!(
            r.unsupported.iter().any(|u| u.contains("does NOT read it")),
            "the refusal must NAME the format and say it was not imported: {:?}",
            r.unsupported
        );
        assert!(
            r.unit_note.contains("REFUSED"),
            "the note that reaches the screen must say refused, never describe a section: {:?}",
            r.unit_note
        );
    }

    #[test]
    fn every_host_gives_the_same_step_refusal() {
        // Gate HOST's subject, asserted in the core: a format accepted at one
        // host and refused at another reads as a regression to everyone who
        // meets it. All three doors read one constant, so they cannot drift.
        let step = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";
        let via_bytes = crate::import::parse_bytes(step.as_bytes(), 100.0, 5.0, 0.01);
        assert!(via_bytes.contours.is_empty());
        assert_eq!(via_bytes.unsupported, vec![STEP_REFUSAL.to_string()]);
        assert_eq!(via_bytes.unit_note, refuse_step().unit_note);
    }

    #[test]
    fn a_step_file_never_falls_through_to_the_dxf_reader() {
        // The reason `looks_like_step` survived the removal. Without it this
        // file reaches `parse_dxf`, which finds nothing it recognises and
        // returns an EMPTY import — indistinguishable from a valid empty
        // drawing, and silent.
        let step = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";
        let r = crate::import::parse_bytes(step.as_bytes(), 100.0, 0.0, 0.01);
        assert!(
            !r.unsupported.is_empty(),
            "an unread format must be NAMED; an empty import reads as an empty drawing"
        );
    }
}
