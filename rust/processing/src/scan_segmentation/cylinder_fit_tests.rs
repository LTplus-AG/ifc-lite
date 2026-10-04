// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;

/// Points on a circle of radius `r` about (cx, cy) over `arc` radians, with a
/// fixed alternating radial perturbation of `wobble`.
fn arc_points(cx: f64, cy: f64, r: f64, arc: f64, n: usize, wobble: f64) -> Vec<[f64; 2]> {
    (0..n)
        .map(|i| {
            let angle = arc * i as f64 / (n - 1) as f64;
            let radius = r + if i % 2 == 0 { wobble } else { -wobble };
            [cx + radius * angle.cos(), cy + radius * angle.sin()]
        })
        .collect()
}

#[test]
fn issue_6870_circle_fit_recovers_centre_and_radius_from_a_partial_arc() {
    let (centre, radius) = fit_circle(&arc_points(4.5, 2.5, 0.3, 100_f64.to_radians(), 60, 0.002)).unwrap();
    assert!((centre[0] - 4.5).abs() < 2e-3 && (centre[1] - 2.5).abs() < 2e-3, "{centre:?}");
    assert!((radius - 0.3).abs() < 1e-3, "{radius}");
}

#[test]
fn issue_6870_axis_is_the_direction_all_normals_are_perpendicular_to() {
    let tilt = 0.2_f64;
    let axis = [tilt.sin(), 0., tilt.cos()];
    let (u, v) = plane_basis(axis);
    let normals = (0..40).map(|i| {
        let a = i as f64 * 0.05;
        std::array::from_fn(|k| a.cos() * u[k] + a.sin() * v[k])
    });
    let found = axis_from_normals(normals).unwrap();
    assert!(dot(found, axis).abs() > 1. - 1e-9, "{found:?}");
    // Parallel normals (a plane strip) define no axis.
    assert!(axis_from_normals((0..10).map(|_| [1., 0., 0.])).is_none());
}

#[test]
fn issue_6870_a_sphere_fits_sphere_points_and_not_a_long_cylinder() {
    let sphere: Vec<Vec3> = (0..400)
        .map(|i| {
            let z = -1. + 2. * (i as f64 + 0.5) / 400.;
            let a = i as f64 * 2.399_963; // golden angle
            let r = (1. - z * z).sqrt();
            [1. + 0.25 * r * a.cos(), 2. + 0.25 * r * a.sin(), 3. + 0.25 * z]
        })
        .collect();
    assert!(sphere_rms(&sphere).unwrap() < 1e-9);
    let column: Vec<Vec3> = (0..400).map(|i| {
        let a = i as f64 * 0.7;
        [0.3 * a.cos(), 0.3 * a.sin(), i as f64 * 0.007]
    }).collect();
    assert!(sphere_rms(&column).unwrap() > 0.1, "a 2.8 m column is far from any sphere");
}

#[test]
fn issue_6870_arc_coverage_measures_the_widest_gap() {
    let cylinder = Cylinder { point: [0.; 3], axis: [0., 0., 1.], radius: 1. };
    let (u, v) = plane_basis(cylinder.axis);
    let ring = |from: f64, to: f64| {
        (0..200).map(move |i| {
            let a = (from + (to - from) * i as f64 / 199.).to_radians();
            std::array::from_fn(|k| a.cos() * u[k] + a.sin() * v[k])
        })
    };
    assert!((arc_degrees(&cylinder, ring(0., 359.)) - 360.).abs() <= 5.);
    let sixty = arc_degrees(&cylinder, ring(10., 70.));
    assert!((55. ..=70.).contains(&sixty), "{sixty}");
    // Two opposite 30 degree patches leave two 150 degree gaps: 210 covered.
    let split = arc_degrees(&cylinder, ring(0., 30.).chain(ring(180., 210.)));
    assert!((200. ..=220.).contains(&split), "{split}");
}
