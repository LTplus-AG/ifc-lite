// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cross-bucket seam conforming for `consolidate_coplanar`.
//!
//! `consolidate_coplanar` re-triangulates each coplanar plane bucket independently.
//! Where a bucket's boundary runs along a facet shared with an abutting bucket, its
//! collinear simplify can drop a vertex the neighbour keeps — the shared edge is then
//! spanned by one long edge on one side and two short ones on the other. That is a
//! T-junction, and it renders as a hairline crack.
//!
//! The discrimination this module rests on: a GENUINE seam vertex is a hard corner in
//! the abutting bucket, so it survives that bucket's own simplify and gets recorded
//! here. An i_overlay PHANTOM (a fragment-boundary artefact the simplify exists to
//! remove) is near-collinear in every bucket that touches it, is dropped everywhere,
//! and therefore never becomes an insertion source. The simplify's own judgment,
//! read across buckets, is the discriminator — no geometric proxy for "is this a real
//! corner" is needed.
//!
//! Split out of `consolidate.rs` to keep both files under the module-size ratchet.

use crate::mesh::Mesh;
use nalgebra::{Point3, Vector3};
use rustc_hash::FxHashMap;
use super::{emit_triangle, tri_is_needle};

/// [`count_open_boundary_edges`] on an explicit merge grid. The 1 mm default hides
/// the T-junction the cross-bucket conform targets (a 0.1 mm-scale chord deviation
/// merges away), so the conform's accept/reject decision uses 0.1 mm — the same grid
/// the #098 / #217 measurements are taken on.
pub(super) fn count_open_boundary_edges_at(mesh: &Mesh, scale: f64) -> usize {
    if mesh.positions.len() < 9 || mesh.indices.len() < 3 {
        return 0;
    }
    let q = |v: f32| (v as f64 * scale).round() as i64;
    let mut vid: FxHashMap<(i64, i64, i64), u32> = FxHashMap::default();
    let mut id_of = |i: usize| -> u32 {
        let k = (
            q(mesh.positions[i * 3]),
            q(mesh.positions[i * 3 + 1]),
            q(mesh.positions[i * 3 + 2]),
        );
        let next = vid.len() as u32;
        *vid.entry(k).or_insert(next)
    };
    let mut bal: FxHashMap<(u32, u32), i32> = FxHashMap::default();
    for tri in mesh.indices.chunks_exact(3) {
        let (a, b, c) = (
            id_of(tri[0] as usize),
            id_of(tri[1] as usize),
            id_of(tri[2] as usize),
        );
        for (x, y) in [(a, b), (b, c), (c, a)] {
            let (key, s) = if x < y { ((x, y), 1) } else { ((y, x), -1) };
            *bal.entry(key).or_insert(0) += s;
        }
    }
    bal.values().filter(|&&v| v != 0).count()
}


/// Perpendicular / endpoint tolerance for the cross-bucket conform (0.1 mm) — the
/// same 0.1 mm as the seam-vertex quantisation, and two orders below the smallest
/// real facet width we ever conform against.
pub(super) const CONFORM_TOL: f64 = 1.0e-4;

/// A ring vertex that survived `weld_near_coincident_2d` + `simplify_2d_collinear`
/// in at least one plane bucket, keyed by its 0.1 mm-quantised position.
///
/// `buckets`/`first` answer the only question that separates the two cases the
/// simplify conflates: did some bucket OTHER than this one keep this position as a
/// hard corner? A genuine seam vertex is a corner in the abutting bucket (on
/// dental_clinic #217 the four peers keep it at sin = 1.00), so it is recorded; an
/// i_overlay phantom is near-collinear in EVERY bucket that touches it, so it is
/// dropped everywhere and never becomes an insertion source.
pub(super) struct SeamVert {
    /// First 3D position seen at this key — inserted verbatim, so the lift lands
    /// exactly on the peer bucket's vertex rather than on a dequantised cell centre.
    pos: Point3<f64>,
    buckets: u32,
    first: u32,
    last: u32,
}

pub(super) type SeamMap = std::collections::BTreeMap<(i64, i64, i64), SeamVert>;

/// Record `p` as kept by bucket `bid`. Buckets are visited in order, so `last`
/// dedupes repeats inside one bucket without a per-position set. BTreeMap keeps the
/// whole pass target-independent (native == wasm), like the bucket map itself.
pub(super) fn record_seam_vert(map: &mut SeamMap, bid: u32, p: Point3<f64>) {
    let key = (
        (p.x * 1.0e4).round() as i64,
        (p.y * 1.0e4).round() as i64,
        (p.z * 1.0e4).round() as i64,
    );
    match map.get_mut(&key) {
        Some(e) => {
            if e.last != bid {
                e.buckets += 1;
                e.last = bid;
            }
        }
        None => {
            map.insert(
                key,
                SeamVert {
                    pos: p,
                    buckets: 1,
                    first: bid,
                    last: bid,
                },
            );
        }
    }
}

/// Insert every candidate that lies STRICTLY INTERIOR to one of `ring`'s edges
/// (within `CONFORM_TOL` perpendicular) into that edge, ordered along it. Returns
/// whether anything moved.
///
/// Conforming by ADDITION is the point: it cannot defeat the phantom merge
/// `simplify_2d_collinear` exists to perform (blanket retention did), it only puts
/// back the boundary vertices an abutting bucket still has.
pub(super) fn conform_ring(ring: &mut Vec<nalgebra::Point2<f64>>, cands: &[nalgebra::Point2<f64>]) -> bool {
    let n = ring.len();
    if n < 3 || cands.is_empty() {
        return false;
    }
    let mut out: Vec<nalgebra::Point2<f64>> = Vec::with_capacity(n + cands.len());
    let mut inserted = false;
    let mut hits: Vec<(f64, nalgebra::Point2<f64>)> = Vec::new();
    for i in 0..n {
        let a = ring[i];
        let b = ring[(i + 1) % n];
        out.push(a);
        let (ex, ey) = (b.x - a.x, b.y - a.y);
        let len2 = ex * ex + ey * ey;
        if len2 <= 0.0 {
            continue;
        }
        let len = len2.sqrt();
        hits.clear();
        for &q in cands {
            let (dx, dy) = (q.x - a.x, q.y - a.y);
            let t = (dx * ex + dy * ey) / len2;
            // strictly interior — a candidate at an endpoint is already in the ring
            if t * len <= CONFORM_TOL || (1.0 - t) * len <= CONFORM_TOL {
                continue;
            }
            if (dx * ey - dy * ex).abs() / len > CONFORM_TOL {
                continue;
            }
            hits.push((t, q));
        }
        if hits.is_empty() {
            continue;
        }
        hits.sort_by(|x, y| x.0.total_cmp(&y.0));
        let mut last_t = f64::NEG_INFINITY;
        for &(t, q) in hits.iter() {
            // Two seam verts can land in adjacent quantisation cells; inserting both
            // would leave a sub-0.1 mm pair that the needle backstop then drops,
            // re-opening the very edge we are conforming.
            if (t - last_t) * len <= CONFORM_TOL {
                continue;
            }
            out.push(q);
            last_t = t;
            inserted = true;
        }
    }
    if inserted {
        *ring = out;
    }
    inserted
}

/// One union region of one plane bucket: the simplified rings, plus the
/// cross-bucket-conformed copies phase B fills in.
pub(super) struct PlanRegion {
    pub(super) outer: Vec<nalgebra::Point2<f64>>,
    pub(super) holes: Vec<Vec<nalgebra::Point2<f64>>>,
    pub(super) outer_conformed: Vec<nalgebra::Point2<f64>>,
    pub(super) holes_conformed: Vec<Vec<nalgebra::Point2<f64>>>,
}

/// One plane bucket after phase A: its 2D basis, the triangles that bypass the
/// union round-trip (single-triangle bucket / union collapse), and its regions.
pub(super) struct PlanBucket {
    pub(super) bid: u32,
    pub(super) normal: Vector3<f64>,
    pub(super) origin: Point3<f64>,
    pub(super) u_axis: Vector3<f64>,
    pub(super) v_axis: Vector3<f64>,
    pub(super) raw: Vec<[Point3<f64>; 3]>,
    pub(super) regions: Vec<PlanRegion>,
}

/// Phase B — for every bucket, insert into its rings the seam vertices that some
/// OTHER bucket kept, that lie on THIS bucket's plane, and that fall strictly inside
/// one of its ring edges. Returns whether any ring changed.
///
/// The plane test is the strong filter — only positions landing exactly on this
/// bucket's plane survive it — so the per-bucket scan of `seam` stays cheap. That
/// prefilter is what the earlier post-hoc conforming attempts (run outside the bucket
/// structure, in `tris_to_mesh` and after consolidation) could not have.
pub(super) fn conform_plans(plans: &mut [PlanBucket], seam: &SeamMap) -> bool {
    let mut changed = false;
    for plan in plans.iter_mut() {
        if plan.regions.is_empty() {
            continue;
        }
        let (mut minx, mut miny, mut maxx, mut maxy) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for r in &plan.regions {
            for p in r.outer.iter().chain(r.holes.iter().flatten()) {
                minx = minx.min(p.x);
                miny = miny.min(p.y);
                maxx = maxx.max(p.x);
                maxy = maxy.max(p.y);
            }
        }
        let mut cands: Vec<nalgebra::Point2<f64>> = Vec::new();
        for sv in seam.values() {
            // "kept by some bucket OTHER than this one" — the asymmetry signal.
            if sv.buckets < 2 && sv.first == plan.bid {
                continue;
            }
            let d = sv.pos - plan.origin;
            if plan.normal.dot(&d).abs() > 1.0e-5 {
                continue;
            }
            let (x, y) = (d.dot(&plan.u_axis), d.dot(&plan.v_axis));
            if x < minx - CONFORM_TOL
                || x > maxx + CONFORM_TOL
                || y < miny - CONFORM_TOL
                || y > maxy + CONFORM_TOL
            {
                continue;
            }
            cands.push(nalgebra::Point2::new(x, y));
        }
        if cands.is_empty() {
            continue;
        }
        for region in plan.regions.iter_mut() {
            // A candidate this region ALREADY carries must not be re-inserted: a
            // duplicate ring vertex fails the CDT and would drop the whole region.
            let local: Vec<nalgebra::Point2<f64>> = cands
                .iter()
                .copied()
                .filter(|q| {
                    !region
                        .outer
                        .iter()
                        .chain(region.holes.iter().flatten())
                        .any(|p| {
                            (p.x - q.x).abs() <= CONFORM_TOL && (p.y - q.y).abs() <= CONFORM_TOL
                        })
                })
                .collect();
            if local.is_empty() {
                continue;
            }
            changed |= conform_ring(&mut region.outer_conformed, &local);
            for hole in region.holes_conformed.iter_mut() {
                changed |= conform_ring(hole, &local);
            }
        }
    }
    changed
}

/// Phase C — triangulate the (optionally conformed) rings and emit, in bucket order.
pub(super) fn emit_plans(plans: &[PlanBucket], conformed: bool) -> Mesh {
    use crate::triangulation::triangulate_polygon_with_holes_refined;
    let mut output = Mesh::new();
    for plan in plans {
        for t in &plan.raw {
            emit_triangle(&mut output, t, &plan.normal);
        }
        for region in &plan.regions {
            let (outer, holes) = if conformed {
                (&region.outer_conformed, &region.holes_conformed)
            } else {
                (&region.outer, &region.holes)
            };
            // Quality CDT + bounded Ruppert refinement. Returns the
            // (possibly Steiner-augmented) 2D vertex list `all_2d` plus
            // indices into it; the lift below maps EVERY returned vertex
            // (input + Steiner) back to 3D, so a Steiner point on a shared
            // edge is split on both sides → watertight, no T-junction.
            // Refinement is interior-only: this region's outer/hole rings
            // are shared with neighbouring plane buckets triangulated
            // independently; a boundary Steiner point would tear that seam
            // (open edges / T-junctions). Interior-only refinement keeps the
            // seam watertight while still removing the rim-corner slivers.
            let (all_2d, indices) = match triangulate_polygon_with_holes_refined(outer, holes) {
                Ok((pts, idx)) => (pts, idx),
                Err(_) => continue,
            };
            let verts_3d: Vec<Point3<f64>> = all_2d
                .iter()
                .map(|p| plan.origin + plan.u_axis * p.x + plan.v_axis * p.y)
                .collect();
            let base = output.vertex_count() as u32;
            for vp in &verts_3d {
                output.add_vertex(*vp, plan.normal);
            }
            for tri in indices.chunks_exact(3) {
                // Needle backstop: drop any residual sub-weld degenerate sliver
                // ([`tri_is_needle`], the same scale-relative power-of-two rule
                // as the single-triangle path). Cannot open a real gap — the
                // hole/seam is framed by its non-degenerate neighbours.
                let v = [verts_3d[tri[0]], verts_3d[tri[1]], verts_3d[tri[2]]];
                if tri_is_needle(&v) {
                    continue;
                }
                output.add_triangle(
                    base + tri[0] as u32,
                    base + tri[1] as u32,
                    base + tri[2] as u32,
                );
            }
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conform_ring_inserts_only_interior_on_edge_candidates() {
        use nalgebra::Point2;
        let square = vec![
            Point2::new(0.0, 0.0),
            Point2::new(2.0, 0.0),
            Point2::new(2.0, 2.0),
            Point2::new(0.0, 2.0),
        ];
        // A peer's seam vertex at the middle of the bottom edge — the chorded-seam
        // case — goes in, in edge order.
        let mut ring = square.clone();
        assert!(conform_ring(&mut ring, &[Point2::new(1.0, 0.0)]));
        assert_eq!(ring.len(), 5);
        assert_eq!(ring[1], Point2::new(1.0, 0.0));
        // Off the boundary (interior), past the boundary, and AT a corner: all no-ops.
        for q in [
            Point2::new(1.0, 1.0),
            Point2::new(3.0, 0.0),
            Point2::new(2.0, 0.0),
        ] {
            let mut ring = square.clone();
            assert!(!conform_ring(&mut ring, &[q]), "wrongly inserted {q:?}");
            assert_eq!(ring.len(), 4);
        }
        // Two candidates 0.05 mm apart (adjacent quantisation cells) must not both
        // land — the pair would be a sub-weld needle that gets dropped again.
        let mut ring = square.clone();
        assert!(conform_ring(
            &mut ring,
            &[Point2::new(1.0, 0.0), Point2::new(1.000_05, 0.0)]
        ));
        assert_eq!(ring.len(), 5);
    }
}
