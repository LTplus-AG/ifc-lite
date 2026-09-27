// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Close the hairline T-junction seams an accepted analytic cut can keep (#5739).
//!
//! The emit gate accepts a cut whose unmatched edges are covered collinearly by
//! reverse edges: two faces subdividing one boundary line differently. On a
//! plan-rotated wall stored in a per-element local frame, up to 64 such edges
//! survived: vertices a few world f32 ulps apart that the cut's weld, sized by
//! the small stored coordinates, left unmerged, plus T-junctions along the
//! seam. This pass re-welds at the world quantum, then splits each open edge
//! at the open-edge endpoints that lie on it, which makes the two subdivisions
//! agree. It adds no vertices. It is attempted only on a cut that is still
//! open, and kept only if it closes that cut strictly with its volume kept.

use super::super::frame_snap::closed_and_consistently_wound;
use super::super::geom::mesh_signed_volume;
use super::vertex_dedup::{dedup_cut_vertices_within, weld_tolerance};
use super::Mesh;
use rustc_hash::FxHashMap;

type Key = [i64; 3];

/// The 0.1 mm lattice the closure audits key on.
fn key(p: [f64; 3]) -> Key {
    p.map(|c| (c * 1.0e4).round() as i64)
}

/// `cut` re-welded at the world quantum and with its T-junctions split, or
/// `None` when that does not leave it strictly closed with its volume kept.
pub(super) fn close_seams(cut: &Mesh, host: &Mesh) -> Option<Mesh> {
    let welded = dedup_cut_vertices_within(cut, host, true);
    let tol = weld_tolerance(&welded, host, &vec![true; welded.positions.len() / 3], true);
    let closed = close_t_junctions(&welded, tol)?;
    // The split moves nothing; the weld moves each vertex by at most `tol`, so
    // the enclosed volume can move by at most `tol` times the surface area.
    let (before, after) = (mesh_signed_volume(cut), mesh_signed_volume(&closed));
    ((after - before).abs() <= tol * surface_area(cut)).then_some(closed)
}

/// `cut` with its open edges split at the collinear open-edge endpoints within
/// `tol`, or `None` when that does not leave it strictly closed.
fn close_t_junctions(cut: &Mesh, tol: f64) -> Option<Mesh> {
    let vc = cut.positions.len() / 3;
    let pos = |i: u32| -> [f64; 3] {
        let b = i as usize * 3;
        [cut.positions[b] as f64, cut.positions[b + 1] as f64, cut.positions[b + 2] as f64]
    };
    if cut.indices.iter().any(|&i| i as usize >= vc) {
        return None;
    }
    let mut balance: FxHashMap<(Key, Key), i64> = FxHashMap::default();
    for t in cut.indices.chunks_exact(3) {
        for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            let (ka, kb) = (key(pos(a)), key(pos(b)));
            if ka != kb {
                *balance.entry((ka, kb)).or_insert(0) += 1;
                *balance.entry((kb, ka)).or_insert(0) -= 1;
            }
        }
    }
    let open = |a: u32, b: u32| {
        let (ka, kb) = (key(pos(a)), key(pos(b)));
        ka != kb && balance.get(&(ka, kb)).is_some_and(|&c| c != 0)
    };
    // Candidate split points: every endpoint of an open edge, in index order.
    let mut candidates: Vec<u32> = Vec::new();
    for t in cut.indices.chunks_exact(3) {
        for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            if open(a, b) {
                candidates.extend([a, b]);
            }
        }
    }
    if candidates.is_empty() {
        return None;
    }
    candidates.sort_unstable();
    candidates.dedup();

    let mut indices = Vec::with_capacity(cut.indices.len() + 16);
    let mut changed = false;
    for t in cut.indices.chunks_exact(3) {
        let mut ring: Vec<u32> = Vec::with_capacity(6);
        let mut split_edges = [false; 3];
        for (e, (a, b)) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])].into_iter().enumerate() {
            ring.push(a);
            if !open(a, b) {
                continue;
            }
            let (pa, pb) = (pos(a), pos(b));
            let (ka, kb) = (key(pa), key(pb));
            let ab = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
            let len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
            let len = len2.sqrt();
            let mut hits: Vec<(f64, u32)> = Vec::new();
            for &q in &candidates {
                let pq = pos(q);
                let kq = key(pq);
                if kq == ka || kq == kb {
                    continue;
                }
                let aq = [pq[0] - pa[0], pq[1] - pa[1], pq[2] - pa[2]];
                let s = (aq[0] * ab[0] + aq[1] * ab[1] + aq[2] * ab[2]) / len2;
                if s * len <= tol || (1.0 - s) * len <= tol {
                    continue;
                }
                let off = [pa[0] + s * ab[0] - pq[0], pa[1] + s * ab[1] - pq[1], pa[2] + s * ab[2] - pq[2]];
                if off[0] * off[0] + off[1] * off[1] + off[2] * off[2] > tol * tol {
                    continue;
                }
                hits.push((s, q));
            }
            // Deterministic: by position along the edge, then by index.
            hits.sort_by(|x, y| x.0.total_cmp(&y.0).then(x.1.cmp(&y.1)));
            hits.dedup_by(|x, y| key(pos(x.1)) == key(pos(y.1)));
            if !hits.is_empty() {
                split_edges[e] = true;
                ring.extend(hits.into_iter().map(|(_, q)| q));
            }
        }
        if !split_edges.contains(&true) {
            indices.extend_from_slice(t);
            continue;
        }
        // Fan from the corner whose two incident edges are both unsplit: every
        // fan triangle then spans a split edge's sub-segment and that corner, so
        // none is degenerate. Two or more split edges have no such corner.
        let apex_corner = (0..3).find(|&c| !split_edges[c] && !split_edges[(c + 2) % 3])?;
        let apex = ring.iter().position(|&v| v == t[apex_corner])?;
        let n = ring.len();
        for k in 1..n - 1 {
            indices.extend_from_slice(&[ring[apex], ring[(apex + k) % n], ring[(apex + k + 1) % n]]);
        }
        changed = true;
    }
    if !changed {
        return None;
    }
    let mut closed = cut.clone();
    closed.indices = indices;
    // Per-triangle plane tags no longer line up with the new index buffer.
    closed.plane_tags = None;
    closed_and_consistently_wound(&closed).then_some(closed)
}

fn surface_area(mesh: &Mesh) -> f64 {
    let p = |i: u32| {
        let b = i as usize * 3;
        [mesh.positions[b] as f64, mesh.positions[b + 1] as f64, mesh.positions[b + 2] as f64]
    };
    mesh.indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
            let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
            0.5 * (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt()
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use nalgebra::{Point3, Vector3};

    /// A tetrahedron whose face A-B-D is split at M, the midpoint of A-B, while
    /// the face across A-B is not: one T-junction, 2 open directed edges.
    fn t_junction_tetrahedron(far: f64) -> Mesh {
        let mut mesh = Mesh::new();
        let (a, b, c, d) = ([far, 0.0, 0.0], [far + 1.0, 0.0, 0.0], [far, 1.0, 0.0], [far, 0.0, 1.0]);
        let m = [far + 0.5, 0.0, 0.0];
        for p in [a, b, c, d, m] {
            mesh.add_vertex(Point3::new(p[0], p[1], p[2]), Vector3::zeros());
        }
        let (a, b, c, d, m) = (0, 1, 2, 3, 4);
        for t in [[a, c, b], [a, m, d], [m, b, d], [b, c, d], [a, d, c]] {
            mesh.add_triangle(t[0], t[1], t[2]);
        }
        mesh
    }

    #[test]
    fn t_junction_is_split_and_the_cut_closes_5739() {
        let cut = t_junction_tetrahedron(0.0);
        assert!(!closed_and_consistently_wound(&cut), "premise: the T-junction leaves it open");
        let closed = close_seams(&cut, &cut).expect("the seam closes");
        assert!(closed_and_consistently_wound(&closed));
        assert_eq!(closed.positions, cut.positions, "no vertex moves or is added");
        assert_eq!(closed.triangle_count(), cut.triangle_count() + 1);
    }

    #[test]
    fn a_missing_face_is_not_papered_over_5739() {
        let mut cut = t_junction_tetrahedron(0.0);
        cut.indices.truncate(cut.indices.len() - 3);
        assert!(close_seams(&cut, &cut).is_none(), "a hole is not a seam");
    }
}
