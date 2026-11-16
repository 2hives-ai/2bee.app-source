//! lane 6: support generation (normal + tree) and raft.
//!
//! Public entry point: [`generate`]. Input is the sliced object (`types::Layer`, `z` = layer top,
//! `region` = union of the layer's slices), the support-relevant settings ([`SupportConfig`]) and the
//! optional enforcer / blocker regions; output is one [`SupportLayerPlan`] per support layer with
//! `ExtPath`s tagged `Feature::{Support, SupportInterface, SupportTransition}` plus the raft layers.
//!
//! Support layers do NOT line up with object layers when `independent_support_layer_height` is on (the
//! X2D profile): they have their own `z`/`h` (e.g. 0.3 mm steps under 0.2 mm object layers). The
//! caller merges them into the print by `z` (Orca prints a support layer at its z between object
//! layers).
mod poly;
mod config;
mod params;
mod grid;
mod normal;
mod fill;
mod connect;
mod tree;
pub use config::*;

use crate::types::{ExtPath, Feature, FdmError, Layer, PathPt, Polys};
use normal::*;

pub struct SupportInput<'a> {
    pub cfg: &'a SupportConfig,
    /// Object layers, `z` = top of the layer measured from the object bottom (NOT shifted by a raft).
    pub layers: &'a [Layer],
    /// Orca's object-local origin expressed in the layers' coordinate frame: the centre of the object
    /// footprint (bounding box centre of the mesh). Fill patterns and the support grid are anchored to
    /// it, exactly as Orca anchors them to the object origin.
    pub origin: [f64; 2],
    /// Support enforcers per object layer (empty slice = none).
    pub enforcers: &'a [Polys],
    /// Support blockers per object layer (empty slice = none).
    pub blockers: &'a [Polys],
    /// Brim footprint of the first object layer, used to trim first-layer support (None = no brim).
    pub brim: Option<&'a Polys>,
}

#[derive(Clone, Debug)]
pub struct SupportLayerPlan {
    /// print z (top of the layer), already including the raft offset
    pub z: f64,
    pub h: f64,
    pub bottom_z: f64,
    /// Orca `SupportLayer::interface_id` (drives the alternating interface angle)
    pub interface_id: usize,
    pub is_raft: bool,
    pub paths: Vec<ExtPath>,
    /// Same length as `paths`. Paths with equal group id and `no_sort[i]` must stay in this order
    /// (Orca's `no_sort` collections: first layer sheath + fill). Others may be reordered freely.
    pub group: Vec<u32>,
    pub no_sort: Vec<bool>,
    /// union of the filled areas of the layer (for retraction/travel planning)
    pub islands: Polys,
}

#[derive(Clone, Debug, Default)]
pub struct SupportPlan {
    pub layers: Vec<SupportLayerPlan>,
    /// Add this to every object layer z (raft height + gap); 0 without raft.
    pub object_z_shift: f64,
    /// Object layer height of the first object layer when a raft is printed (Orca: layer_height), else None.
    pub first_object_layer_height: Option<f64>,
    pub notes: Vec<String>,
}

fn to_ext_path(p: &PathOut, origin: [f64; 2]) -> ExtPath {
    ExtPath {
        feature: p.feature,
        pts: p.pts.iter().map(|q| PathPt { x: q[0] + origin[0], y: q[1] + origin[1], w: p.width }).collect(),
        closed: p.closed,
        layer_h: p.height,
        speed: 0.0,
        flow_ratio: p.flow_ratio,
    }
}

/// Generate supports and raft. Refuses (Err(Unsupported)) settings that are not ported rather than approximating silently.
pub fn generate(inp: &SupportInput) -> Result<SupportPlan, FdmError> {
    let cfg = inp.cfg;
    let mut plan = SupportPlan::default();
    let has_support = cfg.enable_support || cfg.enforce_support_layers > 0;
    if !has_support && cfg.raft_layers <= 0 { return Ok(plan); }
    if inp.layers.is_empty() { return Ok(plan); }
    if cfg.support_type.is_tree() {
        return tree_entry::generate_tree(inp);
    }
    if cfg.thick_bridges { return Err(FdmError::Unsupported("thick_bridges=1 with normal supports (bridging contact layers) is not ported".into())); }
    if cfg.bridge_no_support { return Err(FdmError::Unsupported("bridge_no_support=1 (remove_bridges_from_contacts) is not ported".into())); }
    if cfg.support_interface_loop_pattern { return Err(FdmError::Unsupported("support_interface_loop_pattern=1 is not ported".into())); }
    if cfg.support_ironing { return Err(FdmError::Unsupported("support_ironing=1 is not ported".into())); }
    let sp = params::SlicingParams::create(cfg);
    let shift = sp.object_print_z_min;
    let o = inp.origin;
    let tr = |p: &Polys| -> Polys { poly::translate(p, -o[0], -o[1]) };
    let mut layers: Vec<OL> = Vec::with_capacity(inp.layers.len());
    for l in inp.layers {
        layers.push(OL { print_z: l.z + shift, height: l.h, slices: tr(&l.region), ..Default::default() });
    }
    // top surfaces: this layer minus the next one, opened by a tenth of the external width
    let fw = cfg.outer_wall_line_width;
    for i in 0..layers.len() {
        layers[i].top = if i + 1 < layers.len() {
            let d = poly::diff(&layers[i].slices, &layers[i + 1].slices);
            poly::opening(&d, fw / 10.0, fw / 10.0)
        } else { layers[i].slices.clone() };
    }
    let n = layers.len();
    let enforcers: Vec<Polys> = if inp.enforcers.len() == n { inp.enforcers.iter().map(&tr).collect() } else { vec![Vec::new(); n] };
    let blockers: Vec<Polys> = if inp.blockers.len() == n {
        inp.blockers.iter().map(|b| if b.is_empty() { Vec::new() } else { poly::offset(&tr(b), 0.1) }).collect()
    } else { vec![Vec::new(); n] };
    let mut g = Gen::new(GenInput { cfg, layers, enforcers, blockers })?;
    g.compute_buildplate_covered();
    let top_contacts = g.top_contact_layers();
    if std::env::var("SUP_TRACE").is_ok() {
        for &t in &top_contacts { let l = &g.store.v[t]; eprintln!("TOPCONTACT print_z {:.3} bottom_z {:.3} h {:.3} idx_above {:?} polys {} area {:.2} overhang area {:.2}", l.print_z, l.bottom_z, l.height, l.idx_above, l.polygons.len(), poly::area(&l.polygons), l.overhang.as_ref().map(|o| poly::area(o)).unwrap_or(0.0)); if let Some(o) = &l.overhang { for pg in o { let (mn, mx) = poly::bbox(&vec![pg.clone()]).unwrap(); eprintln!("   overhang poly bbox [{:.2},{:.2} - {:.2},{:.2}] area {:.3}", mn[0], mn[1], mx[0], mx[1], poly::poly_area(pg)); } } }
    }
    if top_contacts.is_empty() {
        plan.notes.push("no support contacts".into());
        return Ok(plan);
    }
    let (bottom_contacts, layer_support_areas) = g.bottom_contact_layers_and_layer_support_areas(&top_contacts);
    if std::env::var("SUP_TRACE").is_ok() { for (i, a) in layer_support_areas.iter().enumerate() { if !a.is_empty() { eprintln!("SUPPORT_AREA layer {} area {:.2} polys {}", i, poly::area(a), a.len()); } } }
    let intermediate = g.raft_and_intermediate_support_layers(&bottom_contacts, &top_contacts);
    let (gso, gos, gxy) = (g.sp.gap_support_object, g.sp.gap_object_support, g.p.gap_xy);
    g.trim_support_layers_by_object(&top_contacts, gso, gos, gxy);
    g.generate_base_layers(&bottom_contacts, &top_contacts, &intermediate, &layer_support_areas);
    if std::env::var("SUP_TRACE").is_ok() { for &i in &intermediate { let l = &g.store.v[i]; eprintln!("INTERMEDIATE z {:.3} h {:.3} area {:.2} polys {}", l.print_z, l.height, poly::area(&l.polygons), l.polygons.len()); } }
    g.trim_top_contacts_by_bottom_contacts(&bottom_contacts, &top_contacts);
    let interface_layers = g.generate_interface_layers(&bottom_contacts, &top_contacts, &intermediate, &[]);
    let brim: Polys = inp.brim.map(|b| tr(b)).unwrap_or_default();
    let raft_layers = g.generate_raft_base(&top_contacts, &interface_layers, &intermediate, &brim);
    let descs = g.generate_support_layers(&[&raft_layers, &bottom_contacts, &top_contacts, &intermediate, &interface_layers]);
    let lp = g.generate_support_toolpaths(&descs, &raft_layers, &bottom_contacts, &top_contacts, &intermediate, &interface_layers)?;
    for l in lp {
        let mut paths = Vec::with_capacity(l.paths.len());
        let mut group = Vec::with_capacity(l.paths.len());
        let mut no_sort = Vec::with_capacity(l.paths.len());
        for p in &l.paths { paths.push(to_ext_path(p, o)); group.push(p.group); no_sort.push(p.no_sort); }
        plan.layers.push(SupportLayerPlan {
            z: l.print_z, h: l.height, bottom_z: l.bottom_z, interface_id: l.interface_id, is_raft: l.is_raft,
            paths, group, no_sort, islands: poly::translate(&l.islands, o[0], o[1]),
        });
    }
    plan.object_z_shift = shift;
    if sp.has_raft() { plan.first_object_layer_height = Some(sp.first_object_layer_height); }
    Ok(plan)
}

mod tree_entry {
    use super::*;
    use super::tree::{draw, nodes, settings as ts, tips, volumes as tv, areas, overhang};
    use std::collections::HashSet;

    pub fn generate_tree(inp: &SupportInput) -> Result<SupportPlan, FdmError> {
        let cfg = inp.cfg;
        let mut plan = SupportPlan::default();
        if cfg.thick_bridges { /* tree has no bridging contacts */ }
        if cfg.support_interface_loop_pattern { return Err(FdmError::Unsupported("support_interface_loop_pattern=1 is not ported".into())); }
        if cfg.support_ironing { return Err(FdmError::Unsupported("support_ironing=1 is not ported".into())); }
        if cfg.enable_support && cfg.support_type != SupportType::TreeAuto {
            return Err(FdmError::Unsupported("tree(manual) support enforcers-only mode is not ported".into()));
        }
        let sp = params::SlicingParams::create(cfg);
        let shift = sp.object_print_z_min;
        let o = inp.origin;
        let tr = |p: &Polys| -> Polys { poly::translate(p, -o[0], -o[1]) };
        let mut layers: Vec<OL> = Vec::with_capacity(inp.layers.len());
        for l in inp.layers { layers.push(OL { print_z: l.z + shift, height: l.h, slices: tr(&l.region), ..Default::default() }); }
        let n = layers.len();
        let enforcers: Vec<Polys> = if inp.enforcers.len() == n { inp.enforcers.iter().map(&tr).collect() } else { vec![Vec::new(); n] };
        let blockers: Vec<Polys> = if inp.blockers.len() == n { inp.blockers.iter().map(&tr).collect() } else { vec![Vec::new(); n] };
        let mut g = Gen::new(GenInput { cfg, layers, enforcers: enforcers.clone(), blockers: blockers.clone() })?;
        g.tree_mode = true;
        let msettings = ts::MeshGroupSettings::new(cfg, &g.sp, &g.p.flow, &g.p.interface_flow, g.p.ext_perimeter_width);
        let tcfg = ts::TreeSettings::new(&msettings, &g.sp);
        let nraft = tcfg.raft_layers.len();
        // overhangs (TreeSupport::detect_overhangs), placed on support layer index = object layer + raft layers
        let slices: Vec<Polys> = g.layers.iter().map(|l| l.slices.clone()).collect();
        let heights: Vec<f64> = g.layers.iter().map(|l| l.height).collect();
        let oh = if cfg.enable_support || cfg.enforce_support_layers > 0 { overhang::detect_overhangs(cfg, &slices, &heights, &enforcers, &blockers) } else { vec![Vec::new(); n] };
        let total = n + nraft;
        let mut overhangs: Vec<Polys> = vec![Vec::new(); total];
        for (i, p) in oh.into_iter().enumerate() { if i < n { overhangs[i + nraft] = p; } }
        // precalculate(): top most relevant layer
        let mut max_support_layer_id = 0usize;
        for layer_id in nraft.max(1)..total { if !overhangs[layer_id].is_empty() { max_support_layer_id = layer_id; } }
        let max_layer = (max_support_layer_id as i64 - tcfg.z_distance_top_layers as i64).max(0) as usize;
        let has_support = max_layer > 0;
        let has_raft = nraft > 0;
        let num_support_layers = max_layer.max(nraft);
        if num_support_layers == 0 { plan.notes.push("no support contacts".into()); return Ok(plan); }
        let mut outlines: Vec<Polys> = vec![Vec::new(); total];
        let res = ts::mm(tcfg.resolution);
        for i in 0..n { outlines[i + nraft] = poly::simplify(&slices[i], res); }
        let volumes = tv::Volumes::new(&tcfg, outlines, blockers.clone(), Vec::new());
        let nl = num_support_layers;
        let mut ctx = tips::TreeCtx {
            g: &mut g, tcfg: tcfg.clone(), volumes, move_bounds: vec![Vec::new(); nl],
            top_contacts: vec![None; nl], top_interfaces: vec![None; nl], top_base_interfaces: vec![None; nl],
            bottom_contacts: vec![None; nl], intermediate: vec![None; nl],
            already_inserted: vec![HashSet::new(); nl], force_tip_to_roof: false,
            min_xy_dist: tcfg.xy_distance > tcfg.xy_min_distance, base_circle_radius: ts::sc(0.01),
        };
        if has_support {
            ctx.generate_initial_areas(&overhangs, nl);
            areas::create_layer_pathing(&ctx.volumes, &ctx.tcfg, &mut ctx.move_bounds);
            nodes::create_nodes_from_area(&ctx.volumes, &ctx.tcfg, &mut ctx.move_bounds);
            draw::organic_draw_branches(&mut ctx);
        } else if has_raft {
            // no overhangs: only the raft contact layer
            if ctx.generate_raft_contact() < 0 { plan.notes.push("no support contacts".into()); return Ok(plan); }
        } else { plan.notes.push("no support contacts".into()); return Ok(plan); }
        let _ = has_raft;
        let take = |v: &Vec<Option<usize>>| -> Vec<usize> { v.iter().flatten().copied().collect() };
        let (top_roofs0, top_roofs1, top_roofs2) = (take(&ctx.top_contacts), take(&ctx.top_interfaces), take(&ctx.top_base_interfaces));
        let bottom_contacts = take(&ctx.bottom_contacts);
        let intermediate = take(&ctx.intermediate);
        drop(ctx);
        let _ = top_roofs2;
        let top_contacts = top_roofs0;
        let interface_layers = g.generate_interface_layers(&bottom_contacts, &top_contacts, &intermediate, &top_roofs1);
        let brim: Polys = inp.brim.map(|b| tr(b)).unwrap_or_default();
        let raft_layers = g.generate_raft_base(&top_contacts, &interface_layers, &intermediate, &brim);
        let descs = g.generate_support_layers(&[&raft_layers, &bottom_contacts, &top_contacts, &intermediate, &interface_layers]);
        let lp = g.generate_support_toolpaths(&descs, &raft_layers, &bottom_contacts, &top_contacts, &intermediate, &interface_layers)?;
        for l in lp {
            let mut paths = Vec::with_capacity(l.paths.len());
            let mut group = Vec::with_capacity(l.paths.len());
            let mut no_sort = Vec::with_capacity(l.paths.len());
            for p in &l.paths { paths.push(to_ext_path(p, o)); group.push(p.group); no_sort.push(p.no_sort); }
            plan.layers.push(SupportLayerPlan {
                z: l.print_z, h: l.height, bottom_z: l.bottom_z, interface_id: l.interface_id, is_raft: l.is_raft,
                paths, group, no_sort, islands: poly::translate(&l.islands, o[0], o[1]),
            });
        }
        plan.object_z_shift = shift;
        if g.sp.has_raft() { plan.first_object_layer_height = Some(g.sp.first_object_layer_height); }
        Ok(plan)
    }
}

#[allow(dead_code)]
fn _feature_names() -> [Feature; 3] { [Feature::Support, Feature::SupportInterface, Feature::SupportTransition] }

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Poly, Polys};

    /// Layers of the T test shape (stem 8 wide up to z=10, then a 30 wide bar to z=14; 20 deep), 0.2 mm layers
    /// sliced at mid height, centred on the origin. This is the shape the Orca reference G-code was made from.
    fn t_layers() -> Vec<Layer> {
        let rect = |x0: f64, x1: f64| -> Poly { Poly { contour: vec![[x0, -10.0], [x1, -10.0], [x1, 10.0], [x0, 10.0]], holes: vec![] } };
        let mut v = Vec::new();
        for i in 0..70 {
            let z_top = 0.2 * (i as f64 + 1.0);
            let z_mid = z_top - 0.1;
            let region: Polys = if z_mid < 10.0 { vec![rect(-4.0, 4.0)] } else { vec![rect(-15.0, 15.0)] };
            v.push(Layer { index: i, z: z_top, h: 0.2, region });
        }
        v
    }
    fn cfg_normal() -> SupportConfig {
        let mut c = SupportConfig::default();
        c.enable_support = true;
        c.support_type = SupportType::NormalAuto;
        c
    }
    fn run(c: &SupportConfig, layers: &[Layer]) -> SupportPlan {
        generate(&SupportInput { cfg: c, layers, origin: [0.0, 0.0], enforcers: &[], blockers: &[], brim: None }).unwrap()
    }

    #[test]
    fn disabled_gives_nothing() {
        let mut c = cfg_normal();
        c.enable_support = false;
        let p = run(&c, &t_layers());
        assert!(p.layers.is_empty());
    }

    #[test]
    fn t_shape_layer_stack_matches_orca() {
        // measured from Orca: support layers at z = 0.2, 0.5, 0.8 ... 9.2 (base, 0.3 mm), then interface at 9.5 and 9.8
        let p = run(&cfg_normal(), &t_layers());
        let zs: Vec<f64> = p.layers.iter().map(|l| (l.z * 1000.0).round() / 1000.0).collect();
        let mut expect = vec![0.2];
        let mut z = 0.5;
        while z < 9.3 { expect.push((z * 1000.0f64).round() / 1000.0); z += 0.3; }
        expect.push(9.5);
        expect.push(9.8);
        assert_eq!(zs, expect, "support layer z sequence");
        // interface only in the last two layers, base below
        for l in &p.layers[..p.layers.len() - 2] {
            assert!(l.paths.iter().all(|x| x.feature == Feature::Support), "layer z={} has non-base paths", l.z);
        }
        for l in &p.layers[p.layers.len() - 2..] {
            assert!(l.paths.iter().all(|x| x.feature == Feature::SupportInterface));
        }
        assert!(p.layers.iter().all(|l| !l.is_raft));
        assert_eq!(p.object_z_shift, 0.0);
    }

    #[test]
    fn t_shape_never_touches_the_object() {
        // negative control below: with xy distance 0 the support CAN touch; with 0.35 it must keep clear
        let c = cfg_normal();
        let layers = t_layers();
        let p = run(&c, &layers);
        let stem = vec![Poly { contour: vec![[-4.0, -10.0], [4.0, -10.0], [4.0, 10.0], [-4.0, 10.0]], holes: vec![] }];
        let keep_out = poly::offset(&stem, c.support_object_xy_distance - 0.02);
        let keep_out_first = poly::offset(&stem, c.support_object_first_layer_gap - 0.02);
        let mut checked = 0;
        for l in &p.layers {
            if l.z > 9.9 { continue; }
            let keep_out = if l.z < 0.25 { &keep_out_first } else { &keep_out };
            let a = poly::area(&poly::intersect(&l.islands, keep_out));
            // 0.3 mm2 over 40 mm of edge is <8 um: Clipper square-join/lattice rounding; Orca bbox parity is checked in the G-code regression
            assert!(a < 0.3, "support island of layer z={} intrudes into the stem keep-out by {a} mm2", l.z);
            checked += 1;
        }
        assert!(checked > 30, "population examined: {checked}");
        // plant: the same check must FAIL when the keep-out is grown enough to reach the support
        let big = poly::offset(&stem, 3.0);
        let a = poly::area(&poly::intersect(&p.layers[3].islands, &big));
        assert!(a > 1.0, "plant not detected: support is supposed to hug the stem within 3mm, overlap {a}");
    }

    #[test]
    fn t_shape_base_and_interface_lengths_match_orca() {
        // Orca 2.5.0-dev, X2D 0.4, normal(auto), default profile: per base layer 284.65 mm over 2 paths,
        // first layer 1725.22 mm over 6 paths, interface layers 779.08 mm over 5 paths (see fdm/README parity notes)
        let p = run(&cfg_normal(), &t_layers());
        let len = |l: &SupportLayerPlan| -> f64 { l.paths.iter().map(|x| x.pts.windows(2).map(|w| ((w[1].x - w[0].x).powi(2) + (w[1].y - w[0].y).powi(2)).sqrt()).sum::<f64>()).sum() };
        let base = &p.layers[5];
        assert_eq!(base.paths.len(), 2);
        assert!((len(base) - 284.65).abs() < 3.0, "base layer length {}", len(base));
        let iface = &p.layers[p.layers.len() - 1];
        assert!((len(iface) - 779.08).abs() < 8.0, "interface length {} ({} paths)", len(iface), iface.paths.len());
        let first = &p.layers[0];
        assert!((len(first) - 1725.22).abs() < 40.0, "first layer length {}", len(first));
    }

    #[test]
    fn support_only_under_overhang() {
        let p = run(&cfg_normal(), &t_layers());
        // every support island lies within x +-(15 + 3 mm grid growth), and nothing beyond the bar's y extent + grid growth
        for l in &p.layers {
            let (mn, mx) = poly::bbox(&l.islands).unwrap();
            assert!(mn[0] > -19.5 && mx[0] < 19.5 && mn[1] > -14.0 && mx[1] < 14.0, "{:?} {:?}", mn, mx);
        }
    }

    #[test]
    fn extrusion_widths_are_the_support_flow() {
        let p = run(&cfg_normal(), &t_layers());
        let l = &p.layers[3];
        for x in &l.paths {
            assert!(x.layer_h > 0.19 && x.layer_h < 0.31);
            for q in &x.pts { assert!((q.w - 0.42).abs() < 1e-6); }
        }
        // first layer uses initial_layer_line_width 0.5
        let l0 = &p.layers[0];
        assert!(l0.paths.iter().all(|x| x.pts.iter().all(|q| (q.w - 0.5).abs() < 1e-6)));
        assert!((l0.h - 0.2).abs() < 1e-9);
    }

    #[test]
    fn raft_shifts_object_and_adds_layers() {
        let mut c = cfg_normal();
        c.enable_support = false;
        c.raft_layers = 3;
        let layers = t_layers();
        let p = run(&c, &layers);
        assert!(p.layers.len() >= 3, "raft layers: {}", p.layers.len());
        assert!(p.layers.iter().filter(|l| l.is_raft).count() == 3 - 1 || p.layers.iter().filter(|l| l.is_raft).count() == 3);
        assert!(p.object_z_shift > 0.5, "object must be lifted by the raft: {}", p.object_z_shift);
    }

    #[test]
    fn unsupported_settings_are_refused() {
        let mut c = cfg_normal();
        c.thick_bridges = true;
        let r = generate(&SupportInput { cfg: &c, layers: &t_layers(), origin: [0.0, 0.0], enforcers: &[], blockers: &[], brim: None });
        assert!(matches!(r, Err(FdmError::Unsupported(_))));
    }

    fn cfg_tree() -> SupportConfig {
        let mut c = SupportConfig::default();
        c.enable_support = true;
        c.support_type = SupportType::TreeAuto;
        c
    }
    fn total_len(p: &SupportPlan, f: Feature) -> f64 {
        p.layers.iter().flat_map(|l| l.paths.iter()).filter(|x| x.feature == f)
            .map(|x| x.pts.windows(2).map(|w| ((w[1].x - w[0].x).powi(2) + (w[1].y - w[0].y).powi(2)).sqrt()).sum::<f64>()).sum()
    }

    #[test]
    fn tree_t_shape_matches_orca_totals() {
        // Orca 2.5.0-dev tree(auto) on the T shape: 49 layers, base 12518 mm, interface 1064 mm (measured from G-code)
        let p = run(&cfg_tree(), &t_layers());
        assert_eq!(p.layers.len(), 49, "support layer count");
        let base = total_len(&p, Feature::Support);
        let iface = total_len(&p, Feature::SupportInterface);
        assert!((base / 12518.0 - 1.0).abs() < 0.08, "tree base length {base}");
        assert!((iface / 1064.0 - 1.0).abs() < 0.03, "tree interface length {iface}");
        // the top two layers are interface, everything below is branch material
        for l in &p.layers[..p.layers.len() - 2] { assert!(l.paths.iter().all(|x| x.feature == Feature::Support)); }
    }

    #[test]
    fn tree_keeps_clear_of_the_object_and_is_deterministic() {
        let c = cfg_tree();
        let layers = t_layers();
        let a = run(&c, &layers);
        let b = run(&c, &layers);
        assert_eq!(a.layers.len(), b.layers.len());
        for (x, y) in a.layers.iter().zip(&b.layers) {
            assert_eq!(x.paths.len(), y.paths.len());
            for (p, q) in x.paths.iter().zip(&y.paths) { assert_eq!(p.pts.len(), q.pts.len()); }
        }
        let stem = vec![Poly { contour: vec![[-4.0, -10.0], [4.0, -10.0], [4.0, 10.0], [-4.0, 10.0]], holes: vec![] }];
        let keep_out = poly::offset(&stem, c.support_object_xy_distance.min(0.2) - 0.05);
        let mut checked = 0;
        for l in &a.layers {
            if l.z > 9.9 { continue; }
            assert!(poly::area(&poly::intersect(&l.islands, &keep_out)) < 0.05, "tree island at z={} intrudes into the stem", l.z);
            checked += 1;
        }
        assert!(checked > 30, "population examined: {checked}");
    }

    #[test]
    fn tree_manual_is_refused() {
        let mut c = cfg_tree();
        c.support_type = SupportType::TreeManual;
        let r = generate(&SupportInput { cfg: &c, layers: &t_layers(), origin: [0.0, 0.0], enforcers: &[], blockers: &[], brim: None });
        assert!(matches!(r, Err(FdmError::Unsupported(_))));
    }

    #[test]
    fn tree_without_overhang_makes_nothing() {
        let rect = Poly { contour: vec![[-5.0, -5.0], [5.0, -5.0], [5.0, 5.0], [-5.0, 5.0]], holes: vec![] };
        let layers: Vec<Layer> = (0..20).map(|i| Layer { index: i, z: 0.2 * (i as f64 + 1.0), h: 0.2, region: vec![rect.clone()] }).collect();
        let p = run(&cfg_tree(), &layers);
        assert!(p.layers.is_empty());
    }
}
