// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

#[test]
fn bspline_basis_out_of_range_returns_zero_not_panic() {
    // Knot vector too short for (i, p): must contribute 0.0, not panic OOB.
    assert_eq!(bspline_basis(5, 3, 0.5, &[0.0, 1.0]), 0.0);
}

#[test]
fn bspline_basis_matches_known_quadratic_partition() {
    // #4901 / #5321: use the known quadratic partition, not one call into
    // bspline_basis_table as the oracle for another call into the same helper.
    let knots = [0.0, 0.0, 0.0, 1.0, 2.0, 3.0, 3.0, 3.0];
    for (u, expected) in [
        (0.0, [1.0, 0.0, 0.0, 0.0, 0.0]),
        (0.5, [0.25, 0.625, 0.125, 0.0, 0.0]),
        (1.5, [0.0, 0.125, 0.75, 0.125, 0.0]),
        (2.5, [0.0, 0.0, 0.125, 0.625, 0.25]),
    ] {
        assert_eq!(bspline_basis_table(2, u, &knots, 5), expected);
        for (i, value) in expected.into_iter().enumerate() {
            assert_eq!(bspline_basis(i, 2, u, &knots), value, "u={u}, i={i}");
        }
    }
}
/// Evaluate a B-spline surface at parameter (u, v).
/// When `weights` is `None` this is a standard (non-rational) evaluation.
/// When `weights` is `Some`, rational (NURBS) normalization is applied.
fn dense_surface(
    u: f64,
    v: f64,
    u_degree: usize,
    v_degree: usize,
    control_points: &[Vec<Point3<f64>>],
    u_knots: &[f64],
    v_knots: &[f64],
    weights: Option<&[Vec<f64>]>,
) -> Point3<f64> {
    let mut result = Point3::new(0.0, 0.0, 0.0);
    let mut weight_sum = 0.0;

    // Table built once per axis per (u, v) sample, not once per (i, j)
    // (#4901). `n_v` is the longest row, not the first, so a ragged grid
    // still gets a valid value for every `j` a row actually has.
    let n_u = control_points.len();
    let n_v = control_points.iter().map(Vec::len).max().unwrap_or(0);
    let u_table = bspline_basis_table(u_degree, u, u_knots, n_u);
    let v_table = bspline_basis_table(v_degree, v, v_knots, n_v);

    for (i, row) in control_points.iter().enumerate() {
        let n_i = u_table.get(i).copied().unwrap_or(0.0);
        for (j, cp) in row.iter().enumerate() {
            let n_j = v_table.get(j).copied().unwrap_or(0.0);
            let basis = n_i * n_j;
            if basis.abs() > 1e-10 {
                let w = weights
                    .and_then(|ws| ws.get(i))
                    .and_then(|row_w| row_w.get(j))
                    .copied()
                    .unwrap_or(1.0);
                let weighted_basis = basis * w;
                result.x += weighted_basis * cp.x;
                result.y += weighted_basis * cp.y;
                result.z += weighted_basis * cp.z;
                weight_sum += weighted_basis;
            }
        }
    }

    // Rational normalization: divide by sum of weighted basis functions
    if weights.is_some() && weight_sum.abs() > 1e-10 {
        result.x /= weight_sum;
        result.y /= weight_sum;
        result.z /= weight_sum;
    }

    result
}

fn clamped_knots(count: usize, degree: usize) -> Vec<f64> {
    (0..count + degree + 1)
        .map(|i| i.saturating_sub(degree).min(count - degree) as f64)
        .collect()
}

fn grid(rows: usize, cols: usize) -> Vec<Vec<Point3<f64>>> {
    (0..rows)
        .map(|i| {
            (0..cols)
                .map(|j| {
                    Point3::new(
                        i as f64 * 0.13,
                        j as f64 * 0.17,
                        ((i * 37 + j * 11) % 23) as f64 * 0.07,
                    )
                })
                .collect()
        })
        .collect()
}

// #5321: differential oracle is the prior dense, row-major surface evaluation.
// This checks the complete tessellator's parameter sampling and rational sums,
// not just the sparse basis helper. Exact equality is the stated invariant:
// this optimization may remove work but must not change arithmetic order.
fn assert_dense_grid(
    cps: &[Vec<Point3<f64>>],
    degrees: (usize, usize),
    knots: (&[f64], &[f64]),
    weights: Option<&[Vec<f64>]>,
    segments: (usize, usize),
) {
    let (du, dv) = degrees;
    let (ku, kv) = knots;
    let (su, sv) = segments;
    let (positions, indices) = tessellate_bspline_surface(du, dv, cps, ku, kv, weights, su, sv)
        .expect("valid knot lengths");
    assert_eq!(positions.len(), (su + 1) * (sv + 1) * 3);
    assert_eq!(indices.len(), su * sv * 6);
    assert!(indices.iter().all(|&i| (i as usize) < positions.len() / 3));
    for i in 0..=su {
        let u_min = ku[du];
        let u_max = ku[ku.len() - du - 1];
        let u = (u_min + (u_max - u_min) * (i as f64 / su as f64))
            .min(u_max - 1e-6)
            .max(u_min);
        for j in 0..=sv {
            let v_min = kv[dv];
            let v_max = kv[kv.len() - dv - 1];
            let v = (v_min + (v_max - v_min) * (j as f64 / sv as f64))
                .min(v_max - 1e-6)
                .max(v_min);
            let expected = dense_surface(u, v, du, dv, cps, ku, kv, weights);
            let offset = (i * (sv + 1) + j) * 3;
            for axis in 0..3 {
                assert_eq!(
                    positions[offset + axis].to_bits(),
                    (expected[axis] as f32).to_bits(),
                    "sample ({i}, {j}), axis {axis}"
                );
            }
        }
    }
}

#[test]
fn issue_5321_sparse_surface_matches_dense_rational_and_nonrational_grids() {
    for degree in [0, 1, 2, 3, 5] {
        let cps = grid(11, 13);
        let weights: Vec<Vec<f64>> = (0..11)
            .map(|i| {
                (0..13)
                    .map(|j| 0.5 + ((i * 7 + j * 3) % 17) as f64 / 8.0)
                    .collect()
            })
            .collect();
        let ku = clamped_knots(11, degree);
        let kv = clamped_knots(13, degree);
        for w in [None, Some(weights.as_slice())] {
            assert_dense_grid(&cps, (degree, degree), (&ku, &kv), w, (17, 19));
        }
    }
}

#[test]
fn issue_5321_sparse_surface_preserves_ragged_rows_and_missing_weights() {
    let mut cps = grid(9, 11);
    cps[0].truncate(5);
    cps[2].clear();
    cps[4].truncate(3);
    let weights = vec![vec![2.0, 0.5], Vec::new(), vec![0.0; 11], vec![-0.25; 7]];
    let ku = clamped_knots(9, 3);
    let kv = clamped_knots(11, 2);
    assert_dense_grid(&cps, (3, 2), (&ku, &kv), Some(&weights), (12, 14));
}

#[test]
fn issue_5321_sparse_surface_preserves_repeated_knots_and_degenerate_domains() {
    let cps = grid(7, 7);
    let repeated = [0.0, 0.0, 0.0, 0.3, 0.3, 0.3, 0.7, 1.0, 1.0, 1.0];
    let constant = [1.0; 10];
    let nonmonotone = [0.0, 0.0, 0.0, 0.7, 0.3, 0.3, 0.1, 1.0, 1.0, 1.0];
    for knots in [&repeated[..], &constant[..], &nonmonotone[..]] {
        assert_dense_grid(&cps, (2, 2), (knots, &repeated), None, (9, 11));
    }
}

#[test]
fn issue_5321_sparse_surface_keeps_product_threshold_and_nonfinite_semantics() {
    let cps = grid(3, 3);
    // Exercise sparse construction too: a tiny but nonzero authored basis must
    // survive before the product is tested. A preconstructed sparse list alone
    // cannot catch an incorrect threshold in surface_basis.
    let tiny = surface_basis(1, 1e-12, &[0.0, 0.0, 1.0, 1.0], 2);
    assert_eq!(tiny, vec![(0, 1.0 - 1e-12), (1, 1e-12)]);
    let sparse_cps = vec![vec![Point3::origin()], vec![Point3::new(3.0, 4.0, 5.0)]];
    assert_eq!(
        evaluate_bspline_surface(&tiny, &[(0, 1e4)], &sparse_cps, None),
        sparse_cps[1][0] * 1e-8,
    );
    // Tiny axis weights cannot be dropped independently: their product can pass.
    let point = evaluate_bspline_surface(&[(1, 1e-12)], &[(2, 1e4)], &cps, None);
    assert_eq!(point, cps[1][2] * 1e-8);
    let point = evaluate_bspline_surface(&[(1, f64::NAN)], &[(2, 1.0)], &cps, None);
    assert_eq!(point, Point3::origin());
    let knots = [0.0, 0.0, 0.0, f64::NAN, 1.0, 1.0];
    assert_dense_grid(&cps, (2, 2), (&knots, &knots), None, (4, 5));
}

#[test]
fn issue_5321_dense_real_patch_dimensions_keep_exact_surface_samples() {
    // The real #472 fixture includes a 207x180 patch. This deterministic grid
    // exercises its breadth with both axes sampled repeatedly; the fixture's
    // independent geometry_correctness_harness snapshot checks real IFC output.
    let cps = grid(207, 180);
    let ku = clamped_knots(207, 3);
    let kv = clamped_knots(180, 3);
    assert_dense_grid(&cps, (3, 3), (&ku, &kv), None, (24, 24));
}

#[test]
fn issue_5321_dense_malformed_support_preserves_samples_beyond_cache_budget() {
    // Alternating knot intervals make degree-zero support dense instead of local.
    // Twenty-five V samples exceed the 4096-entry retention budget. The samples
    // recomputed after that budget is exhausted must still match dense evaluation.
    let cps = grid(3, 500);
    let ku = clamped_knots(3, 0);
    let kv: Vec<f64> = (0..=500).map(|i| (i % 2) as f64).collect();
    assert_dense_grid(&cps, (0, 0), (&ku, &kv), None, (7, 24));
}
