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
