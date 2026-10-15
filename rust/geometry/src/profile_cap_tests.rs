// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{extrude_profile, Mesh, Point2, Profile2D};
use std::collections::BTreeMap;

// #7631 (isolated from #6940): authored profile coordinates alone, no fixture, placement,
// opening machinery or topology repair. The tiny deviations between nominally
// collinear rectangular hole walls are essential to the earcut bridge failure.
// Keeping the full profile records the measured witness rather than inventing
// a near-collinear example that might not exercise the failure.
pub(crate) fn bridge_profile() -> Profile2D {
    let ring = |p: &[[f64; 2]]| p.iter().map(|&[x, y]| Point2::new(x, y)).collect();
    let mut profile = Profile2D::new(ring(&[
        [-11.3750000000001, -5.87499999999995],
        [-11.3750000000001, -16.675],
        [-11.125, -16.675],
        [-11.125, -16.075],
        [-3.87500000000007, -16.075],
        [-3.87500000000007, -16.675],
        [-3.62499999999993, -16.675],
        [-3.62499999999993, -16.075],
        [3.62500000000005, -16.075],
        [3.62500000000004, -16.675],
        [3.8750000000001, -16.675],
        [3.8750000000001, -16.075],
        [11.1250000000001, -16.075],
        [11.1250000000001, -16.6750000000001],
        [11.375, -16.6750000000001],
        [11.375, -5.87499999999996],
        [9.425, -5.87499999999996],
        [9.425, -3.17499999999996],
        [11.375, -3.17499999999996],
        [11.375, 3.17499999999997],
        [9.42499999999998, 3.17499999999997],
        [9.42499999999999, 5.87499999999997],
        [11.375, 5.87499999999997],
        [11.375, 16.675],
        [11.1250000000001, 16.675],
        [11.1250000000001, 16.075],
        [3.8750000000001, 16.075],
        [3.8750000000001, 16.675],
        [3.62500000000004, 16.675],
        [3.62500000000005, 16.075],
        [-3.62499999999993, 16.075],
        [-3.62499999999993, 16.675],
        [-3.87500000000007, 16.675],
        [-3.87500000000007, 16.075],
        [-11.125, 16.075],
        [-11.125, 16.6749999999999],
        [-11.3750000000001, 16.6749999999999],
        [-11.3750000000001, 5.87499999999998],
        [-9.42500000000006, 5.87499999999998],
        [-9.42500000000007, 3.17499999999998],
        [-11.3750000000001, 3.17499999999998],
        [-11.3750000000001, -3.17499999999995],
        [-9.42500000000006, -3.17499999999995],
        [-9.42500000000007, -5.87499999999995],
        [-11.3750000000001, -5.87499999999995],
    ]));
    profile.add_hole(ring(&[
        [-3.62500000000009, -1.74999999999999],
        [-3.62500000000008, 1.75000000000001],
        [-0.875000000000062, 1.75],
        [-0.875000000000071, -1.75],
        [-3.62500000000009, -1.74999999999999],
    ]));
    profile.add_hole(ring(&[
        [2.22499999999994, 1.76],
        [2.22499999999993, -1.54],
        [1.02499999999991, -1.53999999999999],
        [1.02499999999992, 1.76],
        [2.22499999999994, 1.76],
    ]));
    profile.add_hole(ring(&[
        [3.62499999999991, -1.75999999999998],
        [2.42499999999993, -1.75999999999998],
        [2.42499999999994, 1.54],
        [3.62499999999992, 1.54],
        [3.62499999999991, -1.75999999999998],
    ]));
    profile.add_hole(ring(&[
        [-2.82500000000002, 11.3249999999999],
        [-3.625, 11.3249999999999],
        [-3.62500000000001, 11.5749999999999],
        [-2.82500000000002, 11.575],
        [-2.82500000000002, 11.3249999999999],
    ]));
    profile.add_hole(ring(&[
        [-10.325, 11.325],
        [-11.125, 11.325],
        [-11.125, 11.575],
        [-10.325, 11.575],
        [-10.325, 11.325],
    ]));
    profile.add_hole(ring(&[
        [4.67499999999996, 11.3249999999999],
        [3.87499999999996, 11.3249999999999],
        [3.87499999999997, 11.5749999999999],
        [4.67499999999996, 11.5749999999999],
        [4.67499999999996, 11.3249999999999],
    ]));
    profile.add_hole(ring(&[
        [-3.87499999999992, 10.9749999999999],
        [-3.87499999999992, 10.0249999999999],
        [-6.91299986999992, 10.0249999999999],
        [-6.91299986999992, 10.9749999999999],
        [-3.87499999999992, 10.9749999999999],
    ]));
    profile.add_hole(ring(&[
        [11.1250000000001, 10.9749999999999],
        [11.1250000000001, 10.0249999999999],
        [8.08700013000008, 10.0249999999999],
        [8.08700013000009, 10.9749999999999],
        [11.1250000000001, 10.9749999999999],
    ]));
    profile.add_hole(ring(&[
        [-2.82499999999992, -11.3249999999999],
        [-2.82499999999992, -11.5749999999999],
        [-3.62499999999992, -11.5749999999999],
        [-3.62499999999991, -11.3249999999999],
        [-2.82499999999992, -11.3249999999999],
    ]));
    profile.add_hole(ring(&[
        [3.62500000000022, -10.975],
        [0.587000130000213, -10.9749999999999],
        [0.587000130000219, -10.0249999999999],
        [3.62500000000022, -10.025],
        [3.62500000000022, -10.975],
    ]));
    profile.add_hole(ring(&[
        [-10.325, -11.3249999999998],
        [-10.325, -11.5749999999998],
        [-11.1249999999999, -11.5749999999998],
        [-11.1249999999999, -11.3249999999998],
        [-10.325, -11.3249999999998],
    ]));
    profile.add_hole(ring(&[
        [4.67500000000005, -11.325],
        [4.67500000000004, -11.575],
        [3.87500000000005, -11.575],
        [3.87500000000006, -11.325],
        [4.67500000000005, -11.325],
    ]));
    profile.add_hole(ring(&[
        [-3.87499999999982, -10.9749999999999],
        [-6.91299986999982, -10.9749999999999],
        [-6.91299986999981, -10.0249999999999],
        [-3.87499999999981, -10.0249999999999],
        [-3.87499999999982, -10.9749999999999],
    ]));
    profile.add_hole(ring(&[
        [11.1250000000002, -10.975],
        [8.08700013000018, -10.975],
        [8.08700013000019, -10.025],
        [11.1250000000002, -10.0250000000001],
        [11.1250000000002, -10.975],
    ]));
    profile
}

fn assert_closed(mesh: &Mesh) {
    let p = |i: u32| -> [i64; 3] {
        std::array::from_fn(|k| {
            (f64::from(mesh.positions[i as usize * 3 + k]) * 65536.0).round() as i64
        })
    };
    let mut uses = BTreeMap::<([i64; 3], [i64; 3]), (usize, usize)>::new();
    for t in mesh.indices.chunks_exact(3) {
        let q = [p(t[0]), p(t[1]), p(t[2])];
        let a: [i128; 3] = std::array::from_fn(|k| i128::from(q[1][k]) - i128::from(q[0][k]));
        let b: [i128; 3] = std::array::from_fn(|k| i128::from(q[2][k]) - i128::from(q[0][k]));
        assert_ne!(
            [
                a[1] * b[2] - a[2] * b[1],
                a[2] * b[0] - a[0] * b[2],
                a[0] * b[1] - a[1] * b[0]
            ],
            [0; 3],
            "collapsed grid face"
        );
        for k in 0..3 {
            let (a, b) = (q[k], q[(k + 1) % 3]);
            let u = uses.entry((a.min(b), a.max(b))).or_default();
            if a < b {
                u.0 += 1;
            } else {
                u.1 += 1;
            }
        }
    }
    assert!(!uses.is_empty());
    assert!(
        uses.values().all(|&u| u == (1, 1)),
        "every edge must have exactly two opposite faces"
    );
}

fn area(ring: &[Point2<f64>]) -> f64 {
    (0..ring.len())
        .map(|i| {
            let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
            a.x * b.y - a.y * b.x
        })
        .sum::<f64>()
        .abs()
        / 2.0
}

#[test]
fn issue_6940_multi_hole_caps_close_without_moving_authored_vertices() {
    for closed_rings in [true, false] {
        let mut profile = bridge_profile();
        if !closed_rings {
            profile.outer.pop();
            for h in &mut profile.holes {
                h.pop();
            }
        }
        let expected_points: Vec<_> = profile
            .outer
            .iter()
            .chain(profile.holes.iter().flatten())
            .copied()
            .collect();
        let tri = profile.triangulate().unwrap();
        assert_eq!(
            tri.points, expected_points,
            "the retry must retain all original scalar vertices"
        );
        let expected_volume =
            0.25 * (area(&profile.outer) - profile.holes.iter().map(|h| area(h)).sum::<f64>());
        let raw = extrude_profile(&profile, 0.25, None).unwrap();
        for cleanup in [0, 1, 2] {
            let mut mesh = raw.clone();
            match cleanup {
                1 => mesh.clean_degenerate(),
                2 => mesh.clean_degenerate_watertight(),
                _ => {}
            }
            assert_closed(&mesh);
            let actual = crate::kernel::mesh_volume::mesh_volume(&mesh);
            assert!(
                (actual - expected_volume).abs() < 1e-4,
                "cap must cover outer minus all holes: {actual} vs {expected_volume}"
            );
        }
    }
}

#[test]
fn issue_6940_cap_retains_collinear_profile_edge_subdivisions() {
    let mut p = Profile2D::new(vec![
        Point2::new(0., 0.),
        Point2::new(4., 0.),
        Point2::new(8., 0.),
        Point2::new(8., 8.),
        Point2::new(0., 8.),
    ]);
    p.add_hole(vec![
        Point2::new(2., 2.),
        Point2::new(2., 4.),
        Point2::new(4., 4.),
        Point2::new(4., 2.),
    ]);
    assert_closed(&extrude_profile(&p, 1., None).unwrap());
}

#[test]
fn issue_6940_cap_retry_preserves_outside_and_nested_ring_semantics() {
    let ring = |x: f64, y: f64, size: f64| {
        vec![
            Point2::new(x, y),
            Point2::new(x + size, y),
            Point2::new(x + size, y + size),
            Point2::new(x, y + size),
        ]
    };
    for holes in [
        vec![ring(20., 20., 2.)],
        vec![ring(2., 2., 6.), ring(3., 3., 1.)],
        vec![ring(8., 8., 4.)],
    ] {
        let outer = ring(0., 0., 10.);
        let mut points = outer.clone();
        let mut offsets = Vec::new();
        for h in &holes {
            offsets.push(points.len());
            points.extend(h.iter().copied());
        }
        let data: Vec<f64> = points.iter().flat_map(|p| [p.x, p.y]).collect();
        let old = crate::triangulation::safe_earcut(&data, &offsets, 2).unwrap();
        let result = super::triangulate_rings(&outer, &holes).unwrap();
        assert_eq!(
            result.indices, old,
            "malformed domains must retain safe_earcut's interpretation"
        );
    }
}
