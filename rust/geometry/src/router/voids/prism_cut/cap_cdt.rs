// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The cap CDT: pool the face ring, auxiliary rings and seams, run the
//! conforming CDT, and emit each kept sub-triangle with the result
//! orientation.

use super::crossings::resolve_crossings;
use super::extension::point_inside;
use super::face::Seam;
use super::frame::PrismFrame;
use super::kit::{add, dot, scale, V2, V3};
use super::pool::PointPool;
use super::ptri::PTri;
use crate::cdt::triangulate_pslg;

/// Emit one cap triangle with the RESULT orientation: `flip` swaps the winding
/// so the geometric normal matches `desired`.
pub(super) fn emit_cap(caps: &mut Vec<PTri>, a: V3, b: V3, c: V3, desired: V3, flip: bool) {
    let (b, c) = if flip { (c, b) } else { (b, c) };
    caps.push(PTri {
        p: [a, b, c],
        n: [desired, desired, desired],
    });
}

/// Shared cap CDT for a SINGLE-region face (side strips): domain ring +
/// seams, keep = `region(centroid)` && host parity.
#[allow(clippy::too_many_arguments)]
pub(super) fn cap_cdt(
    pf: &PrismFrame,
    ring2: &[V2],
    ring3: &[V3],
    aux: &[&[V2]],
    seams: &[Seam],
    inject: &[(V2, V3)],
    desired: V3,
    flip: bool,
    region: impl Fn(V2) -> bool,
    host: &[PTri],
    aabbs: &[(V3, V3)],
    caps: &mut Vec<PTri>,
) -> bool {
    cap_cdt_impl(pf, ring2, ring3, aux, seams, inject, host, aabbs, caps, |q| {
        region(q).then_some((desired, flip))
    })
}

/// Cap CDT for a stepped cap plane: keep = XOR of the adjacent profiles, with
/// per-region orientation (−d where only the lower slab exists, +d where only
/// the upper does).
#[allow(clippy::too_many_arguments)]
pub(super) fn cap_cdt_xor(
    pf: &PrismFrame,
    ring2: &[V2],
    ring3: &[V3],
    aux: &[&[V2]],
    seams: &[Seam],
    inject: &[(V2, V3)],
    _wdepth: f64,
    in_lower: impl Fn(V2) -> bool,
    in_upper: impl Fn(V2) -> bool,
    host: &[PTri],
    aabbs: &[(V3, V3)],
    caps: &mut Vec<PTri>,
) -> bool {
    let d = pf.d;
    cap_cdt_impl(pf, ring2, ring3, aux, seams, inject, host, aabbs, caps, move |q| {
        let lo = in_lower(q);
        let up = in_upper(q);
        if lo == up {
            return None; // outside the exposed XOR region
        }
        if lo {
            // Cutter below the plane ⇒ solid above ⇒ normal −d. CCW-in-(u,v)
            // lifts to +d ⇒ flip.
            Some((scale(d, -1.0), true))
        } else {
            Some((d, false))
        }
    })
}


/// The cap CDT core: pool the ring, aux-profile rings and seams; chain every
/// straight constraint through the pooled points lying on it; run the
/// conforming CDT; classify each sub-triangle by `classify(centroid)` (which
/// returns the emit orientation) && host parity.
#[allow(clippy::too_many_arguments)]
pub(super) fn cap_cdt_impl(
    pf: &PrismFrame,
    ring2: &[V2],
    ring3: &[V3],
    aux: &[&[V2]],
    seams: &[Seam],
    inject: &[(V2, V3)],
    host: &[PTri],
    aabbs: &[(V3, V3)],
    caps: &mut Vec<PTri>,
    classify: impl Fn(V2) -> Option<(V3, bool)>,
) -> bool {
    let snap_eps = 1.0e-9 * (1.0 + pf.corner_mag());
    let mut pool = PointPool::new(snap_eps);
    let placeholder_n = [0.0, 0.0, 1.0];
    let ring_idx: Vec<usize> = ring2
        .iter()
        .zip(ring3)
        .map(|(&q, &p3)| pool.intern(q, p3, placeholder_n))
        .collect();
    // Aux profile rings (cap planes only): 2D verts lifted on the face plane.
    // Their 3D lift shares the plane depth of ring3[0] along d.
    let wdepth = dot(ring3[0], pf.d);
    let mut aux_idx: Vec<Vec<usize>> = Vec::new();
    for prof in aux {
        aux_idx.push(
            prof.iter()
                .map(|&[uu, vv]| pool.intern([uu, vv], pf.lift(uu, vv, wdepth), placeholder_n))
                .collect(),
        );
    }
    // Canonical shared-boundary breakpoints (pooled so the chains below pick
    // them up — the cross-face T-junction freedom).
    for &(q, p3) in inject {
        pool.intern(q, p3, placeholder_n);
    }
    let mut seam_segs: Vec<(usize, usize)> = Vec::new();
    for s in seams {
        let ia = pool.intern(s.a2, s.a3, placeholder_n);
        let ib = pool.intern(s.b2, s.b3, placeholder_n);
        if ia != ib {
            seam_segs.push((ia, ib));
        }
    }
    // Chain every straight constraint (ring edges + aux profile edges) through
    // the pooled points lying on it, so seam endpoints subdivide them and the
    // CDT stays conforming.
    let n_pool = pool.pts2.len();
    let mut seg_list: Vec<(usize, usize)> = seam_segs;
    let chain = |ia: usize, ib: usize, seg_list: &mut Vec<(usize, usize)>| {
        let a = [pool.pts2[ia].x, pool.pts2[ia].y];
        let b = [pool.pts2[ib].x, pool.pts2[ib].y];
        let eb = [b[0] - a[0], b[1] - a[1]];
        let len2 = eb[0] * eb[0] + eb[1] * eb[1];
        if len2 < 1.0e-18 {
            return;
        }
        let edge_tol = snap_eps * 4.0;
        let mut on_edge: Vec<(f64, usize)> = Vec::new();
        for i in 0..n_pool {
            if i == ia || i == ib {
                continue;
            }
            let p = [pool.pts2[i].x, pool.pts2[i].y];
            let ap = [p[0] - a[0], p[1] - a[1]];
            let tt = (ap[0] * eb[0] + ap[1] * eb[1]) / len2;
            if !(0.0..=1.0).contains(&tt) {
                continue;
            }
            let perp = (ap[0] * eb[1] - ap[1] * eb[0]).abs() / len2.sqrt();
            if perp <= edge_tol {
                on_edge.push((tt, i));
            }
        }
        on_edge.sort_by(|x, y| x.0.total_cmp(&y.0));
        let mut prev = ia;
        for &(_, i) in &on_edge {
            if i != prev {
                seg_list.push((prev, i));
                prev = i;
            }
        }
        if prev != ib {
            seg_list.push((prev, ib));
        }
    };
    let nr = ring_idx.len();
    for e in 0..nr {
        chain(ring_idx[e], ring_idx[(e + 1) % nr], &mut seg_list);
    }
    for ridx in &aux_idx {
        let n = ridx.len();
        for e in 0..n {
            chain(ridx[e], ridx[(e + 1) % n], &mut seg_list);
        }
    }
    seg_list.sort();
    seg_list.dedup();
    resolve_crossings(&mut pool, |q| pf.lift(q[0], q[1], wdepth), &mut seg_list);

    let Some((pts2, idx2)) = triangulate_pslg(&pool.pts2, &seg_list) else {
        return false;
    };
    if pts2.len() != pool.pts2.len() {
        return false;
    }
    for tri in idx2.chunks_exact(3) {
        let (a, b, c) = (tri[0], tri[1], tri[2]);
        let cu = (pts2[a].x + pts2[b].x + pts2[c].x) / 3.0;
        let cv = (pts2[a].y + pts2[b].y + pts2[c].y) / 3.0;
        let Some((desired, flip)) = classify([cu, cv]) else {
            continue;
        };
        // Lift the centroid to 3D for the host-parity test.
        let c3 = scale(
            add(add(pool.pts3[a], pool.pts3[b]), pool.pts3[c]),
            1.0 / 3.0,
        );
        if point_inside(host, aabbs, c3) {
            let (pa, pb, pc) = (pool.pts3[a], pool.pts3[b], pool.pts3[c]);
            emit_cap(caps, pa, pb, pc, desired, flip);
        }
    }
    true
}
