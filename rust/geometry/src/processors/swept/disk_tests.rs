// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for the swept-disk rotation-minimising frame. Split out of
//! `disk.rs` so that file stays under the module-size rule.

use super::*;

#[test]
fn rmf_is_constant_on_a_straight_line() {
    // Three collinear samples → tangents identical → frame must not change.
    let pts = vec![
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(1.0, 0.0, 0.0),
        Point3::new(2.0, 0.0, 0.0),
    ];
    let (tangents, perp1s, perp2s) = build_tube_rmf(&pts);
    assert_eq!(tangents.len(), 3);
    for i in 1..3 {
        assert!((tangents[i] - tangents[0]).norm() < 1e-9);
        assert!((perp1s[i] - perp1s[0]).norm() < 1e-9);
        assert!((perp2s[i] - perp2s[0]).norm() < 1e-9);
    }
}

#[test]
fn rmf_does_not_flip_at_sharp_bends() {
    // L-shape (0,0,0) → (1,0,0) → (1,1,0). The previous implementation
    // re-picked `up` per cross-section based on `tangent.x.abs() < 0.9`:
    // at i=0 tangent is +X (|x|=1, picks up=Y) → perp1 = +Z; at i=1 the
    // midpoint tangent is (1/√2, 1/√2, 0) (|x|≈0.71 < 0.9, picks up=X)
    // → perp1 = -Z. The sign flip mirrors the cross-section ring and
    // produces a twisted/flat-ribbon tube. RMF must propagate +Z through.
    let pts = vec![
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(1.0, 0.0, 0.0),
        Point3::new(1.0, 1.0, 0.0),
    ];
    let (_, perp1s, _) = build_tube_rmf(&pts);
    assert_eq!(perp1s.len(), 3);
    for (i, p) in perp1s.iter().enumerate() {
        assert!(
            p.z > 0.5,
            "perp1 at i={i} flipped or rotated out of +Z half-space: {p:?}"
        );
    }
}

#[test]
fn rmf_handles_degenerate_inputs() {
    let empty: Vec<Point3<f64>> = Vec::new();
    let (t, p1, p2) = build_tube_rmf(&empty);
    assert!(t.is_empty() && p1.is_empty() && p2.is_empty());

    let single = vec![Point3::new(0.0, 0.0, 0.0)];
    let (t, p1, p2) = build_tube_rmf(&single);
    assert!(t.is_empty() && p1.is_empty() && p2.is_empty());
}
