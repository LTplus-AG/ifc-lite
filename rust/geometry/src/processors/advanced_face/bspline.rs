// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Pure B-spline / NURBS surface and curve math, plus B-spline attribute parsing.

use crate::{Error, Point3, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

/// Evaluate a B-spline basis function (Cox-de Boor recursion)
#[inline]
fn bspline_basis(i: usize, p: usize, u: f64, knots: &[f64]) -> f64 {
    if p == 0 {
        if knots[i] <= u && u < knots[i + 1] {
            1.0
        } else {
            0.0
        }
    } else {
        let left = {
            let denom = knots[i + p] - knots[i];
            if denom.abs() < 1e-10 {
                0.0
            } else {
                (u - knots[i]) / denom * bspline_basis(i, p - 1, u, knots)
            }
        };
        let right = {
            let denom = knots[i + p + 1] - knots[i + 1];
            if denom.abs() < 1e-10 {
                0.0
            } else {
                (knots[i + p + 1] - u) / denom * bspline_basis(i + 1, p - 1, u, knots)
            }
        };
        left + right
    }
}

/// Evaluate a B-spline surface at parameter (u, v).
/// When `weights` is `None` this is a standard (non-rational) evaluation.
/// When `weights` is `Some`, rational (NURBS) normalization is applied.
fn evaluate_bspline_surface(
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

    for (i, row) in control_points.iter().enumerate() {
        let n_i = bspline_basis(i, u_degree, u, u_knots);
        for (j, cp) in row.iter().enumerate() {
            let n_j = bspline_basis(j, v_degree, v, v_knots);
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

    // Evaluate surface on a grid
    for i in 0..=u_segments {
        let u = u_min + (u_max - u_min) * (i as f64 / u_segments as f64);
        // Clamp u to slightly inside the domain to avoid edge issues
        let u = u.min(u_max - 1e-6).max(u_min);

        for j in 0..=v_segments {
            let v = v_min + (v_max - v_min) * (j as f64 / v_segments as f64);
            let v = v.min(v_max - 1e-6).max(v_min);

            let point = evaluate_bspline_surface(
                u,
                v,
                u_degree,
                v_degree,
                control_points,
                u_knots,
                v_knots,
                weights,
            );

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

/// Parse rational weights from IfcRationalBSplineSurfaceWithKnots.
/// Attribute 12: WeightsData (LIST of LIST of REAL).
pub(crate) fn parse_rational_weights(bspline: &DecodedEntity) -> Option<Vec<Vec<f64>>> {
    let weights_attr = bspline.get(12)?;
    let rows = weights_attr.as_list()?;
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        let cols = row.as_list()?;
        let row_weights: Vec<f64> = cols.iter().filter_map(|v| v.as_float()).collect();
        if row_weights.is_empty() {
            return None;
        }
        result.push(row_weights);
    }
    Some(result)
}

/// Parse control points from B-spline surface entity
pub(super) fn parse_control_points(
    bspline: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<Vec<Vec<Point3<f64>>>> {
    // Attribute 2: ControlPointsList (LIST of LIST of IfcCartesianPoint)
    let cp_list_attr = bspline
        .get(2)
        .ok_or_else(|| Error::geometry("BSplineSurface missing ControlPointsList".to_string()))?;

    let rows = cp_list_attr
        .as_list()
        .ok_or_else(|| Error::geometry("Expected control point list".to_string()))?;

    let mut result = Vec::with_capacity(rows.len());

    for row in rows {
        let cols = row
            .as_list()
            .ok_or_else(|| Error::geometry("Expected control point row".to_string()))?;

        let mut row_points = Vec::with_capacity(cols.len());
        for col in cols {
            if let Some(point_id) = col.as_entity_ref() {
                let point = decoder.decode_by_id(point_id)?;
                let coords = point.get(0).and_then(|v| v.as_list()).ok_or_else(|| {
                    Error::geometry("CartesianPoint missing coordinates".to_string())
                })?;

                let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);

                row_points.push(Point3::new(x, y, z));
            }
        }
        result.push(row_points);
    }

    Ok(result)
}

/// Expand knot vector based on multiplicities
pub(super) fn expand_knots(knot_values: &[f64], multiplicities: &[i64]) -> Vec<f64> {
    let mut expanded = Vec::new();
    for (knot, &mult) in knot_values.iter().zip(multiplicities.iter()) {
        for _ in 0..mult {
            expanded.push(*knot);
        }
    }
    expanded
}

/// Parse knot vectors from B-spline surface entity
pub(super) fn parse_knot_vectors(bspline: &DecodedEntity) -> Result<(Vec<f64>, Vec<f64>)> {
    // IFCBSPLINESURFACEWITHKNOTS attributes:
    // 0: UDegree
    // 1: VDegree
    // 2: ControlPointsList (already parsed)
    // 3: SurfaceForm
    // 4: UClosed
    // 5: VClosed
    // 6: SelfIntersect
    // 7: UMultiplicities (LIST of INTEGER)
    // 8: VMultiplicities (LIST of INTEGER)
    // 9: UKnots (LIST of REAL)
    // 10: VKnots (LIST of REAL)
    // 11: KnotSpec

    // Get U multiplicities
    let u_mult_attr = bspline
        .get(7)
        .ok_or_else(|| Error::geometry("BSplineSurface missing UMultiplicities".to_string()))?;
    let u_mults: Vec<i64> = u_mult_attr
        .as_list()
        .ok_or_else(|| Error::geometry("Expected U multiplicities list".to_string()))?
        .iter()
        .filter_map(|v| v.as_int())
        .collect();

    // Get V multiplicities
    let v_mult_attr = bspline
        .get(8)
        .ok_or_else(|| Error::geometry("BSplineSurface missing VMultiplicities".to_string()))?;
    let v_mults: Vec<i64> = v_mult_attr
        .as_list()
        .ok_or_else(|| Error::geometry("Expected V multiplicities list".to_string()))?
        .iter()
        .filter_map(|v| v.as_int())
        .collect();

    // Get U knots
    let u_knots_attr = bspline
        .get(9)
        .ok_or_else(|| Error::geometry("BSplineSurface missing UKnots".to_string()))?;
    let u_knot_values: Vec<f64> = u_knots_attr
        .as_list()
        .ok_or_else(|| Error::geometry("Expected U knots list".to_string()))?
        .iter()
        .filter_map(|v| v.as_float())
        .collect();

    // Get V knots
    let v_knots_attr = bspline
        .get(10)
        .ok_or_else(|| Error::geometry("BSplineSurface missing VKnots".to_string()))?;
    let v_knot_values: Vec<f64> = v_knots_attr
        .as_list()
        .ok_or_else(|| Error::geometry("Expected V knots list".to_string()))?
        .iter()
        .filter_map(|v| v.as_float())
        .collect();

    // Expand knot vectors with multiplicities
    let u_knots = expand_knots(&u_knot_values, &u_mults);
    let v_knots = expand_knots(&v_knot_values, &v_mults);

    Ok((u_knots, v_knots))
}

/// Evaluate a B-spline CURVE at parameter t (1D, not surface).
pub(super) fn evaluate_bspline_curve(
    t: f64,
    degree: usize,
    control_points: &[Point3<f64>],
    knots: &[f64],
) -> Point3<f64> {
    let mut result = Point3::new(0.0, 0.0, 0.0);
    for (i, cp) in control_points.iter().enumerate() {
        let basis = bspline_basis(i, degree, t, knots);
        if basis.abs() > 1e-10 {
            result.x += basis * cp.x;
            result.y += basis * cp.y;
            result.z += basis * cp.z;
        }
    }
    result
}
