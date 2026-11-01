// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The cap CDT: pool the face ring, auxiliary rings and seams, run the
//! conforming CDT, and emit each kept sub-triangle with the result
//! orientation. Also holds what both CDTs share: making a constraint soup
//! CDT-admissible by splitting crossing constraints and constraints through
//! pooled points, and the tolerance-merging 2D point pool.

use super::extension::point_inside;
use super::face::Seam;
use super::frame::PrismFrame;
use super::kit::{add, dot, scale, V2, V3};
use super::ptri::PTri;
use crate::cdt::triangulate_pslg;
use nalgebra::Point2;
use rustc_hash::FxHashMap;

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

/// 2D point pool with tolerance merging: canonical 3D/normal = first-seen.
/// Merging kills the 1e-12 doublets a cutter-edge junction produces when two
/// faces' clips compute the same geometric point through different arithmetic.
pub(super) struct PointPool {
    pub(super) pts2: Vec<Point2<f64>>,
    pub(super) pts3: Vec<V3>,
    pub(super) nrm: Vec<V3>,
    pub(super) buckets: FxHashMap<(i64, i64), Vec<usize>>,
    pub(super) eps: f64,
}

impl PointPool {
    pub(super) fn new(eps: f64) -> Self {
        Self {
            pts2: Vec::new(),
            pts3: Vec::new(),
            nrm: Vec::new(),
            buckets: FxHashMap::default(),
            eps: eps.max(1.0e-15),
        }
    }
    pub(super) fn intern(&mut self, q: V2, p3: V3, n: V3) -> usize {
        let cell = |x: f64| (x / (self.eps * 4.0)).floor() as i64;
        let (cx, cy) = (cell(q[0]), cell(q[1]));
        for dx in -1..=1 {
            for dy in -1..=1 {
                if let Some(ids) = self.buckets.get(&(cx + dx, cy + dy)) {
                    for &i in ids {
                        let d0 = self.pts2[i].x - q[0];
                        let d1 = self.pts2[i].y - q[1];
                        if d0.abs() <= self.eps && d1.abs() <= self.eps {
                            return i;
                        }
                    }
                }
            }
        }
        let idx = self.pts2.len();
        self.pts2.push(Point2::new(q[0], q[1]));
        self.pts3.push(p3);
        self.nrm.push(n);
        self.buckets.entry((cx, cy)).or_default().push(idx);
        idx
    }
}
