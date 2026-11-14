// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Put back ring vertices the rim weld merged away when an abutting bucket
//! still has them.
//!
//! `weld_near_coincident_2d` merges a vertex onto its kept predecessor from up
//! to 244 um away, and which of the pair is "the predecessor" depends on the
//! direction the ring is walked. The two caps of a prism walk the same rim in
//! opposite directions, so across a 218 um facet of a tessellated arc one cap
//! keeps the facet's first corner and the other its second, while the side
//! buckets keep both (#8190 slab #12381). When the vertex a cap lost is a real
//! corner, it lies off the cap's welded edge by more than `CONFORM_TOL`:
//! `conform_ring` cannot insert it and `snap_near_duplicates` cannot reach it,
//! and the cap stays open across a triangle 218 um wide.

use super::conform_ring;
use crate::csg::consolidate::ring_ops::{within_conform_tol as near, Welded};
use nalgebra::Point2;

/// Reinsert each vertex of `welded` that some candidate still marks, next to
/// the vertex it was merged onto and on the side it came from, at the
/// candidate's position. Returns whether anything was inserted.
///
/// A vertex is left out when its kept neighbour is no longer in `ring` (the
/// collinear simplify removed it) or is there twice (a ring pinched at it),
/// when the ring already has a vertex within `CONFORM_TOL` of the candidate,
/// or when the candidate lies on one of the ring's edges, where `conform_ring`
/// inserts it afterwards: put back here as well it would be in the ring twice.
pub(super) fn restore_welded(
    ring: &mut Vec<Point2<f64>>,
    welded: &[Welded],
    cands: &[Point2<f64>],
) -> bool {
    let len = ring.len();
    // In reverse, so several vertices merged onto one kept vertex come back in
    // their ring order: each lands directly after it, ahead of the later ones.
    for gone in welded.iter().rev() {
        let off = |q: &Point2<f64>| (q - gone.dropped).norm_squared();
        let nearest = cands.iter().filter(|&&q| near(q, gone.dropped));
        let Some(&q) = nearest.min_by(|a, b| off(a).total_cmp(&off(b))) else { continue };
        if ring.iter().any(|&p| near(p, q)) {
            continue;
        }
        let mut anchors = ring.iter().enumerate().filter(|&(_, &p)| p == gone.kept);
        let (Some((at, _)), None) = (anchors.next(), anchors.next()) else { continue };
        if conform_ring(&mut ring.clone(), &[q]) {
            continue;
        }
        ring.insert(if gone.before { at } else { at + 1 }, q);
    }
    ring.len() != len
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: f64, y: f64) -> Point2<f64> {
        Point2::new(x, y)
    }

    /// The #8190 corner: the rim turns at P and runs 218 um to Q. The cap
    /// that kept Q gets P back between Q and the far end of the side facet.
    #[test]
    fn puts_a_welded_corner_back_after_its_kept_neighbour() {
        let (q, corner) = (p(0.0, 0.0), p(0.0, -2.18e-4));
        let mut ring = vec![p(1.0, 1.0), q, p(-1.0, -2.18e-4), p(-1.0, 1.0)];
        let welded = [Welded { kept: q, dropped: corner, before: false }];
        let seam = p(1.0e-9, -2.18e-4);
        assert!(restore_welded(&mut ring, &welded, &[seam]));
        assert_eq!(ring, vec![p(1.0, 1.0), q, seam, p(-1.0, -2.18e-4), p(-1.0, 1.0)]);
    }

    #[test]
    fn keeps_ring_order_for_two_vertices_merged_onto_one_and_for_the_closing_merge() {
        let (k, d1, d2, last) = (p(0.0, 0.0), p(1.5e-4, 0.0), p(1.5e-4, 1.5e-4), p(-1.5e-4, 0.0));
        let mut ring = vec![k, p(1.0, -1.0), p(1.0, 1.0), p(-1.0, 1.0)];
        let welded = [
            Welded { kept: k, dropped: d1, before: false },
            Welded { kept: k, dropped: d2, before: false },
            Welded { kept: k, dropped: last, before: true },
        ];
        assert!(restore_welded(&mut ring, &welded, &[d1, d2, last]));
        assert_eq!(ring, vec![last, k, d1, d2, p(1.0, -1.0), p(1.0, 1.0), p(-1.0, 1.0)]);
    }

    #[test]
    fn leaves_the_ring_alone_without_a_peer_or_a_kept_neighbour() {
        let (k, d) = (p(0.0, 0.0), p(2.0e-4, 0.0));
        let welded = [Welded { kept: k, dropped: d, before: false }];
        let square = vec![k, p(1.0, 0.0), p(1.0, 1.0), p(0.0, 1.0)];
        let mut ring = square.clone();
        assert!(!restore_welded(&mut ring, &welded, &[p(0.5, 0.0)]), "no bucket kept it");
        let mut ring: Vec<_> = square[1..].to_vec();
        assert!(!restore_welded(&mut ring, &welded, &[d]), "its neighbour was simplified away");
        assert_eq!(ring, square[1..]);
        let mut ring = vec![k, p(1.0, 0.0), p(1.0, 1.0), k, p(0.0, 1.0), p(-1.0, 1.0)];
        let off = p(1.5e-4, -1.5e-4);
        let welded = [Welded { kept: k, dropped: off, before: false }];
        assert!(!restore_welded(&mut ring, &welded, &[off]), "pinched at its neighbour");
        assert!(restore_welded(&mut square.clone(), &welded, &[off]), "and restored when it is not");
    }

    /// #8190 review: a vertex that folds back onto the edge leading to its kept
    /// neighbour is `conform_ring`'s to insert. Restored as well, it would be
    /// in the ring twice and the region would fail to triangulate.
    #[test]
    fn leaves_a_vertex_on_a_ring_edge_to_conform_ring() {
        let (k, d) = (p(1.0, 0.0), p(1.0 - 2.0e-4, 0.0));
        let welded = [Welded { kept: k, dropped: d, before: false }];
        let mut ring = vec![p(0.0, 0.0), k, p(1.0, 1.0), p(0.0, 1.0)];
        assert!(!restore_welded(&mut ring, &welded, &[d]));
        assert!(conform_ring(&mut ring, &[d]));
        assert_eq!(ring, vec![p(0.0, 0.0), d, k, p(1.0, 1.0), p(0.0, 1.0)]);
    }
}
