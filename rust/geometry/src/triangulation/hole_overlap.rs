// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Hole-ring hygiene for [`super::safe_earcut`] (#7787).
//!
//! earcutr bridges every hole into the outer ring, and its cost is superlinear
//! when hole rings coincide or overlap: `IfcArbitraryProfileDefWithVoids` can
//! list one `IfcCircle` N times at about 4 bytes per void, and 200 of them
//! stalled one cap for 10 to 26 s (minutes at 1000). Holes may not overlap in
//! IFC, so this is invalid input, and every cap that triangulates profile holes
//! reaches it through the one `safe_earcut`:
//!
//! - an exact duplicate of another hole ring adds no information and is
//!   dropped (the same opening listed twice is one opening);
//! - holes whose areas overlap, or nest, have no safe interpretation and the
//!   cap is REFUSED (D3, an `Err` every caller already counts as a failed
//!   item) rather than rendered as garbage;
//! - the pairwise work is bounded by [`HOLE_PAIR_WORK_BUDGET`], so a hostile
//!   set of bounding-box-overlapping but disjoint holes fails closed instead of
//!   running quadratically. Disjoint holes on a grid never come near it.

use super::ring_geom::{point_in_ring, ring_bbox};
use rustc_hash::FxHashSet;

/// Work (examined bbox pairs, plus edge-pair and point-in-ring tests near each
/// pair's box overlap) spent on one cap's holes before it is refused: a base
/// plus a share per hole vertex, so it grows with the input linearly and only
/// superlinear sets are refused. A 5,000-hole hex-staggered perforated plate
/// of 64-gon circles at pitch 2.05 r spends about 100 units per vertex.
pub(super) fn hole_work_budget(hole_vertices: usize) -> u64 {
    HOLE_PAIR_WORK_BASE.saturating_add((hole_vertices as u64).saturating_mul(1024))
}

/// The constant part of [`hole_work_budget`].
pub(super) const HOLE_PAIR_WORK_BASE: u64 = 1 << 22;

/// Relative tolerance for "on the boundary" / "properly crossing", scaled by
/// the pair's bounding-box diagonal. Rings that merely touch (a shared edge
/// or vertex, authored in floating point) are not overlapping; authored
/// coordinates often round-trip through f32 (~6e-8 relative), so a shared
/// edge can overlap by that much and must still count as touching.
const TOUCH_TOLERANCE: f64 = 1e-6;

/// Drop duplicate rings from `holes` (indices into `rings`) and refuse the
/// set if two remaining rings overlap or the work `budget` runs out.
pub(super) fn settle_holes(
    rings: &[&[f64]],
    holes: &mut Vec<usize>,
    budget: u64,
) -> Result<(), String> {
    if holes.len() < 2 {
        return Ok(());
    }
    let mut seen: FxHashSet<Vec<u64>> = FxHashSet::default();
    holes.retain(|&h| seen.insert(canonical_key(rings[h])));
    if holes.len() < 2 {
        return Ok(());
    }

    let boxes: Vec<(f64, f64, f64, f64)> = holes.iter().map(|&h| ring_bbox(rings[h])).collect();
    let mut order: Vec<usize> = (0..holes.len()).collect();
    order.sort_by(|&a, &b| boxes[a].0.total_cmp(&boxes[b].0).then(a.cmp(&b)));

    let mut work: u64 = 0;
    for (pos, &i) in order.iter().enumerate() {
        for &j in &order[pos + 1..] {
            if boxes[j].0 > boxes[i].2 {
                break;
            }
            work += 1;
            if work > budget {
                return Err("profile holes exceed the overlap-check work budget".to_string());
            }
            if boxes[j].1 > boxes[i].3 || boxes[i].1 > boxes[j].3 {
                continue;
            }
            let (a, b) = (rings[holes[i]], rings[holes[j]]);
            let (overlap, spent) = rings_overlap(a, b, &boxes[i], &boxes[j]);
            work = work.saturating_add(spent);
            if work > budget {
                return Err("profile holes exceed the overlap-check work budget".to_string());
            }
            if overlap {
                return Err("profile holes overlap; refusing the cap (D3)".to_string());
            }
        }
    }
    Ok(())
}

/// Start- and direction-independent identity of a ring: bit patterns of its
/// vertices rotated to the smallest vertex, in the smaller of the two
/// directions. `-0.0` and `+0.0` are one coordinate.
fn canonical_key(ring: &[f64]) -> Vec<u64> {
    let n = ring.len() / 2;
    let bits = |v: usize| [(ring[v * 2] + 0.0).to_bits(), (ring[v * 2 + 1] + 0.0).to_bits()];
    let key = |v: usize| (ring[v * 2] + 0.0, ring[v * 2 + 1] + 0.0);
    let start = (0..n)
        .min_by(|&a, &b| key(a).0.total_cmp(&key(b).0).then(key(a).1.total_cmp(&key(b).1)))
        .unwrap_or(0);
    let walk = |step: usize| -> Vec<u64> {
        (0..n).flat_map(|k| bits((start + k * step) % n)).collect()
    };
    let (fwd, bwd) = (walk(1), walk(n - 1));
    fwd.min(bwd)
}

/// Whether two hole rings overlap, and the work spent finding out. Only the
/// edges and sample points inside the pair's bounding-box overlap (grown by
/// the touch tolerance) can cross or be inside the other ring, so the cost is
/// proportional to what is near the overlap, not `|a| * |b|`: neighbouring
/// circles of a perforated plate overlap only at a box corner.
fn rings_overlap(
    a: &[f64],
    b: &[f64],
    ba: &(f64, f64, f64, f64),
    bb: &(f64, f64, f64, f64),
) -> (bool, u64) {
    let diag = (ba.2.max(bb.2) - ba.0.min(bb.0)).hypot(ba.3.max(bb.3) - ba.1.min(bb.1));
    let eps = TOUCH_TOLERANCE * diag.max(f64::MIN_POSITIVE);
    let rect = (ba.0.max(bb.0) - eps, ba.1.max(bb.1) - eps, ba.2.min(bb.2) + eps, ba.3.min(bb.3) + eps);
    let near = |ring: &[f64]| -> Vec<usize> {
        (0..ring.len() / 2)
            .filter(|&k| {
                let (p, q) = edge(ring, k);
                p[0].max(q[0]) >= rect.0
                    && p[0].min(q[0]) <= rect.2
                    && p[1].max(q[1]) >= rect.1
                    && p[1].min(q[1]) <= rect.3
            })
            .collect()
    };
    let (ea, eb) = (near(a), near(b));
    let mut spent = (a.len() / 2 + b.len() / 2) as u64 + ea.len() as u64 * eb.len() as u64;
    let overlap = edges_cross(a, &ea, b, &eb, eps)
        || interior_sample_inside(a, &ea, b, bb, eps, &mut spent)
        || interior_sample_inside(b, &eb, a, ba, eps, &mut spent);
    (overlap, spent)
}

fn edge(ring: &[f64], k: usize) -> ([f64; 2], [f64; 2]) {
    let n = ring.len() / 2;
    let (p, q) = (k, (k + 1) % n);
    ([ring[p * 2], ring[p * 2 + 1]], [ring[q * 2], ring[q * 2 + 1]])
}

/// Signed distance of `p` from the line through `a` and `b` (0 for a point edge).
fn side(a: [f64; 2], b: [f64; 2], p: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len = dx.hypot(dy);
    if len == 0.0 {
        return 0.0;
    }
    (dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / len
}

/// Some edge `ea` of `a` properly crosses some edge `eb` of `b` (endpoints
/// strictly on opposite sides of each other, beyond `eps`).
fn edges_cross(a: &[f64], ea: &[usize], b: &[f64], eb: &[usize], eps: f64) -> bool {
    ea.iter().any(|&i| {
        let (a0, a1) = edge(a, i);
        eb.iter().any(|&j| {
            let (b0, b1) = edge(b, j);
            let (d0, d1) = (side(a0, a1, b0), side(a0, a1, b1));
            let (e0, e1) = (side(b0, b1, a0), side(b0, b1, a1));
            (d0 > eps && d1 < -eps || d0 < -eps && d1 > eps)
                && (e0 > eps && e1 < -eps || e0 < -eps && e1 > eps)
        })
    })
}

/// A vertex or an edge midpoint of `ring` (from its edges `near`, the only
/// ones that reach `other`'s box) lies strictly inside `other` (inside and
/// farther than `eps` from its boundary). Midpoints catch containment where
/// every vertex of `ring` sits on `other`'s boundary.
fn interior_sample_inside(
    ring: &[f64],
    near: &[usize],
    other: &[f64],
    other_box: &(f64, f64, f64, f64),
    eps: f64,
    spent: &mut u64,
) -> bool {
    near.iter().any(|&k| {
        let (p, q) = edge(ring, k);
        [p, [(p[0] + q[0]) / 2.0, (p[1] + q[1]) / 2.0]].into_iter().any(|s| {
            s[0] > other_box.0
                && s[0] < other_box.2
                && s[1] > other_box.1
                && s[1] < other_box.3
                && {
                    *spent += 2 * (other.len() / 2) as u64; // ring walk + boundary walk
                    true
                }
                && point_in_ring(s[0], s[1], other)
                && !near_boundary(s, other, eps)
        })
    })
}

fn near_boundary(p: [f64; 2], ring: &[f64], eps: f64) -> bool {
    (0..ring.len() / 2).any(|k| {
        let (a, b) = edge(ring, k);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let len2 = dx * dx + dy * dy;
        let t = if len2 == 0.0 {
            0.0
        } else {
            (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0)
        };
        (p[0] - (a[0] + t * dx)).hypot(p[1] - (a[1] + t * dy)) <= eps
    })
}
