// SPDX-License-Identifier: MPL-2.0
use super::*;


/// Make a segment soup CDT-admissible: split every pair of properly-crossing
/// constraints at their intersection (interned through `lift3`), and split
/// every constraint at any pooled point lying strictly in its interior.
/// Needed because adjacent slab profiles of a rebated opening genuinely CROSS
/// (a sill / lintel detail poking past the other slab's outline), and seam
/// endpoints can land in the interior of a ring edge.
pub(super) fn resolve_crossings(
    pool: &mut PointPool,
    lift3: impl Fn(V2) -> V3,
    segs: &mut Vec<(usize, usize)>,
) {
    let orig = segs.clone();
    let mut splits: Vec<Vec<(f64, usize)>> = vec![Vec::new(); orig.len()];
    // Pairwise proper crossings on the ORIGINAL segments (sub-segment
    // crossings are a subset, so one pass suffices).
    for i in 0..orig.len() {
        for j in (i + 1)..orig.len() {
            let (a, b) = orig[i];
            let (c, d) = orig[j];
            if a == c || a == d || b == c || b == d {
                continue;
            }
            let pa = [pool.pts2[a].x, pool.pts2[a].y];
            let pb = [pool.pts2[b].x, pool.pts2[b].y];
            let pc = [pool.pts2[c].x, pool.pts2[c].y];
            let pd = [pool.pts2[d].x, pool.pts2[d].y];
            let r = [pb[0] - pa[0], pb[1] - pa[1]];
            let sv = [pd[0] - pc[0], pd[1] - pc[1]];
            let den = r[0] * sv[1] - r[1] * sv[0];
            if den.abs() < 1.0e-18 {
                continue;
            }
            let ap = [pc[0] - pa[0], pc[1] - pa[1]];
            let t = (ap[0] * sv[1] - ap[1] * sv[0]) / den;
            let u = (ap[0] * r[1] - ap[1] * r[0]) / den;
            const E: f64 = 1.0e-9;
            if !(E..=1.0 - E).contains(&t) || !(E..=1.0 - E).contains(&u) {
                continue;
            }
            let q = [pa[0] + r[0] * t, pa[1] + r[1] * t];
            let idx = pool.intern(q, lift3(q), [0.0, 0.0, 1.0]);
            splits[i].push((t, idx));
            splits[j].push((u, idx));
        }
    }
    // Pooled points strictly interior to a segment (T-junctions).
    let n_pts = pool.pts2.len();
    for k in 0..n_pts {
        let p = [pool.pts2[k].x, pool.pts2[k].y];
        for (i, &(a, b)) in orig.iter().enumerate() {
            if a == k || b == k {
                continue;
            }
            let pa = [pool.pts2[a].x, pool.pts2[a].y];
            let pb = [pool.pts2[b].x, pool.pts2[b].y];
            let e = [pb[0] - pa[0], pb[1] - pa[1]];
            let len2 = e[0] * e[0] + e[1] * e[1];
            if len2 < 1.0e-18 {
                continue;
            }
            let t = ((p[0] - pa[0]) * e[0] + (p[1] - pa[1]) * e[1]) / len2;
            if !(1.0e-9..=1.0 - 1.0e-9).contains(&t) {
                continue;
            }
            let perp = ((p[0] - pa[0]) * e[1] - (p[1] - pa[1]) * e[0]).abs() / len2.sqrt();
            if perp <= pool.eps * 4.0 {
                splits[i].push((t, k));
            }
        }
    }
    let mut out: Vec<(usize, usize)> = Vec::with_capacity(orig.len() + 8);
    for (i, &(a, b)) in orig.iter().enumerate() {
        if splits[i].is_empty() {
            out.push((a, b));
            continue;
        }
        let mut sp = std::mem::take(&mut splits[i]);
        sp.sort_by(|x, y| x.0.total_cmp(&y.0));
        let mut prev = a;
        for &(_, idx) in &sp {
            if idx != prev {
                out.push((prev, idx));
                prev = idx;
            }
        }
        if prev != b {
            out.push((prev, b));
        }
    }
    out.sort();
    out.dedup();
    *segs = out;
}
