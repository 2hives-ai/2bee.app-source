//! `PrintObject::detect_surfaces_type`, `LayerRegion::slices_to_fill_surfaces_clipped`,
//! `LayerRegion::prepare_fill_surfaces`, `PrintObject::discover_vertical_shells`,
//! `PrintObject::discover_horizontal_shells` (single printing region).
use super::ops::*;
use super::{EnsureVertical, FlowRole, LayerGeom, Res, Surface, SurfaceCfg, SurfaceType as T};
use crate::types::{Poly, Polys};

pub struct State<'a> {
    pub layers: &'a [LayerGeom],
    pub cfg: &'a SurfaceCfg,
    pub n: usize,
    /// `LayerRegion::slices`: typed whole-layer region.
    pub slices: Vec<Vec<Surface>>,
    /// `LayerRegion::fill_surfaces`.
    pub fill: Vec<Vec<Surface>>,
}

pub fn polys_of(v: &[Surface], tys: &[T]) -> Polys {
    let p: Polys = v.iter().filter(|s| tys.contains(&s.ty)).map(|s| s.poly.clone()).collect();
    u(&p)
}

fn surfaces(ty: T, p: &Polys, angle: f64) -> Vec<Surface> {
    u(p).into_iter().map(|poly| Surface { ty, poly, bridge_angle: angle }).collect()
}

fn ring_count(p: &Polys) -> usize { p.iter().map(|q| 1 + q.holes.len()).sum() }

impl<'a> State<'a> {
    pub fn new(layers: &'a [LayerGeom], cfg: &'a SurfaceCfg) -> Res<State<'a>> {
        let n = layers.len();
        for (i, l) in layers.iter().enumerate() {
            if !(l.h > 0.0) { return super::unsupported(format!("layer {i}: thickness {} <= 0", l.h)); }
        }
        Ok(State { layers, cfg, n, slices: vec![vec![]; n], fill: vec![vec![]; n] })
    }
    pub fn flow(&self, role: FlowRole, i: usize) -> super::Flow { self.cfg.flow(role, i, self.layers[i].h) }
    pub fn print_z(&self, i: usize) -> f64 { self.layers[i].z }
    pub fn bottom_z(&self, i: usize) -> f64 { self.layers[i].z - self.layers[i].h }
    pub fn slice(&self, i: usize) -> &Polys { &self.layers[i].slice }

    // ---------------------------------------------------------------------------------------------
    pub fn detect_surfaces_type(&mut self) {
        let idxs: Vec<usize> = (0..self.n).collect();
        let this = &*self;
        let slices: Vec<Vec<Surface>> = super::pmap(&idxs, |_, &i| {
            let sl = u(this.slice(i));
            let ext = this.flow(FlowRole::ExternalPerimeter, i);
            let off_open = ext.width / 10.0;
            let mut top: Polys = if i + 1 < this.n { opening(&df_safe(&sl, this.slice(i + 1)), off_open) } else { sl.clone() };
            let mut bottom: Polys;
            let bty;
            if i > 0 {
                bottom = opening(&df_safe(&sl, this.slice(i - 1)), off_open);
                bty = T::BottomBridge;
            } else {
                bottom = sl.clone();
                bty = T::Bottom;
            }
            // A thin membrane can be both top and bottom: bottom wins (bridge detection), small cracks excepted.
            if !top.is_empty() && !bottom.is_empty() {
                let cracks = it(&top, &bottom);
                if !cracks.is_empty() {
                    if i > 0 {
                        let thr = ext.width * 1.5;
                        for crack in &cracks {
                            let cr = vec![crack.clone()];
                            if off(&cr, -thr).is_empty() {
                                let keep = bottom.iter().any(|se| {
                                    let se = vec![se.clone()];
                                    df_safe(&cr, &se).is_empty() && area(&se) > area(&cr) * 2.0 && !off(&df(&se, &cr), -thr).is_empty()
                                });
                                if keep { continue; }
                                bottom = df(&bottom, &off(&cr, thr));
                            }
                        }
                    }
                    top = df(&top, &bottom);
                }
            }
            let internal = df(&sl, &un(&top, &bottom));
            let mut v = surfaces(T::Internal, &internal, -1.0);
            v.extend(surfaces(T::Top, &top, -1.0));
            v.extend(surfaces(bty, &bottom, -1.0));
            v
        });
        self.slices = slices;
        // slices_to_fill_surfaces_clipped
        let this = &*self;
        let fills: Vec<Vec<Surface>> = super::pmap(&idxs, |_, &i| {
            let fill = u(&this.layers[i].fill);
            let mut out = Vec::new();
            for s in &this.slices[i] {
                for p in it(&vec![s.poly.clone()], &fill) { out.push(Surface { ty: s.ty, poly: p, bridge_angle: s.bridge_angle }); }
            }
            out
        });
        self.fill = fills;
    }

    // ---------------------------------------------------------------------------------------------
    pub fn prepare_fill_surfaces(&mut self) {
        let cfg = self.cfg;
        for i in 0..self.n {
            for s in &mut self.fill[i] {
                if cfg.top_shell_layers == 0 && s.ty.is_top() { s.ty = T::Internal; }
                if cfg.bottom_shell_layers == 0 && s.ty.is_bottom() { s.ty = T::Internal; }
                if (cfg.sparse_density - 1.0).abs() < 1e-9 && s.ty == T::Internal { s.ty = T::InternalSolid; }
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    pub fn discover_vertical_shells(&mut self) {
        if self.cfg.ensure_vertical != EnsureVertical::All { return; }
        let n = self.n;
        struct Cache { top: Polys, bottom: Polys, holes: Polys }
        let idxs: Vec<usize> = (0..n).collect();
        let this = &*self;
        let cache: Vec<Cache> = super::pmap(&idxs, |_, &i| {
            let exp = this.flow(FlowRole::SolidInfill, i).spacing * 0.05;
            Cache {
                top: off(&polys_of(&this.slices[i], &[T::Top]), exp),
                bottom: off(&polys_of(&this.slices[i], &[T::Bottom, T::BottomBridge]), exp),
                holes: u(&this.layers[i].fill),
            }
        });
        let cfg = self.cfg;
        const E: f64 = 1e-4;
        // layer `idx` reads and replaces only its own fill surfaces (everything else it reads is the immutable cache,
        // the slices and the layer geometry), so the layers are independent
        let this = &*self;
        let new_fill: Vec<Option<Vec<Surface>>> = super::pmap(&idxs, |_, &idx| {
            let self_ = this;
            let solid_sp = self_.flow(FlowRole::SolidInfill, idx).spacing;
            let min_pis = solid_sp * 1.05;
            let mut shell: Polys = vec![];
            let mut holes: Polys = cache[idx].holes.clone();
            let combine_holes = |holes: &mut Polys, h2: &Polys| {
                if holes.is_empty() || h2.is_empty() { holes.clear(); } else { *holes = it(holes, h2); }
            };
            let combine_shells = |shell: &mut Polys, s2: &Polys| {
                if shell.is_empty() { *shell = s2.clone(); } else if !s2.is_empty() { *shell = un(shell, s2); }
            };
            if cfg.top_shell_layers > 0 {
                let print_z = self_.print_z(idx);
                let mut i = idx + 1;
                let itop = idx + cfg.top_shell_layers;
                let mut at_least_one = false;
                while i < n && (i < itop || self_.print_z(i) - print_z < cfg.top_shell_thickness - E) {
                    at_least_one = true;
                    combine_holes(&mut holes, &cache[i].holes);
                    combine_shells(&mut shell, &cache[i].top);
                    i += 1;
                }
                if !at_least_one && i < n {
                    let anchor = it(&expand(&cache[idx].top, self_.flow(FlowRole::ExternalPerimeter, idx).spacing), self_.slice(i));
                    combine_shells(&mut shell, &anchor);
                }
            }
            if cfg.bottom_shell_layers > 0 {
                let bottom_z = self_.bottom_z(idx);
                let mut i = idx as isize - 1;
                let ibottom = idx as isize - cfg.bottom_shell_layers as isize;
                let mut at_least_one = false;
                while i >= 0 && (i > ibottom || bottom_z - self_.bottom_z(i as usize) < cfg.bottom_shell_thickness - E) {
                    at_least_one = true;
                    combine_holes(&mut holes, &cache[i as usize].holes);
                    combine_shells(&mut shell, &cache[i as usize].bottom);
                    i -= 1;
                }
                if !at_least_one && i >= 0 {
                    let anchor = it(&expand(&cache[idx].bottom, self_.flow(FlowRole::ExternalPerimeter, idx).spacing), self_.slice(i as usize));
                    combine_shells(&mut shell, &anchor);
                }
            }
            // Trim the shells region by the internal surfaces.
            let internal = polys_of(&self_.fill[idx], &[T::Internal, T::InternalSolid]);
            let mut sh = it(&off(&shell, 1e-5), &internal);
            sh = un(&sh, &df(&internal, &holes));
            if sh.is_empty() { return None; }
            sh = un(&sh, &polys_of(&self_.fill[idx], &[T::InternalSolid]));

            let r_ens = 0.5 * 0.65 * min_pis;
            let r_sparse = 0.5 * 1.2 * min_pis;
            let r_tiny = 0.2 * min_pis;
            let mut regularized = off(&off2(&u(&sh), -r_ens, r_ens + r_sparse), -(r_sparse - r_tiny));
            let object_volume = if idx > 0 && idx + 1 < n { it(self_.slice(idx - 1), self_.slice(idx + 1)) } else { vec![] };
            let internal_volume = closing(&internal, EPS);
            let iv_count = ring_count(&internal_volume);
            regularized.retain(|p| {
                let pp = vec![p.clone()];
                let a = poly_area(p);
                let small = a < min_pis * 1.5 || (a < min_pis * 8.0 && df(&pp, &object_volume).is_empty());
                let covers_nothing = ring_count(&df(&internal_volume, &expand(&pp, min_pis))) >= iv_count;
                !(small && covers_nothing)
            });
            if regularized.is_empty() { return None; }
            let new_solid = it(&internal, &regularized);
            let new_internal = df(&polys_of(&self_.fill[idx], &[T::Internal]), &regularized);
            let mut out: Vec<Surface> = self_.fill[idx].iter().filter(|s| matches!(s.ty, T::Top | T::Bottom | T::BottomBridge)).cloned().collect();
            out.extend(surfaces(T::Internal, &new_internal, -1.0));
            out.extend(surfaces(T::InternalSolid, &new_solid, -1.0));
            Some(out)
        });
        for (idx, nf) in new_fill.into_iter().enumerate() { if let Some(f) = nf { self.fill[idx] = f; } }
    }

    // ---------------------------------------------------------------------------------------------
    pub fn discover_horizontal_shells(&mut self) {
        let cfg = self.cfg;
        let n = self.n;
        const E: f64 = 1e-4;
        for i in 0..n {
            if !cfg.extra_solid_infills.trim().is_empty() {
                // validated as unsupported in `check`
            }
            if cfg.ensure_vertical == EnsureVertical::All { continue; }
            let print_z = self.print_z(i);
            let bottom_z = self.bottom_z(i);
            for ty in [T::Top, T::Bottom, T::BottomBridge] {
                let num_solid = if ty == T::Top { cfg.top_shell_layers } else { cfg.bottom_shell_layers };
                if num_solid == 0 { continue; }
                let mut solid: Polys = un(&polys_of(&self.slices[i], &[ty]), &polys_of(&self.fill[i], &[ty]));
                if solid.is_empty() { continue; }
                let mut nn: isize = if ty == T::Top { i as isize - 1 } else { i as isize + 1 };
                loop {
                    let cont = if ty == T::Top {
                        nn >= 0 && ((i as isize - nn) < num_solid as isize || print_z - self.print_z(nn as usize) < cfg.top_shell_thickness - E)
                    } else {
                        (nn as usize) < n && nn >= 0 && ((nn - i as isize) < num_solid as isize || self.bottom_z(nn as usize) - bottom_z < cfg.bottom_shell_thickness - E)
                    };
                    if !cont { break; }
                    let nl = nn as usize;
                    nn += if ty == T::Top { -1 } else { 1 };
                    let internal = polys_of(&self.fill[nl], &[T::Internal, T::InternalSolid]);
                    let mut nis = it(&off(&solid, 1e-5), &internal);
                    if nis.is_empty() {
                        if cfg.sparse_density == 0.0 || cfg.ensure_vertical != EnsureVertical::All { break; } else { continue; }
                    }
                    let factor = if cfg.sparse_density == 0.0 { 1.0 } else if cfg.ensure_vertical == EnsureVertical::None { 0.5 }
                        else if cfg.ensure_vertical == EnsureVertical::CriticalOnly { 0.2 } else { 0.0 };
                    if factor > 0.0 {
                        let margin = self.flow(FlowRole::ExternalPerimeter, nl).width * factor;
                        let too_narrow = df(&nis, &off2(&nis, -margin, margin + 1e-5));
                        if !too_narrow.is_empty() { nis = df(&nis, &too_narrow); solid = nis.clone(); }
                    }
                    {
                        let margin = (if cfg.ensure_vertical != EnsureVertical::None { 3.0 } else { 1.0 }) * self.flow(FlowRole::SolidInfill, i).width;
                        let too_narrow = df(&nis, &off2(&nis, -margin, margin + 1e-5));
                        if !too_narrow.is_empty() {
                            let internal2 = polys_of(&self.fill[nl], &[T::Internal, T::InternalSolid]);
                            nis = un(&nis, &it(&expand(&too_narrow, margin), &internal2));
                        }
                    }
                    let backup = std::mem::take(&mut self.fill[nl]);
                    let old_solid = polys_of(&backup, &[T::InternalSolid]);
                    let internal_solid = un(&nis, &old_solid);
                    let new_internal = df(&polys_of(&backup, &[T::Internal]), &internal_solid);
                    let mut out = surfaces(T::InternalSolid, &internal_solid, -1.0);
                    out.extend(surfaces(T::Internal, &new_internal, -1.0));
                    let polygons_internal = un(&internal_solid, &new_internal);
                    for s in backup.iter().filter(|s| matches!(s.ty, T::Top | T::Bottom | T::BottomBridge)) {
                        for p in df(&vec![s.poly.clone()], &polygons_internal) {
                            out.push(Surface { ty: s.ty, poly: p, bridge_angle: s.bridge_angle });
                        }
                    }
                    self.fill[nl] = out;
                }
            }
        }
    }
}

/// `Poly` ring helper for tests.
#[allow(dead_code)]
pub fn rect_poly(x0: f64, y0: f64, x1: f64, y1: f64) -> Poly {
    Poly { contour: vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]], holes: vec![] }
}
