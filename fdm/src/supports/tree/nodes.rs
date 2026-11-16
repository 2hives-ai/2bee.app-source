//! `create_nodes_from_area` and friends: set the branch centre point of every influence area.
use super::areas::*;
use super::settings::*;
use super::volumes::*;
use crate::supports::poly;

fn set_points_on_areas(elem: &Elem, layer_above: Option<&mut Vec<Elem>>) {
    if !elem.state.result_set() { return; }
    if let Some(above) = layer_above {
        for &ni in &elem.parents {
            let next = &mut above[ni as usize];
            if !next.state.result_set() {
                next.state.result_on_layer = move_inside_if_outside(&next.influence_area, elem.state.result_on_layer);
            }
            next.state.marked = true;
        }
    }
}

fn set_to_model_contact_simple(elem: &mut Elem) {
    let best = move_inside_if_outside(&elem.influence_area, elem.state.next_position);
    elem.state.result_on_layer = best;
}

fn set_to_model_contact_gracious(volumes: &Volumes, cfg: &TreeSettings, mb: &mut Vec<Vec<Elem>>, first: (usize, usize)) {
    let mut last_success: Option<(usize, usize)> = None;
    {
        let mut cur = first;
        let mut layer_check = mb[cur.0][cur.1].state.layer_idx;
        loop {
            let e = &mb[cur.0][cur.1];
            let placeable = volumes.get_placeable_areas(element_collision_radius(cfg, &e.state), layer_check);
            if poly::intersect(&e.influence_area, &placeable).is_empty() { break; }
            last_success = Some(cur);
            if e.parents.len() != 1 { break; }
            let next = (cur.0 + 1, e.parents[0] as usize);
            layer_check += 1;
            cur = next;
        }
    }
    match last_success {
        None => {
            let e = &mut mb[first.0][first.1];
            e.state.to_model_gracious = false;
            set_to_model_contact_simple(e);
        }
        Some(last) => {
            let mut cur = first;
            while cur != last {
                let next = (cur.0 + 1, mb[cur.0][cur.1].parents[0] as usize);
                mb[cur.0][cur.1].state.deleted = true;
                cur = next;
            }
            let l = &mut mb[last.0][last.1];
            let best = move_inside_if_outside(&l.influence_area, l.state.next_position);
            l.state.result_on_layer = best;
        }
    }
}

fn remove_deleted_elements(move_bounds: &mut Vec<Vec<Elem>>) {
    let mut map_parents: Vec<i32> = Vec::new();
    let mut map_current: Vec<i32> = Vec::new();
    for layer_idx in (0..move_bounds.len()).rev() {
        let layer = &mut move_bounds[layer_idx];
        map_current.clear();
        let mut i = 0usize;
        while i < layer.len() {
            if layer[i].state.deleted {
                if map_current.is_empty() { map_current = (0..layer.len() as i32).collect(); }
                while i < layer.len() && layer.last().unwrap().state.deleted {
                    layer.pop();
                    map_current[layer.len()] = -1;
                }
                if i + 1 < layer.len() {
                    let last = layer.pop().unwrap();
                    layer[i] = last;
                    map_current[i] = -1;
                    let sz = layer.len();
                    map_current[sz] = i as i32;
                }
            } else {
                if !map_parents.is_empty() {
                    for p in layer[i].parents.iter_mut() { *p = map_parents[*p as usize]; }
                }
                i += 1;
            }
        }
        std::mem::swap(&mut map_current, &mut map_parents);
    }
}

pub fn create_nodes_from_area(volumes: &Volumes, cfg: &TreeSettings, move_bounds: &mut Vec<Vec<Elem>>) {
    let n = move_bounds.len();
    if n == 0 { return; }
    // layer 0
    {
        if n > 1 { for e in move_bounds[1].iter_mut() { e.state.marked = false; } }
        for i in 0..move_bounds[0].len() {
            let (l0, rest) = move_bounds.split_at_mut(1);
            let init = &mut l0[0][i];
            init.state.result_on_layer = move_inside_if_outside(&init.influence_area, init.state.next_position);
            let init_c = init.clone();
            set_points_on_areas(&init_c, rest.get_mut(0));
        }
    }
    for layer_idx in 1..n {
        if layer_idx + 1 < n { for e in move_bounds[layer_idx + 1].iter_mut() { e.state.marked = false; } }
        let count = move_bounds[layer_idx].len();
        for ei in 0..count {
            if !move_bounds[layer_idx][ei].state.result_set() {
                let (to_bp, dtt, roof, gracious) = {
                    let e = &move_bounds[layer_idx][ei].state;
                    (e.to_buildplate, e.distance_to_top, e.supports_roof, e.to_model_gracious)
                };
                if to_bp || ((dtt as usize) < cfg.min_dtt_to_model && !roof) {
                    move_bounds[layer_idx][ei].state.deleted = true;
                } else if gracious {
                    set_to_model_contact_gracious(volumes, cfg, move_bounds, (layer_idx, ei));
                } else {
                    set_to_model_contact_simple(&mut move_bounds[layer_idx][ei]);
                }
            }
            {
                let e = &mut move_bounds[layer_idx][ei];
                if !e.state.deleted && !e.state.marked && e.state.target_height == layer_idx as i32 { e.state.deleted = true; }
            }
            let deleted = move_bounds[layer_idx][ei].state.deleted;
            let parents = move_bounds[layer_idx][ei].parents.clone();
            if deleted {
                if layer_idx + 1 < n {
                    for pi in parents { move_bounds[layer_idx + 1][pi as usize].state.result_reset(); }
                }
            } else {
                let elem_c = move_bounds[layer_idx][ei].clone();
                let (_, rest) = move_bounds.split_at_mut(layer_idx + 1);
                set_points_on_areas(&elem_c, rest.get_mut(0));
            }
        }
    }
    remove_deleted_elements(move_bounds);
}
