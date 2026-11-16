//! `FillConcentric` (classic offset-loops branch, used for sparse infill at density < 100%).
//! The Arachne branch libslic3r takes at 100% density is the walls lane's business and is not reproduced.
use super::gx::{self, P};
use super::Ctx;
use crate::types::{Poly, Polys};

fn point_in_ring(r: &[P], p: P) -> bool { gx::point_in_ring(r, p) }

/// `union_pt_chained_outside_in`: loops ordered depth first, parents before children, siblings by nearest neighbour.
fn outside_in(loops: Vec<Vec<P>>) -> Vec<Vec<P>> {
    let n = loops.len();
    let areas: Vec<f64> = loops.iter().map(|r| gx::ring_area(r).abs()).collect();
    let mut parent = vec![usize::MAX; n];
    for i in 0..n {
        let mut best: Option<usize> = None;
        for j in 0..n {
            if i == j || areas[j] <= areas[i] { continue; }
            if point_in_ring(&loops[j], loops[i][0]) && best.map_or(true, |b| areas[j] < areas[b]) { best = Some(j); }
        }
        if let Some(b) = best { parent[i] = b; }
    }
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); n + 1];
    for i in 0..n { children[if parent[i] == usize::MAX { n } else { parent[i] }].push(i); }
    let mut out_idx: Vec<usize> = Vec::new();
    fn walk(nodes: &[usize], children: &Vec<Vec<usize>>, loops: &Vec<Vec<P>>, out: &mut Vec<usize>) {
        // chain siblings greedily by first point, starting from the first one
        let mut rest: Vec<usize> = nodes.to_vec();
        let mut ordered = Vec::new();
        if rest.is_empty() { return; }
        let mut cur = rest.remove(0);
        ordered.push(cur);
        while !rest.is_empty() {
            let c = loops[cur][0];
            let (bi, _) = rest.iter().enumerate().map(|(k, &r)| (k, gx::dist(loops[r][0], c))).min_by(|a, b| a.1.partial_cmp(&b.1).unwrap()).unwrap();
            cur = rest.remove(bi);
            ordered.push(cur);
        }
        for k in ordered {
            out.push(k);
            walk(&children[k], children, loops, out);
        }
    }
    walk(&children[n].clone(), &children, &loops, &mut out_idx);
    out_idx.into_iter().map(|i| loops[i].clone()).collect()
}

fn clip_end(pl: &mut Vec<P>, mut distance: f64) {
    while distance > 0.0 {
        let last = pl.pop().unwrap();
        if pl.is_empty() { return; }
        let prev = *pl.last().unwrap();
        let v = [prev[0] - last[0], prev[1] - last[1]];
        let l2 = v[0] * v[0] + v[1] * v[1];
        if l2 > distance * distance {
            let k = distance / l2.sqrt();
            pl.push([last[0] + v[0] * k, last[1] + v[1] * k]);
            break;
        }
        distance -= l2.sqrt();
    }
}

pub fn fill_concentric(poly: &Poly, cx: &Ctx) -> Vec<Vec<P>> {
    let spacing = cx.spacing;
    let min_spacing = spacing * cx.multiline as f64;
    let distance = min_spacing / cx.density;
    // contracted by half the extra multiline width
    let contracted: Polys = gx::offset(&vec![poly.clone()], -0.5 * (cx.multiline as f64 - 1.0) * spacing);
    let mut loops: Vec<Vec<P>> = gx::rings(&contracted);
    let mut last = contracted;
    let mut guard = 0;
    while !last.is_empty() {
        guard += 1;
        if guard > 2000 { break; }
        let shrunk = gx::offset(&last, -(distance + min_spacing / 2.0));
        last = gx::offset(&shrunk, min_spacing / 2.0);
        loops.extend(gx::rings(&last));
    }
    let loops = outside_in(loops);
    let mut out: Vec<Vec<P>> = Vec::new();
    let mut last_pos = cx.origin; // (0,0) of object space
    for lp in loops {
        // split_at_index(nearest point)
        let (mut bi, mut bd) = (0usize, f64::INFINITY);
        for (i, p) in lp.iter().enumerate() { let d = (p[0] - last_pos[0]).powi(2) + (p[1] - last_pos[1]).powi(2); if d < bd { bd = d; bi = i; } }
        let mut pl: Vec<P> = Vec::with_capacity(lp.len() + 1);
        pl.extend_from_slice(&lp[bi..]);
        pl.extend_from_slice(&lp[..=bi]);
        last_pos = *pl.last().unwrap();
        out.push(pl);
    }
    let out = if cx.multiline > 1 { super::rect::multiline_offsets_pub(out, cx.multiline, spacing) } else { out };
    let mut res = Vec::new();
    for mut pl in out {
        clip_end(&mut pl, cx.c.loop_clipping);
        if pl.len() >= 2 { res.push(pl); }
    }
    res
}
