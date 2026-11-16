//! `chain_polylines` for integer polylines (placeholder: delegates to the float chainer until the exact
//! `chain_segments_greedy2` + two-exchange port lands).
use crate::infill::chain_polylines;
pub fn chain_polylines_int(lines: Vec<Vec<[i64; 2]>>) -> Vec<Vec<[i64; 2]>> {
    let f: Vec<Vec<[f64; 2]>> = lines.iter().map(|l| l.iter().map(|p| [p[0] as f64 * 1e-6, p[1] as f64 * 1e-6]).collect()).collect();
    chain_polylines(f, None).into_iter().map(|l| l.into_iter().map(|p| [(p[0] * 1e6).round() as i64, (p[1] * 1e6).round() as i64]).collect()).collect()
}
