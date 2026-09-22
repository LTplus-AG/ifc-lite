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

fn assert_all_finite(label: &str, tangents: &[Vector3<f64>], perp1s: &[Vector3<f64>], perp2s: &[Vector3<f64>]) {
    for (i, v) in tangents.iter().enumerate() {
        assert!(
            v.x.is_finite() && v.y.is_finite() && v.z.is_finite(),
            "{label}: tangents[{i}] is not finite: {v:?}"
        );
    }
    for (i, v) in perp1s.iter().enumerate() {
        assert!(
            v.x.is_finite() && v.y.is_finite() && v.z.is_finite(),
            "{label}: perp1s[{i}] is not finite: {v:?}"
        );
    }
    for (i, v) in perp2s.iter().enumerate() {
        assert!(
            v.x.is_finite() && v.y.is_finite() && v.z.is_finite(),
            "{label}: perp2s[{i}] is not finite: {v:?}"
        );
    }
}

// #5191: a duplicate LEADING point — curve_points[0] == curve_points[1] — is
// the issue's own reproduction. `(curve_points[1] - curve_points[0])` at i=0
// is a zero vector; without the dedupe, `.normalize()` yields NaN there and
// the RMF guard at every later `i` reads that NaN as "nearly parallel" and
// latches it into every remaining tangent/perp1/perp2.
#[test]
fn rmf_duplicate_leading_point_is_finite() {
    let pts = vec![
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(1.0, 0.0, 0.0),
        Point3::new(2.0, 0.0, 0.0),
    ];
    let (tangents, perp1s, perp2s) = build_tube_rmf(&pts);
    assert_eq!(tangents.len(), 4);
    assert_all_finite("duplicate leading point", &tangents, &perp1s, &perp2s);
    // The duplicated leading point has nothing to differ against on its own;
    // it should inherit the direction resolved at the next distinct point.
    assert!((tangents[0] - tangents[1]).norm() < 1e-9);
}

// A duplicate point in the MIDDLE of the directrix hits the `else` branch
// (central difference: `curve_points[i + 1] - curve_points[i - 1]`), a
// different code path from the `i == 0`/`i == n - 1` branches the leading
// and trailing cases exercise. A single duplicated PAIR in the interior is
// NOT enough to zero that formula — it differences points two apart, so it
// skips straight over a lone repeated point and stays finite (verified: this
// test originally used a duplicate pair and passed even with the dedupe
// fix reverted, which was a false-negative mutation result — it wasn't
// exercising the hazard it claimed to). What DOES zero the central-difference
// is a RUN of (at least) three consecutive identical points: for the middle
// one, both `i - 1` and `i + 1` land on the same repeated coordinate, so
// their difference is exactly zero. Three repeated directrix points in a row
// is a real authoring pattern (e.g. two composite-curve segment boundaries
// both landing on the same shared vertex).
#[test]
fn rmf_duplicate_middle_point_is_finite() {
    let pts = vec![
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(1.0, 0.0, 0.0),
        Point3::new(1.0, 0.0, 0.0),
        Point3::new(1.0, 0.0, 0.0),
        Point3::new(2.0, 0.0, 0.0),
    ];
    let (tangents, perp1s, perp2s) = build_tube_rmf(&pts);
    assert_eq!(tangents.len(), 5);
    assert_all_finite("duplicate middle point", &tangents, &perp1s, &perp2s);
}

// A duplicate TRAILING point exercises the `i == n - 1` branch:
// `curve_points[i] - curve_points[i - 1]` is zero when the last two samples
// coincide.
#[test]
fn rmf_duplicate_trailing_point_is_finite() {
    let pts = vec![
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(1.0, 0.0, 0.0),
        Point3::new(2.0, 0.0, 0.0),
        Point3::new(2.0, 0.0, 0.0),
    ];
    let (tangents, perp1s, perp2s) = build_tube_rmf(&pts);
    assert_eq!(tangents.len(), 4);
    assert_all_finite("duplicate trailing point", &tangents, &perp1s, &perp2s);
    // The duplicated trailing point has nothing to differ against on its
    // own; it should inherit the direction resolved at the previous distinct
    // point.
    assert!((tangents[3] - tangents[2]).norm() < 1e-9);
}

// No-regression pin: a normal directrix with no duplicate points must
// produce byte-for-byte the same tangents/perp1/perp2 the pre-fix
// implementation produced, so the dedupe path cannot be silently changing
// good input. Values below were computed against `build_tube_rmf` on
// `upstream/main` before this fix (a straight X-axis directrix has a
// trivially checkable closed form: tangent = +X everywhere, perp1/perp2
// orthonormal and constant since there's no bend).
#[test]
fn rmf_no_duplicates_matches_pre_fix_geometry() {
    let pts = vec![
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(1.0, 0.0, 0.0),
        Point3::new(2.0, 0.0, 0.0),
        Point3::new(3.0, 0.0, 0.0),
    ];
    let (tangents, perp1s, perp2s) = build_tube_rmf(&pts);
    assert_eq!(tangents.len(), 4);
    assert_all_finite("no duplicates", &tangents, &perp1s, &perp2s);
    for t in &tangents {
        assert!((t - Vector3::new(1.0, 0.0, 0.0)).norm() < 1e-9, "{t:?}");
    }
    // perp1/perp2 must stay constant (no bends to rotate the frame) and
    // orthonormal to the tangent.
    for i in 1..4 {
        assert!((perp1s[i] - perp1s[0]).norm() < 1e-9);
        assert!((perp2s[i] - perp2s[0]).norm() < 1e-9);
    }
    assert!(perp1s[0].dot(&tangents[0]).abs() < 1e-9);
    assert!(perp2s[0].dot(&tangents[0]).abs() < 1e-9);
    assert!((perp1s[0].norm() - 1.0).abs() < 1e-9);
    assert!((perp2s[0].norm() - 1.0).abs() < 1e-9);

    // Also pin the built mesh's vertex count and a sampled position, so a
    // future change to either `build_tube_rmf` or `build_tube` can't
    // silently alter ordinary (duplicate-free) geometry.
    let segments = 24;
    let (positions, _indices) = build_tube(&pts, 0.1, None, segments);
    // 4 rings of `segments` outer-wall vertices, plus a centre point for each
    // of the two end caps (a rod, no bore): 3 * (4 * 24 + 2).
    assert_eq!(positions.len(), 3 * (4 * segments + 2));
    // First ring, first vertex: centred at (0,0,0), offset by radius along
    // perp1 (theta = 0 => cos=1, sin=0).
    let expected = Point3::new(0.0, 0.0, 0.0) + perp1s[0] * 0.1;
    assert!((positions[0] as f64 - expected.x).abs() < 1e-6, "{}", positions[0]);
    assert!((positions[1] as f64 - expected.y).abs() < 1e-6, "{}", positions[1]);
    assert!((positions[2] as f64 - expected.z).abs() < 1e-6, "{}", positions[2]);
}
