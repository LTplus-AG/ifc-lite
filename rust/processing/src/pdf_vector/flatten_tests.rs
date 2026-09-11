// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
#[test]
fn issue_4406_finite_chord_bound_does_not_flatten_backtracking_to_its_endpoint_span() {
    let mut remaining = 100_000;
    let mut points = vec![[0., 0.]];
    bezier(
        [[0., 0.], [10., 0.], [-2., 0.], [1., 0.]],
        0.001,
        &mut remaining,
        &mut points,
    )
    .unwrap();
    assert!(points.iter().any(|p| p[0] > 3.));
    assert!(remaining < 100_000);
}
#[test]
fn issue_4406_model_plane_curve_samples_obey_declared_subdivision_error() {
    let c = [[1., 2.], [4., 8.], [-2., 5.], [3., 1.]];
    let mut remaining = 100_000;
    let mut points = vec![c[0]];
    bezier(c, 0.002, &mut remaining, &mut points).unwrap();
    for i in 0..=2000 {
        let t = i as f64 / 2000.;
        let s = 1. - t;
        let p = std::array::from_fn(|k| {
            s * s * s * c[0][k]
                + 3. * s * s * t * c[1][k]
                + 3. * s * t * t * c[2][k]
                + t * t * t * c[3][k]
        });
        let error = points
            .windows(2)
            .map(|w| distance(p, w[0], w[1]))
            .fold(f64::INFINITY, f64::min);
        assert!(error <= 0.002);
    }
}
#[test]
fn issue_4406_curve_budget_and_collapsed_or_unrepresentable_controls_refuse() {
    let c = [[0., 0.], [0., 1.], [1., 1.], [1., 0.]];
    assert!(bezier(c, 0.001, &mut 0, &mut vec![])
        .unwrap_err()
        .contains("budget"));
    assert!(bezier([[1., 1.]; 4], 0.001, &mut 100, &mut vec![])
        .unwrap_err()
        .contains("collapses"));
    assert!(bezier(
        [
            [1e8, 1e8],
            [1e8 - 1., 1e8],
            [1e8 - 1., 1e8 - 1.],
            [1e8, 1e8 - 1.]
        ],
        1e-10,
        &mut 100,
        &mut vec![]
    )
    .unwrap_err()
    .contains("precision"));
}
