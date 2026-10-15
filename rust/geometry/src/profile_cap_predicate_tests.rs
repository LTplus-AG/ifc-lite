// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::unrepresentable_face;
use crate::{Point2, Profile2D};

#[test]
fn issue_7631_only_finite_positive_faces_lost_at_f32_admit_retry() {
    assert_eq!(
        unrepresentable_face(&[0., 0., 2., 0., 0., 2.], &[0, 1, 2]),
        Some(false)
    );
    let needle = [0., 1., 2., 1., 1., 1. + f64::EPSILON];
    assert_eq!(unrepresentable_face(&needle, &[0, 1, 2]), Some(true));
    let reversal = [
        0.,
        0.,
        1.,
        1. + 5. * 2_f64.powi(-26),
        1.5,
        1.5 + 31. * 2_f64.powi(-28),
    ];
    assert_eq!(
        unrepresentable_face(&reversal, &[0, 1, 2]),
        Some(true),
        "finite f32 rounding can reverse, not only collapse, a positive face"
    );
    let mut pair = needle.to_vec();
    pair.extend_from_slice(&[0., 0., 2., 0., 0., 2.]);
    for indices in [[0, 1, 2, 3, 4, 5], [3, 4, 5, 0, 1, 2]] {
        assert_eq!(unrepresentable_face(&pair, &indices), Some(true));
    }
    assert_eq!(
        unrepresentable_face(&pair, &[0, 1, 2, 3, 5, 4]),
        None,
        "a later reversed original face invalidates the candidate"
    );
    assert_eq!(
        unrepresentable_face(&pair, &[0, 1, 2, 3, 4, 6]),
        None,
        "a later invalid index is not skipped"
    );
    pair[8] = 1e40;
    assert_eq!(
        unrepresentable_face(&pair, &[0, 1, 2, 3, 4, 5]),
        None,
        "a later finite cast overflow is not skipped"
    );
    pair[8] = f64::NAN;
    assert_eq!(
        unrepresentable_face(&pair, &[0, 1, 2, 3, 4, 5]),
        None,
        "a later nonfinite coordinate is not skipped"
    );
    assert_eq!(
        unrepresentable_face(&needle, &[0, 2, 1]),
        None,
        "already reversed in f64"
    );
    assert_eq!(
        unrepresentable_face(&[0., 0., 1., 0., 2., 0.], &[0, 1, 2]),
        None,
        "already collapsed in f64"
    );
    assert_eq!(
        unrepresentable_face(&[0., 0., 1e40, 0., 0., 1e40], &[0, 1, 2]),
        None,
        "cast overflow is not a needle"
    );
    for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert_eq!(
            unrepresentable_face(&[0., 0., 2., 0., 0., invalid], &[0, 1, 2]),
            None
        );
    }
    assert_eq!(unrepresentable_face(&needle, &[0, 1, 3]), None);
    assert_eq!(unrepresentable_face(&needle, &[0, 1]), None);
    assert_eq!(unrepresentable_face(&[], &[]), Some(false));
}

#[test]
fn issue_7631_aligned_hole_deficit_preserves_representable_earcut_output() {
    // The #5739 wall's exact rectangular domain in authored millimetres.
    // Its cross-ring collinear T-junctions are handled by established mesh
    // hygiene. Broad CDT/conform replacement changes unrelated diagonals and
    // can regress the existing rotated/local-frame opening contract.
    let mut profile = Profile2D::new(vec![
        Point2::new(0., 0.),
        Point2::new(44700., 0.),
        Point2::new(44700., 2988.),
        Point2::new(0., 2988.),
    ]);
    for i in 0..13 {
        let x = 1200. + f64::from(i) * 3300.;
        profile.add_hole(vec![
            Point2::new(x, 600.),
            Point2::new(x, 2475.),
            Point2::new(x + 1815., 2475.),
            Point2::new(x + 1815., 600.),
        ]);
    }
    let mut data = Vec::new();
    let mut offsets = Vec::new();
    for (i, ring) in std::iter::once(&profile.outer)
        .chain(profile.holes.iter())
        .enumerate()
    {
        if i > 0 {
            offsets.push(data.len() / 2);
        }
        for p in ring {
            data.extend_from_slice(&[p.x, p.y]);
        }
    }
    let established = crate::triangulation::safe_earcut(&data, &offsets, 2).unwrap();
    assert!(
        established.len() / 3 < data.len() / 2 + 2 * offsets.len() - 2,
        "actual collinear deficit"
    );
    assert_eq!(unrepresentable_face(&data, &established), Some(false));
    let actual = profile.triangulate().unwrap();
    let original: Vec<_> = data
        .chunks_exact(2)
        .map(|p| Point2::new(p[0], p[1]))
        .collect();
    assert_eq!(
        actual.points, original,
        "original scalar coordinates are preserved"
    );
    assert_eq!(
        actual.indices, established,
        "ordinary representable geometry retains established diagonals"
    );
    let area2: f64 = actual
        .indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (
                actual.points[t[0]],
                actual.points[t[1]],
                actual.points[t[2]],
            );
            (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
        })
        .sum();
    assert_eq!(
        area2,
        2. * (44700. * 2988. - 13. * 1815. * 1875.),
        "exact integer outer-minus-holes domain"
    );
}
