// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;

fn state(matrix: [f64; 6]) -> PdfVectorGraphicsState {
    PdfVectorGraphicsState {
        model_metres_from_path: matrix,
        fill_rgb: [0.; 3],
        stroke_rgb: [0.; 3],
        line_width: 2.,
        line_cap: 1,
        line_join: 1,
        miter_limit: 10.,
        dash_lengths: vec![],
        dash_phase: 0.,
    }
}

fn transformed(matrix: [f64; 6], p: Point) -> Point {
    super::super::fill_paths::point(matrix, p).unwrap()
}

#[test]
fn issue_4406_round_caps_extend_outward_at_both_ends() {
    let mut remaining = 4_000_000;
    let result = rings(
        &[0., 0., 0., 1., 4., 0.],
        false,
        &state([1., 0., 0., 1., 0., 0.]),
        &mut remaining,
        0.01,
    )
    .unwrap();
    let bounds = result.rings[0].iter().fold(
        [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY],
        |[x0, y0, x1, y1], p| [x0.min(p[0]), y0.min(p[1]), x1.max(p[0]), y1.max(p[1])],
    );
    assert!(bounds[0] < -0.99 && bounds[1] < -0.99, "{bounds:?}");
    assert!(bounds[2] > 4.99 && bounds[3] > 0.99, "{bounds:?}");
}

#[test]
fn issue_4406_arc_chords_bound_metric_error_for_both_sweeps_and_affine_signs() {
    let centre = [2., -1.];
    let start = [3.25, -1.];
    let tolerance = 0.0001;
    for matrix in [
        [1., 0., 0., 1., 0., 0.],
        [2., 0.2, 0.5, 0.8, 3., 4.],
        [-1., 0.3, 0.4, 1.7, -2., 5.],
    ] {
        for sweep in [1.7, -1.7] {
            let mut remaining = 4_000_000;
            let points = arc(centre, start, sweep, &state(matrix), tolerance, &mut remaining).unwrap();
            let start_angle = (start[1] - centre[1]).atan2(start[0] - centre[0]);
            for i in 0..points.len() - 1 {
                let a = transformed(matrix, points[i]);
                let b = transformed(matrix, points[i + 1]);
                for sample in 0..=32 {
                    let t = f64::from(sample) / 32.;
                    let chord = add(mul(a, 1. - t), mul(b, t));
                    let angle = start_angle + sweep * (i as f64 + t) / (points.len() - 1) as f64;
                    let exact = transformed(matrix, add(centre, [1.25 * angle.cos(), 1.25 * angle.sin()]));
                    assert!(sub(chord, exact)[0].hypot(sub(chord, exact)[1]) <= tolerance);
                }
            }
        }
    }
}

#[test]
fn issue_4406_arc_refuses_when_affine_roundoff_exceeds_metric_allowance() {
    let mut remaining = 4_000_000;
    let error = arc(
        [0., 0.],
        [0.0001, 0.],
        std::f64::consts::PI,
        &state([1., 0., 0., 1., 50_000_000., 0.]),
        0.5e-9,
        &mut remaining,
    )
    .unwrap_err();
    assert!(error.contains("numerical precision"), "{error}");
}

#[test]
fn issue_4406_arc_charges_the_shared_budget_before_allocating_vertices() {
    let mut remaining = 0;
    let error = arc(
        [0., 0.],
        [1., 0.],
        std::f64::consts::PI,
        &state([1., 0., 0., 1., 0., 0.]),
        0.01,
        &mut remaining,
    )
    .unwrap_err();
    assert!(error.contains("shared work budget"), "{error}");
    assert_eq!(remaining, 0);
}
