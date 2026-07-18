// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Re-triangulate one face constrained by its intersection segments, via the
//! in-tree deterministic CDT ([`crate::cdt::triangulate_pslg`]).
//!
//! The CDT is fed the face's three corners plus every intersection segment
//! endpoint (deduplicated by exact f64 bits so a segment endpoint shared with a
//! neighbouring face — or another segment — is ONE vertex), and constrained by
//! the three triangle edges plus each intersection segment. `triangulate_pslg`
//! inserts NO Steiner points, so its output vertices are exactly the input
//! points in input order: each output triangle index maps DIRECTLY back to the
//! original f64 3-D coordinate, with no plane-lift rounding — so the seam
//! vertices shared with the cutter faces stay bit-identical (watertight).
//!
//! COLLINEAR CLEANUP: a box side face splits into two triangles, so one hole
//! edge on the host plane arrives as two overlapping/abutting collinear
//! segments. `triangulate_pslg`'s constrained CDT rejects overlapping
//! constraints, so per supporting line we merge the segments into a clean chain
//! (split at every internal endpoint, covered spans only) before triangulating.
//!
//! Winding: `triangulate_pslg` emits CCW in the projected plane; each lifted
//! sub-triangle is oriented to AGREE with the parent face normal (an exact index
//! swap), so the fuzzy output inherits the operand's outward winding.

use super::super::arrangement::Tri;
use super::intersect::Seg;
use super::{dot, sub, tri_normal};
use crate::cdt::triangulate_pslg;
use crate::Point2;
use rustc_hash::FxHashMap;

/// Re-triangulate `face` under its intersection-segment constraints. Returns the
/// resulting sub-triangles (the face itself, verbatim, when there are no
/// constraints — the common fast case), or `None` when the constrained CDT
/// cannot be built (crossing/degenerate constraints) so the caller falls to the
/// exact kernel.
pub(super) fn retriangulate(face: &Tri, segs: &[Seg], edge_pts: &[[f64; 3]]) -> Option<Vec<Tri>> {
    if segs.is_empty() && edge_pts.is_empty() {
        return Some(vec![*face]);
    }
    let n = tri_normal(face);
    let axis = drop_axis(n);
    let face_ext = face.iter().flat_map(|v| v.iter()).fold(1.0f64, |m, &x| m.max(x.abs()));
    let band = super::super::mesh_bridge::near_band_from_extent(face_ext);

    // Deduplicated point set: 3 corners first (indices 0,1,2), then segment
    // endpoints. A `to_bits` key makes a shared endpoint exactly one vertex.
    let mut pts3d: Vec<[f64; 3]> = Vec::with_capacity(3 + segs.len() * 2);
    let mut index: FxHashMap<(u64, u64, u64), usize> = FxHashMap::default();
    let mut intern = |p: [f64; 3], pts3d: &mut Vec<[f64; 3]>| -> usize {
        let k = (p[0].to_bits(), p[1].to_bits(), p[2].to_bits());
        if let Some(&i) = index.get(&k) {
            return i;
        }
        let i = pts3d.len();
        pts3d.push(p);
        index.insert(k, i);
        i
    };
    let c0 = intern(face[0], &mut pts3d);
    let c1 = intern(face[1], &mut pts3d);
    let c2 = intern(face[2], &mut pts3d);

    // Raw constraint index pairs: the three triangle edges + each intersection
    // segment. Collinear cleanup below turns overlapping ones into a clean chain.
    let mut raw: Vec<(usize, usize)> = vec![(c0, c1), (c1, c2), (c2, c0)];
    for &(a, b) in segs {
        let ia = intern(a, &mut pts3d);
        let ib = intern(b, &mut pts3d);
        if ia != ib {
            raw.push((ia, ib));
        }
    }

    // CROSS-FACE T-JUNCTION RESOLUTION: intern any GLOBAL intersection endpoint
    // that lies ON one of this face's three edges (within the snap band) but is
    // not already a vertex. Without this, an opening corner that touches a host-
    // face internal diagonal on ONLY one of the two adjacent triangles splits
    // that diagonal on one side and not the other → an open seam. Injecting the
    // shared (bit-identical) point makes BOTH faces split the shared edge at it.
    let edges3 = [(face[0], face[1]), (face[1], face[2]), (face[2], face[0])];
    for &p in edge_pts {
        if on_any_edge(p, &edges3, band) {
            intern(p, &mut pts3d);
        }
    }

    // Project to 2-D by dropping the dominant-normal axis (non-degenerate since
    // `n` is the face normal and we drop its largest component).
    let pts2d: Vec<Point2<f64>> = pts3d.iter().map(|p| project(*p, axis)).collect();
    let ext = pts2d.iter().fold(1.0f64, |m, p| m.max(p.x.abs()).max(p.y.abs()));
    let segments = clean_collinear(&pts2d, &raw, ext);
    if segments.is_empty() {
        return None;
    }

    let (out_pts, idx) = triangulate_pslg(&pts2d, &segments)?;
    // No Steiner insertion ⇒ output points are the input points in input order.
    // If that invariant is ever violated, indices could reference a point we
    // have no 3-D coordinate for: reject rather than fabricate one.
    if out_pts.len() != pts2d.len() {
        return None;
    }

    let mut tris: Vec<Tri> = Vec::with_capacity(idx.len() / 3);
    for w in idx.chunks_exact(3) {
        let (a, b, c) = (w[0], w[1], w[2]);
        if a >= pts3d.len() || b >= pts3d.len() || c >= pts3d.len() {
            return None;
        }
        let mut t: Tri = [pts3d[a], pts3d[b], pts3d[c]];
        // Orient to agree with the parent face normal (drop zero-area slivers).
        let tn = tri_normal(&t);
        let d = dot(tn, n);
        if d == 0.0 {
            continue; // collinear sub-triangle: no area, no contribution
        }
        if d < 0.0 {
            t.swap(1, 2);
        }
        tris.push(t);
    }
    if tris.is_empty() {
        return None;
    }
    Some(tris)
}

/// Merge constraint segments that share a supporting line into a clean,
/// non-overlapping chain: group by (canonical direction, signed offset), then on
/// each line keep only COVERED spans between consecutive distinct endpoints. The
/// result has no overlapping constraints (which the constrained CDT rejects) yet
/// preserves every vertex, so the seam stays conforming.
fn clean_collinear(pts: &[Point2<f64>], segs: &[(usize, usize)], ext: f64) -> Vec<(usize, usize)> {
    // Snap-scale tolerance: the shared-position snap scatters a point up to
    // ~SNAP_GRID off the line it geometrically lies on, so the collinearity /
    // on-line / overlap tests must admit that band (the kernel's near-coplanar
    // band, widened far from origin) — a 1e-9 tolerance would miss every snapped
    // T-junction vertex (e.g. a hole corner on the triangle diagonal).
    let eps = super::super::mesh_bridge::near_band_from_extent(ext);
    let q = |x: f64| (x / eps).round() as i64;
    // group key → member segment indices
    let mut groups: FxHashMap<(i64, i64, i64), Vec<usize>> = FxHashMap::default();
    for (si, &(a, b)) in segs.iter().enumerate() {
        let (pa, pb) = (pts[a], pts[b]);
        let mut dx = pb.x - pa.x;
        let mut dy = pb.y - pa.y;
        let len = (dx * dx + dy * dy).sqrt();
        if len <= eps {
            continue;
        }
        dx /= len;
        dy /= len;
        // canonical direction sign (so a↔b order doesn't split a line)
        if dx < 0.0 || (dx.abs() <= eps && dy < 0.0) {
            dx = -dx;
            dy = -dy;
        }
        // signed perpendicular offset of the line from the origin
        let off = dx * pa.y - dy * pa.x;
        groups.entry((q(dx), q(dy), q(off))).or_default().push(si);
    }

    let mut out: Vec<(usize, usize)> = Vec::new();
    for members in groups.values() {
        // direction of this line (from its first member, canonicalised)
        let &(fa, fb) = &segs[members[0]];
        let (pa, pb) = (pts[fa], pts[fb]);
        let (mut dx, mut dy) = (pb.x - pa.x, pb.y - pa.y);
        let len = (dx * dx + dy * dy).sqrt();
        dx /= len;
        dy /= len;
        if dx < 0.0 || (dx.abs() <= eps && dy < 0.0) {
            dx = -dx;
            dy = -dy;
        }
        let param = |i: usize| dx * pts[i].x + dy * pts[i].y;
        let off = dx * pa.y - dy * pa.x;
        // covered spans: [min,max] param of each member segment
        let spans: Vec<(f64, f64)> = members
            .iter()
            .map(|&si| {
                let (u, v) = (param(segs[si].0), param(segs[si].1));
                if u <= v {
                    (u, v)
                } else {
                    (v, u)
                }
            })
            .collect();
        let (span_lo, span_hi) = spans.iter().fold((f64::MAX, f64::MIN), |(lo, hi), &(a, b)| {
            (lo.min(a), hi.max(b))
        });
        // Every VERTEX lying on this line within the covered span is a split
        // point — not only the member segments' own endpoints. A constraint that
        // passes through a third vertex (e.g. the triangle diagonal crossing a
        // hole corner) is illegal in the constrained CDT, so it must be split
        // there for the seam to stay conforming (T-junction resolution).
        let mut ends: Vec<usize> = Vec::new();
        for i in 0..pts.len() {
            let on_line = (dx * pts[i].y - dy * pts[i].x - off).abs() <= eps;
            if !on_line {
                continue;
            }
            let p = param(i);
            if p >= span_lo - eps && p <= span_hi + eps && !ends.contains(&i) {
                ends.push(i);
            }
        }
        ends.sort_by(|&x, &y| param(x).partial_cmp(&param(y)).unwrap_or(std::cmp::Ordering::Equal));
        // emit consecutive covered pairs
        for w in ends.windows(2) {
            let (i, j) = (w[0], w[1]);
            if i == j {
                continue;
            }
            let mid = 0.5 * (param(i) + param(j));
            if spans.iter().any(|&(lo, hi)| mid >= lo - eps && mid <= hi + eps) {
                out.push((i, j));
            }
        }
    }
    out
}

/// Does `p` lie strictly interior to any of the three edges, within `band`
/// perpendicular distance? (Endpoints are excluded — they are already vertices.)
fn on_any_edge(p: [f64; 3], edges: &[([f64; 3], [f64; 3]); 3], band: f64) -> bool {
    let band2 = band * band;
    edges.iter().any(|&(a, b)| {
        let ab = sub(b, a);
        let len2 = dot(ab, ab);
        if len2 <= 0.0 {
            return false;
        }
        let t = dot(sub(p, a), ab) / len2;
        if t <= 1.0e-6 || t >= 1.0 - 1.0e-6 {
            return false; // at/near an endpoint, or off the segment span
        }
        let proj = [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]];
        let d = sub(p, proj);
        dot(d, d) <= band2
    })
}

/// Which axis carries the largest |normal| component (the one to drop for a
/// non-degenerate 2-D projection).
fn drop_axis(n: [f64; 3]) -> u8 {
    let a = [n[0].abs(), n[1].abs(), n[2].abs()];
    if a[0] >= a[1] && a[0] >= a[2] {
        0
    } else if a[1] >= a[2] {
        1
    } else {
        2
    }
}

#[inline]
fn project(p: [f64; 3], axis: u8) -> Point2<f64> {
    match axis {
        0 => Point2::new(p[1], p[2]),
        1 => Point2::new(p[0], p[2]),
        _ => Point2::new(p[0], p[1]),
    }
}
