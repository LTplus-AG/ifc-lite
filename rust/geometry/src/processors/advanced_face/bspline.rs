// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Pure B-spline / NURBS surface and curve math, plus B-spline attribute parsing.

use super::bspline_budget::MAX_BSPLINE_DEGREE;
use crate::Point3;

/// Evaluate every basis function `N_{i,degree}(u)` for `i` in `0..count` in
/// one bottom-up (memoized) pass — see `bspline_budget.rs` for why the old
/// naive-recursive form was exponential in `degree`. Bit-identical to calling
/// it once per `i` (same recurrence, same epsilon guard), just computing each
/// `(level, index)` cell once. Local support bounds the table to level-0
/// width `count + degree` regardless of `knots.len()`. `degree` is clamped to
/// [`MAX_BSPLINE_DEGREE`] here, not just at call sites, so every caller is
/// protected (#4901).
fn bspline_basis_table(degree: usize, u: f64, knots: &[f64], count: usize) -> Vec<f64> {
    let degree = degree.min(MAX_BSPLINE_DEGREE);
    if count == 0 || knots.len() < 2 {
        return vec![0.0; count];
    }
    // Level-0 span count: N_{i,0} needs knots[i] and knots[i+1].
    let max_level0 = knots.len() - 1;
    let width = count.saturating_add(degree).saturating_add(1).min(max_level0);

    let mut cur: Vec<f64> = (0..width)
        .map(|i| if knots[i] <= u && u < knots[i + 1] { 1.0 } else { 0.0 })
        .collect();

    for k in 1..=degree {
        if cur.len() <= 1 {
            cur.clear();
            break;
        }
        let next_len = cur.len() - 1;
        let mut next = vec![0.0; next_len];
        for (i, slot) in next.iter_mut().enumerate() {
            let left = if i + k < knots.len() {
                let denom = knots[i + k] - knots[i];
                if denom.abs() < 1e-10 { 0.0 } else { (u - knots[i]) / denom * cur[i] }
            } else {
                0.0
            };
            let right = if i + k + 1 < knots.len() && i + 1 < cur.len() {
                let denom = knots[i + k + 1] - knots[i + 1];
                if denom.abs() < 1e-10 {
                    0.0
                } else {
                    (knots[i + k + 1] - u) / denom * cur[i + 1]
                }
            } else {
                0.0
            };
            *slot = left + right;
        }
        cur = next;
    }
    cur.resize(count, 0.0);
    cur
}

/// Evaluate a single B-spline basis function `N_{i,p}(u)`. Test-only:
/// production callers use [`bspline_basis_table`] directly so they build the
/// table once per sample point and reuse it across every `i`.
#[cfg(test)]
fn bspline_basis(i: usize, p: usize, u: f64, knots: &[f64]) -> f64 {
    bspline_basis_table(p, u, knots, i + 1)
        .get(i)
        .copied()
        .unwrap_or(0.0)
}

/// Keep authored index order and discard only exact zeros, NOT small values.
/// The acceptance threshold applies to the U*V product, so filtering each axis
/// by that threshold would change malformed/non-normalized knot behavior.
fn surface_basis(degree: usize, t: f64, knots: &[f64], count: usize) -> Vec<(usize, f64)> {
    bspline_basis_table(degree, t, knots, count)
        .into_iter()
        .enumerate()
        .filter(|(_, value)| *value != 0.0)
        .collect()
}

/// Evaluate the same ordered weighted sum using precomputed axis samples (#5321).
/// Skipping a zero factor is safe even with nonfinite values on the other axis:
/// their product is zero or NaN, neither of which passes the existing threshold.
fn evaluate_bspline_surface(
    u_basis: &[(usize, f64)],
    v_basis: &[(usize, f64)],
    control_points: &[Vec<Point3<f64>>],
    weights: Option<&[Vec<f64>]>,
) -> Point3<f64> {
    let mut result = Point3::new(0.0, 0.0, 0.0);
    let mut weight_sum = 0.0;
    for &(i, n_i) in u_basis {
        let Some(row) = control_points.get(i) else { continue };
        for &(j, n_j) in v_basis {
            let Some(cp) = row.get(j) else { continue };
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
    if weights.is_some() && weight_sum.abs() > 1e-10 {
        result.x /= weight_sum;
        result.y /= weight_sum;
        result.z /= weight_sum;
    }
    result
}

/// Tessellate a B-spline surface into triangles.
/// Returns `None` if the knot data is inconsistent (prevents index panics).
pub(super) fn tessellate_bspline_surface(
    u_degree: usize,
    v_degree: usize,
    control_points: &[Vec<Point3<f64>>],
    u_knots: &[f64],
    v_knots: &[f64],
    weights: Option<&[Vec<f64>]>,
    u_segments: usize,
    v_segments: usize,
) -> Option<(Vec<f32>, Vec<u32>)> {
    let mut positions = Vec::new();
    let mut indices = Vec::new();

    // Validate knot vector lengths: expanded knot vector must have at least
    // (num_control_points + degree + 1) entries. At minimum we need to be
    // able to index [degree] and [len - degree - 1] safely.
    let n_u = control_points.len();
    let n_v = control_points.first().map_or(0, |r| r.len());
    let min_u_knots = n_u + u_degree + 1;
    let min_v_knots = n_v + v_degree + 1;

    if u_knots.len() < min_u_knots || v_knots.len() < min_v_knots {
        return None;
    }
    if u_degree >= u_knots.len() || v_degree >= v_knots.len() {
        return None;
    }
    if u_knots.len() - u_degree > u_knots.len()
        || v_knots.len() - v_degree > v_knots.len()
    {
        return None;
    }

    // Get parameter domain
    let u_min = u_knots[u_degree];
    let u_max = u_knots[u_knots.len() - u_degree - 1];
    let v_min = v_knots[v_degree];
    let v_max = v_knots[v_knots.len() - v_degree - 1];

    // U is reused across a row; V is reused across all rows. Store only the
    // nonzero entries of each V sample, retaining the original summation order.
    // Use the longest row just as the dense evaluator did for ragged grids.
    let n_v_max = control_points.iter().map(Vec::len).max().unwrap_or(0);
    // Malformed non-monotone knots can have dense support. Bound retained
    // samples independently of the existing input-work limit; uncached samples
    // use the same evaluator and are recomputed one at a time.
    const MAX_CACHED_BASIS_ENTRIES: usize = 4096;
    let mut remaining = MAX_CACHED_BASIS_ENTRIES;
    let v_bases: Vec<_> = (0..=v_segments)
        .map(|j| {
            let v = v_min + (v_max - v_min) * (j as f64 / v_segments as f64);
            let v = v.min(v_max - 1e-6).max(v_min);
            let basis = surface_basis(v_degree, v, v_knots, n_v_max);
            let cached = if basis.len() <= remaining {
                remaining -= basis.len();
                Some(basis)
            } else {
                None
            };
            (v, cached)
        })
        .collect();
    for i in 0..=u_segments {
        let u = u_min + (u_max - u_min) * (i as f64 / u_segments as f64);
        let u = u.min(u_max - 1e-6).max(u_min);
        let u_basis = surface_basis(u_degree, u, u_knots, n_u);
        for (j, (v, cached)) in v_bases.iter().enumerate() {
            let scratch;
            let v_basis = match cached {
                Some(basis) => basis,
                None => {
                    scratch = surface_basis(v_degree, *v, v_knots, n_v_max);
                    &scratch
                }
            };
            let point = evaluate_bspline_surface(&u_basis, v_basis, control_points, weights);

            positions.push(point.x as f32);
            positions.push(point.y as f32);
            positions.push(point.z as f32);

            // Create triangles
            if i < u_segments && j < v_segments {
                let base = (i * (v_segments + 1) + j) as u32;
                let next_u = base + (v_segments + 1) as u32;

                // Two triangles per quad
                indices.push(base);
                indices.push(base + 1);
                indices.push(next_u + 1);

                indices.push(base);
                indices.push(next_u + 1);
                indices.push(next_u);
            }
        }
    }

    Some((positions, indices))
}

/// Evaluate a B-spline CURVE at parameter t (1D, not surface).
pub(super) fn evaluate_bspline_curve(
    t: f64,
    degree: usize,
    control_points: &[Point3<f64>],
    knots: &[f64],
) -> Point3<f64> {
    let mut result = Point3::new(0.0, 0.0, 0.0);
    // One table build for the whole curve point, not one per control point
    // (see `evaluate_bspline_surface` — same reasoning, #4901).
    let table = bspline_basis_table(degree, t, knots, control_points.len());
    for (i, cp) in control_points.iter().enumerate() {
        let basis = table.get(i).copied().unwrap_or(0.0);
        if basis.abs() > 1e-10 {
            result.x += basis * cp.x;
            result.y += basis * cp.y;
            result.z += basis * cp.z;
        }
    }
    result
}

#[cfg(test)]
#[path = "bspline_tests.rs"]
mod tests;
