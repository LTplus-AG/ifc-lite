// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `v2`: bit equality against the expanded formulas (the spec, not a copy of
//! the implementation) and the degenerate-ring table (#7773).

use super::v2::*;
use super::v3_tests::Rng;
use crate::bool2d::{compute_signed_area, point_in_contour};
use nalgebra::Point2;

fn ring(rng: &mut Rng, n: usize) -> Vec<P2> {
    (0..n).map(|_| [rng.f64(), rng.f64()]).collect()
}

/// The pre-#7773 `geom2d::point_in_polygon` / `space_dcel::point_in_quad`.
fn pip_spec(p: P2, poly: &[P2]) -> bool {
    let n = poly.len();
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (poly[i][0], poly[i][1]);
        let (xj, yj) = (poly[j][0], poly[j][1]);
        if ((yi > p[1]) != (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
        j = i;
    }
    inside
}

#[test]
fn area_is_the_left_to_right_shoelace_for_every_representation() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for _ in 0..2000 {
        let n = 3 + (rng.next() % 9) as usize;
        let r = ring(&mut rng, n);
        let mut spec = 0.0;
        for i in 0..n {
            let (p, q) = (r[i], r[(i + 1) % n]);
            spec += p[0] * q[1] - q[0] * p[1];
        }
        let acc = spec;
        let spec = spec * 0.5;
        assert_eq!(polygon_area(&r).to_bits(), spec.to_bits());
        let pts: Vec<Point2<f64>> = r.iter().map(|p| Point2::new(p[0], p[1])).collect();
        assert_eq!(compute_signed_area(&pts).to_bits(), spec.to_bits(), "bool2d shares the loop");
        let edges = (0..n).map(|i| (r[i], r[(i + 1) % n]));
        assert_eq!(shoelace2_edges(edges).to_bits(), acc.to_bits());
    }
}

#[test]
fn degenerate_rings_have_zero_area_and_contain_nothing() {
    for n in 0..3 {
        let r: Vec<P2> = vec![[1.0, 2.0]; n];
        assert_eq!(polygon_area(&r), 0.0);
        assert!(!point_in_polygon([1.0, 2.0], &r), "n = {n}");
    }
    assert!(!point_in_ring_by([0.0, 0.0], 0, |_| [0.0, 0.0]), "an empty flat ring must not underflow n - 1");
}

#[test]
fn point_in_ring_matches_the_old_ray_cast_bit_for_bit() {
    let mut rng = Rng(0xD1B5_4A32_D192_ED03);
    for _ in 0..4000 {
        let n = 3 + (rng.next() % 6) as usize;
        let r = ring(&mut rng, n);
        let p = [rng.f64(), rng.f64()];
        let spec = pip_spec(p, &r);
        assert_eq!(point_in_polygon(p, &r), spec);
        let flat: Vec<f64> = r.iter().flatten().copied().collect();
        assert_eq!(point_in_ring_by(p, n, |i| [flat[i * 2], flat[i * 2 + 1]]), spec);
        let pts: Vec<Point2<f64>> = r.iter().map(|q| Point2::new(q[0], q[1])).collect();
        assert_eq!(point_in_contour(&Point2::new(p[0], p[1]), &pts), spec);
    }
    // Boundary: the half-open rule gives a shared edge to exactly one side.
    let left = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
    let right = [[1.0, 0.0], [2.0, 0.0], [2.0, 1.0], [1.0, 1.0]];
    let on_edge = [1.0, 0.5];
    assert_ne!(point_in_polygon(on_edge, &left), point_in_polygon(on_edge, &right));
}

#[test]
fn vector_ops_are_unfused_and_dist_is_hypot() {
    let mut rng = Rng(0x2545_F491_4F6C_DD1D);
    for _ in 0..2000 {
        let (a, b) = ([rng.f64(), rng.f64()], [rng.f64(), rng.f64()]);
        assert_eq!(dot(a, b).to_bits(), (a[0] * b[0] + a[1] * b[1]).to_bits());
        assert_eq!(cross(a, b).to_bits(), (a[0] * b[1] - a[1] * b[0]).to_bits());
        assert_eq!(dist(a, b).to_bits(), (a[0] - b[0]).hypot(a[1] - b[1]).to_bits());
        let (dx, dy) = (a[0] - b[0], a[1] - b[1]);
        assert_eq!(dist2(a, b).to_bits(), (dx * dx + dy * dy).to_bits());
        assert_eq!(dist2(a, b).to_bits(), ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).to_bits());
    }
}

#[test]
fn bbox_skips_nan_and_the_empty_set_is_inverted() {
    assert_eq!(bbox(std::iter::empty()), [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY]);
    assert_eq!(bbox([[1.0, 5.0], [f64::NAN, -2.0], [-3.0, 4.0]]), [-3.0, -2.0, 1.0, 5.0]);
}

#[test]
fn point_segment_distance_clamps_to_the_ends_and_handles_a_point_segment() {
    let (a, b) = ([0.0, 0.0], [4.0, 0.0]);
    assert_eq!(point_segment_distance([2.0, 3.0], a, b), 3.0);
    assert_eq!(point_segment_distance([-3.0, 4.0], a, b), 5.0);
    assert_eq!(point_segment_distance([7.0, 4.0], a, b), 5.0);
    assert_eq!(point_segment_distance([3.0, 4.0], a, a), 5.0);
}
