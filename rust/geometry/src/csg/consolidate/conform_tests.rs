// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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

use crate::mesh::Mesh;

/// A closed tetrahedron plus one triangle with two corners inside the same grid
/// cell. Used by the collapsed-edge tests below.
fn tetrahedron_with_a_collapsed_sliver() -> (Mesh, Mesh) {
    let mut closed = Mesh::new();
    closed.positions = vec![0., 0., 0., 1., 0., 0., 0., 1., 0., 0., 0., 1.];
    closed.normals = vec![0.0; closed.positions.len()];
    closed.indices = vec![0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3];
    let mut with_sliver = closed.clone();
    // Corners 4 and 5 differ by 1e-6, far below the 1e-4 cell of scale 1e4.
    with_sliver.positions.extend([5., 5., 5., 5.000001, 5., 5., 5., 6., 5.]);
    with_sliver.normals = vec![0.0; with_sliver.positions.len()];
    with_sliver.indices.extend([4, 5, 6]);
    (closed, with_sliver)
}

#[test]
fn issue_7949_a_collapsed_edge_counts_as_open_and_never_cancels() {
    let (closed, with_sliver) = tetrahedron_with_a_collapsed_sliver();
    assert_eq!(count_open_boundary_edges_at(&closed, 1.0e4), 0);
    // On this grid the sliver's two long edges land on the same pair of cells
    // and cancel; its collapsed edge has no twin to cancel against. So the
    // sliver reads as exactly one open edge, where skipping collapsed edges
    // would read it as 0, a closed mesh. Pinned because skipping was measured
    // to let torn conform candidates through (see the doc on
    // `count_open_boundary_edges_at`).
    assert_eq!(count_open_boundary_edges_at(&with_sliver, 1.0e4), 1);
    // A grid fine enough to tell the corners apart sees it as an ordinary
    // triangle: three open edges, none of them collapsed.
    assert_eq!(count_open_boundary_edges_at(&with_sliver, 1.0e7), 3);
}

#[test]
fn issue_7949_open_edge_endpoints_skip_the_collapsed_edge_that_the_count_keeps() {
    let (closed, with_sliver) = tetrahedron_with_a_collapsed_sliver();
    assert!(open_edge_endpoints_at(&closed, 1.0e4).is_empty());
    // `count_open_boundary_edges_at` says 1 here, but the one open edge it
    // counts is collapsed: it has no direction or position to report, so the
    // locator reports none. The two differ on purpose.
    assert_eq!(count_open_boundary_edges_at(&with_sliver, 1.0e4), 1);
    assert!(open_edge_endpoints_at(&with_sliver, 1.0e4).is_empty());
    // Told apart by a finer grid, the same sliver's three edges are all located.
    assert_eq!(open_edge_endpoints_at(&with_sliver, 1.0e7).len(), 3);
}
