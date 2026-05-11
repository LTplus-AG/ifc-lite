// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared advanced face processing logic.
//!
//! Handles IfcAdvancedFace with B-spline, planar, and cylindrical surface types.
//! Used by both AdvancedBrepProcessor and ShellBasedSurfaceModelProcessor/FaceBasedSurfaceModelProcessor
//! when shells contain IfcAdvancedFace entities (common in CATIA exports).

use crate::triangulation::{calculate_polygon_normal, project_to_2d, triangulate_polygon};
use crate::{Error, Point3, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;

use super::helpers::get_axis2_placement_transform_by_id;

/// Process a single IfcAdvancedFace entity, dispatching to the appropriate
/// surface handler based on FaceSurface type.
///
/// Returns (positions, indices) for the tessellated face.
pub(super) fn process_advanced_face(
    face: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<(Vec<f32>, Vec<u32>)> {
    // IfcAdvancedFace has:
    // 0: Bounds (list of FaceBound)
    // 1: FaceSurface (IfcSurface - Plane, BSplineSurface, CylindricalSurface, etc.)
    // 2: SameSense (boolean)

    let surface_attr = face
        .get(1)
        .ok_or_else(|| Error::geometry("AdvancedFace missing FaceSurface".to_string()))?;

    let surface = decoder
        .resolve_ref(surface_attr)?
        .ok_or_else(|| Error::geometry("Failed to resolve FaceSurface".to_string()))?;

    let surface_type = surface.ifc_type.as_str().to_uppercase();

    // Read SameSense (attribute 2) - when false, triangle winding must be flipped
    let same_sense = face
        .get(2)
        .and_then(|a| a.as_enum())
        .map(|e| e == "T" || e == "TRUE")
        .unwrap_or(true);

    let result = if surface_type == "IFCPLANE" {
        process_planar_face(face, decoder)
    } else if surface_type == "IFCBSPLINESURFACEWITHKNOTS" {
        process_bspline_face(&surface, decoder, None)
    } else if surface_type == "IFCRATIONALBSPLINESURFACEWITHKNOTS" {
        let weights = parse_rational_weights(&surface);
        process_bspline_face(&surface, decoder, weights.as_deref())
    } else if surface_type == "IFCCYLINDRICALSURFACE" {
        process_cylindrical_face(face, &surface, decoder)
    } else if surface_type == "IFCSURFACEOFREVOLUTION" {
        process_surface_of_revolution_face(face, &surface, decoder)
    } else if surface_type == "IFCSURFACEOFLINEAREXTRUSION"
        || surface_type == "IFCCONICALSURFACE"
        || surface_type == "IFCSPHERICALSURFACE"
        || surface_type == "IFCTOROIDALSURFACE"
    {
        // For these surface types, the edge loop boundary vertices already lie
        // on the surface. Extracting and triangulating them gives a reasonable
        // polygonal approximation. This covers IfcSurfaceOfLinearExtrusion
        // (common in CATIA exports) and other analytic surface types.
        process_planar_face(face, decoder)
    } else {
        // Unsupported surface type - return empty geometry
        #[cfg(feature = "debug_geometry")]
        eprintln!(
            "[ifc-lite][advanced_face] face #{} unsupported surface {}",
            face.id, surface_type
        );
        Ok((Vec::new(), Vec::new()))
    };

    #[cfg(feature = "debug_geometry")]
    {
        if let Ok((ref pos, ref idx)) = result {
            if pos.is_empty() || idx.is_empty() {
                eprintln!(
                    "[ifc-lite][advanced_face] face #{} surface={} produced 0 tris (verts={}, idx={})",
                    face.id,
                    surface_type,
                    pos.len() / 3,
                    idx.len() / 3,
                );
            }
        }
    }

    // When SameSense is false, flip triangle winding to correct face orientation
    if !same_sense {
        result.map(|(positions, mut indices)| {
            for tri in indices.chunks_exact_mut(3) {
                tri.swap(0, 2);
            }
            (positions, indices)
        })
    } else {
        result
    }
}

// ---------- B-spline helpers ----------

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
fn tessellate_bspline_surface(
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
    if u_knots.len() - u_degree - 1 >= u_knots.len()
        || v_knots.len() - v_degree - 1 >= v_knots.len()
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
fn parse_rational_weights(bspline: &DecodedEntity) -> Option<Vec<Vec<f64>>> {
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
fn parse_control_points(
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
fn expand_knots(knot_values: &[f64], multiplicities: &[i64]) -> Vec<f64> {
    let mut expanded = Vec::new();
    for (knot, &mult) in knot_values.iter().zip(multiplicities.iter()) {
        for _ in 0..mult {
            expanded.push(*knot);
        }
    }
    expanded
}

/// Parse knot vectors from B-spline surface entity
fn parse_knot_vectors(bspline: &DecodedEntity) -> Result<(Vec<f64>, Vec<f64>)> {
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

// ---------- Surface-type-specific processors ----------

/// Extract a CartesianPoint's coordinates from a VertexPoint entity.
fn extract_vertex_coords(vertex: &DecodedEntity, decoder: &mut EntityDecoder) -> Option<Point3<f64>> {
    let point_attr = vertex.get(0)?;
    let point = decoder.resolve_ref(point_attr).ok().flatten()?;
    let coords = point.get(0).and_then(|v| v.as_list())?;
    let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
    let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
    let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
    Some(Point3::new(x, y, z))
}

/// Evaluate a B-spline CURVE at parameter t (1D, not surface).
fn evaluate_bspline_curve(
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

/// Sample points along a B-spline curve edge.
/// Returns the start vertex plus intermediate sample points.
/// The end vertex is omitted (provided by the next edge's start in the loop).
fn sample_bspline_edge_curve(
    curve: &DecodedEntity,
    start: &Point3<f64>,
    curve_forward: bool,
    decoder: &mut EntityDecoder,
) -> Vec<Point3<f64>> {
    // Parse B-spline curve: degree(0), control_points(1), ..., knot_mults(6), knots(7)
    let degree = curve.get_float(0).unwrap_or(3.0) as usize;

    // Parse control points (attribute 1: LIST of IfcCartesianPoint)
    let cp_list = match curve.get(1).and_then(|a| a.as_list()) {
        Some(list) => list,
        None => return vec![*start],
    };
    let control_points: Vec<Point3<f64>> = cp_list
        .iter()
        .filter_map(|ref_val| {
            let id = ref_val.as_entity_ref()?;
            let pt = decoder.decode_by_id(id).ok()?;
            let coords = pt.get(0)?.as_list()?;
            let x = coords.first()?.as_float().unwrap_or(0.0);
            let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
            let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
            Some(Point3::new(x, y, z))
        })
        .collect();

    if control_points.len() <= degree {
        return vec![*start];
    }

    // Parse knot multiplicities (attribute 6) and knot values (attribute 7)
    let mults: Vec<i64> = curve
        .get(6)
        .and_then(|a| a.as_list())
        .map(|l| l.iter().filter_map(|v| v.as_int()).collect())
        .unwrap_or_default();
    let knot_values: Vec<f64> = curve
        .get(7)
        .and_then(|a| a.as_list())
        .map(|l| l.iter().filter_map(|v| v.as_float()).collect())
        .unwrap_or_default();

    if mults.is_empty() || knot_values.is_empty() {
        return vec![*start];
    }

    let knots = expand_knots(&knot_values, &mults);
    let t_min = knots[degree];
    let t_max = knots[knots.len() - degree - 1];

    // Adaptive segment count based on control point density
    let n_segments = (control_points.len() * 2).clamp(4, 16);

    let mut points = Vec::with_capacity(n_segments + 1);
    // Add the start vertex first
    points.push(*start);

    // Sample intermediate points (skip last = next edge's start vertex)
    for i in 1..n_segments {
        let frac = i as f64 / n_segments as f64;
        let t = if curve_forward {
            t_min + (t_max - t_min) * frac
        } else {
            t_max - (t_max - t_min) * frac
        };
        let t_clamped = t.min(t_max - 1e-6).max(t_min);
        let pt = evaluate_bspline_curve(t_clamped, degree, &control_points, &knots);
        // Skip degenerate points (too close to previous)
        if let Some(prev) = points.last() {
            let dist_sq = (pt.x - prev.x).powi(2) + (pt.y - prev.y).powi(2) + (pt.z - prev.z).powi(2);
            if dist_sq < 1e-12 {
                continue;
            }
        }
        points.push(pt);
    }

    points
}

/// Read an `IfcAxis2Placement3D` (or 2D) entity and return (location, axis_z, axis_x).
/// Falls back to identity orientation when axis/refdir are absent.
fn read_axis2_placement_3d(
    placement: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> (Point3<f64>, nalgebra::Vector3<f64>, nalgebra::Vector3<f64>) {
    use nalgebra::Vector3;

    let location = placement
        .get(0)
        .and_then(|a| decoder.resolve_ref(a).ok().flatten())
        .and_then(|p| {
            let coords = p.get(0).and_then(|v| v.as_list())?;
            let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
            let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
            let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
            Some(Point3::new(x, y, z))
        })
        .unwrap_or_else(|| Point3::new(0.0, 0.0, 0.0));

    let read_dir = |entity: &DecodedEntity| -> Option<Vector3<f64>> {
        let coords = entity.get(0).and_then(|v| v.as_list())?;
        let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
        let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
        let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
        Some(Vector3::new(x, y, z))
    };

    let axis_z = placement
        .get(1)
        .and_then(|a| decoder.resolve_ref(a).ok().flatten())
        .and_then(|e| read_dir(&e))
        .and_then(|v| v.try_normalize(1e-12))
        .unwrap_or_else(|| Vector3::new(0.0, 0.0, 1.0));

    let mut axis_x = placement
        .get(2)
        .and_then(|a| decoder.resolve_ref(a).ok().flatten())
        .and_then(|e| read_dir(&e))
        .unwrap_or_else(|| {
            // Pick a non-parallel reference if RefDirection is missing
            if axis_z.x.abs() < 0.9 {
                Vector3::new(1.0, 0.0, 0.0)
            } else {
                Vector3::new(0.0, 1.0, 0.0)
            }
        });

    // Orthogonalise: subtract the component along axis_z, then renormalise
    axis_x -= axis_z * axis_x.dot(&axis_z);
    let axis_x = axis_x.try_normalize(1e-12).unwrap_or_else(|| {
        // Fallback that is guaranteed NOT parallel to axis_z: pick the world
        // basis vector with the smallest |dot| with axis_z, then orthogonalise.
        // Using a hard-coded (1,0,0) here can collapse the basis when axis_z
        // itself is along X (CodeRabbit feedback on PR #605).
        let candidates = [
            Vector3::new(1.0, 0.0, 0.0),
            Vector3::new(0.0, 1.0, 0.0),
            Vector3::new(0.0, 0.0, 1.0),
        ];
        let pick = candidates
            .iter()
            .min_by(|a, b| {
                let da = axis_z.dot(a).abs();
                let db = axis_z.dot(b).abs();
                da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
            })
            .copied()
            .unwrap_or(Vector3::new(1.0, 0.0, 0.0));
        let ortho = pick - axis_z * pick.dot(&axis_z);
        ortho
            .try_normalize(1e-12)
            .unwrap_or(Vector3::new(1.0, 0.0, 0.0))
    });

    (location, axis_z, axis_x)
}

/// Sample an `IfcCircle` edge from `start` to `end`, walking the arc in the
/// curve's native (CCW around axis_z) direction when `curve_forward` is true,
/// otherwise CW. Returns `start` plus intermediate samples; the end vertex is
/// omitted because the next edge in the loop starts there.
fn sample_circle_edge_curve(
    curve: &DecodedEntity,
    start: &Point3<f64>,
    end: &Point3<f64>,
    curve_forward: bool,
    decoder: &mut EntityDecoder,
) -> Vec<Point3<f64>> {
    use std::f64::consts::TAU;

    // IfcCircle: 0=Position(IfcAxis2Placement3D|2D), 1=Radius
    let radius = match curve.get(1).and_then(|v| v.as_float()) {
        Some(r) if r > 0.0 => r,
        _ => return vec![*start],
    };

    let placement = match curve.get(0).and_then(|a| decoder.resolve_ref(a).ok().flatten()) {
        Some(p) => p,
        None => return vec![*start],
    };

    let (center, axis_z, axis_x) = read_axis2_placement_3d(&placement, decoder);
    let axis_y = axis_z.cross(&axis_x);

    // Project start/end onto the circle plane to recover their angles.
    let project_angle = |p: &Point3<f64>| -> f64 {
        let v = p - center;
        v.dot(&axis_y).atan2(v.dot(&axis_x))
    };

    let a_start = project_angle(start);
    let a_end = project_angle(end);

    // Signed CCW arc length from a_start to a_end, in (0, 2π].
    let mut ccw_delta = (a_end - a_start).rem_euclid(TAU);
    let mut cw_delta = (a_start - a_end).rem_euclid(TAU);

    // Treat coincident endpoints as a full 360° arc (full circle in topology).
    let coincident = (start - end).norm() < 1e-6 * radius.max(1.0);
    if coincident || ccw_delta < 1e-9 {
        ccw_delta = TAU;
        cw_delta = TAU;
    }

    let (delta, sign) = if curve_forward {
        (ccw_delta, 1.0_f64)
    } else {
        (cw_delta, -1.0_f64)
    };

    // ~12° per segment, clamped to keep simple half-turns affordable.
    let n_segments = ((delta / (TAU / 30.0)).ceil() as usize).clamp(2, 32);

    let mut points = Vec::with_capacity(n_segments);
    points.push(*start);
    for i in 1..n_segments {
        let t = delta * (i as f64) / (n_segments as f64);
        let angle = a_start + sign * t;
        let p = center + axis_x * (radius * angle.cos()) + axis_y * (radius * angle.sin());
        points.push(p);
    }
    points
}

/// Extract polygon points from an edge loop, sampling B-spline curve edges
/// for intermediate points to preserve curvature.
fn extract_edge_loop_points(
    loop_entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Vec<Point3<f64>> {
    let edges = match loop_entity.get(0).and_then(|a| a.as_list()) {
        Some(e) => e,
        None => return Vec::new(),
    };

    let mut polygon_points = Vec::new();

    for edge_ref in edges {
        let edge_id = match edge_ref.as_entity_ref() {
            Some(id) => id,
            None => continue,
        };
        let oriented_edge = match decoder.decode_by_id(edge_id) {
            Ok(e) => e,
            Err(_) => continue,
        };

        // IfcOrientedEdge: EdgeStart(0), EdgeEnd(1), EdgeElement(2), Orientation(3)
        let orientation = oriented_edge
            .get(3)
            .and_then(|a| a.as_enum())
            .map(|e| e == "T" || e == "TRUE")
            .unwrap_or(true);

        // Get the EdgeElement (IfcEdgeCurve)
        let edge_curve = match oriented_edge
            .get(2)
            .and_then(|attr| decoder.resolve_ref(attr).ok().flatten())
        {
            Some(ec) => ec,
            None => {
                // Fallback: extract start vertex only
                let vertex = oriented_edge
                    .get(0)
                    .and_then(|attr| decoder.resolve_ref(attr).ok().flatten());
                if let Some(v) = vertex {
                    if let Some(pt) = extract_vertex_coords(&v, decoder) {
                        polygon_points.push(pt);
                    }
                }
                continue;
            }
        };

        // IfcEdgeCurve: EdgeStart(0), EdgeEnd(1), EdgeGeometry(2), SameSense(3)
        let edge_same_sense = edge_curve.get(3).and_then(|a| a.as_enum())
            .map(|e| e == "T" || e == "TRUE").unwrap_or(true);

        // Orientation determines which direction we walk the edge in the loop:
        //   TRUE  → EdgeStart to EdgeEnd
        //   FALSE → EdgeEnd to EdgeStart
        // SameSense determines curve parameterization relative to edge direction:
        //   TRUE  → curve t_min→t_max goes EdgeStart→EdgeEnd
        //   FALSE → curve t_max→t_min goes EdgeStart→EdgeEnd
        // Combined: traverse curve forward when orientation==edge_same_sense
        let curve_forward = orientation == edge_same_sense;

        // Get start and end vertices from EdgeCurve
        let start_vertex = edge_curve
            .get(0)
            .and_then(|attr| decoder.resolve_ref(attr).ok().flatten());
        let end_vertex = edge_curve
            .get(1)
            .and_then(|attr| decoder.resolve_ref(attr).ok().flatten());

        let edge_start_pt = start_vertex.as_ref().and_then(|v| extract_vertex_coords(v, decoder));
        let edge_end_pt = end_vertex.as_ref().and_then(|v| extract_vertex_coords(v, decoder));

        // Walk direction is based on Orientation only (not SameSense):
        //   Orientation TRUE  → we encounter EdgeStart first
        //   Orientation FALSE → we encounter EdgeEnd first
        let (walk_start, _walk_end) = if orientation {
            (edge_start_pt, edge_end_pt)
        } else {
            (edge_end_pt, edge_start_pt)
        };

        // Get the edge geometry to check if it's a curve
        let edge_geometry = edge_curve
            .get(2)
            .and_then(|attr| decoder.resolve_ref(attr).ok().flatten());

        if let Some(geom) = edge_geometry {
            let geom_type = geom.ifc_type.as_str().to_uppercase();
            if geom_type == "IFCBSPLINECURVEWITHKNOTS" {
                // Sample B-spline curve for intermediate points
                let s = walk_start.unwrap_or(Point3::new(0.0, 0.0, 0.0));
                let sampled = sample_bspline_edge_curve(&geom, &s, curve_forward, decoder);
                polygon_points.extend(sampled);
                continue;
            }
            if geom_type == "IFCCIRCLE" {
                // Sample arc from walk_start to the next edge's start (i.e. the
                // other endpoint of THIS edge in the loop's walk direction).
                // Without this, every circular boundary collapses to a single
                // vertex per edge — disc caps and curved fillets become slivers.
                if let (Some(s), Some(e)) = (walk_start, _walk_end) {
                    let sampled = sample_circle_edge_curve(&geom, &s, &e, curve_forward, decoder);
                    polygon_points.extend(sampled);
                    continue;
                }
            }
            // For IfcLine and other straight/unsupported curves: just use start
            // vertex (the next edge contributes its own start, so straight lines
            // are correctly represented by their two endpoints).
        }

        // Default: add start vertex only
        if let Some(pt) = walk_start {
            polygon_points.push(pt);
        }
    }

    polygon_points
}

/// Process a planar or boundary-represented face.
/// Extracts edge loop boundary points (with B-spline curve sampling)
/// and triangulates with robust ear-cutting.
fn process_planar_face(
    face: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<(Vec<f32>, Vec<u32>)> {
    let bounds_attr = face
        .get(0)
        .ok_or_else(|| Error::geometry("AdvancedFace missing Bounds".to_string()))?;
    let bounds = bounds_attr
        .as_list()
        .ok_or_else(|| Error::geometry("Expected bounds list".to_string()))?;

    let mut positions = Vec::new();
    let mut indices = Vec::new();

    for bound in bounds {
        if let Some(bound_id) = bound.as_entity_ref() {
            let bound_entity = decoder.decode_by_id(bound_id)?;

            let loop_attr = bound_entity
                .get(0)
                .ok_or_else(|| Error::geometry("FaceBound missing Bound".to_string()))?;

            let loop_entity = decoder
                .resolve_ref(loop_attr)?
                .ok_or_else(|| Error::geometry("Failed to resolve loop".to_string()))?;

            if !loop_entity.ifc_type.as_str().eq_ignore_ascii_case("IFCEDGELOOP") {
                continue;
            }

            // Extract polygon points with B-spline curve sampling
            let polygon_points = extract_edge_loop_points(&loop_entity, decoder);

            if polygon_points.len() >= 3 {
                let base_idx = (positions.len() / 3) as u32;

                for point in &polygon_points {
                    positions.push(point.x as f32);
                    positions.push(point.y as f32);
                    positions.push(point.z as f32);
                }

                // Project 3D polygon to 2D for robust ear-cutting triangulation
                let normal = calculate_polygon_normal(&polygon_points);
                let (points_2d, _, _, _) = project_to_2d(&polygon_points, &normal);

                match triangulate_polygon(&points_2d) {
                    Ok(tri_indices) => {
                        for idx in tri_indices {
                            indices.push(base_idx + idx as u32);
                        }
                    }
                    Err(_) => {
                        // Fallback to fan triangulation
                        for i in 1..polygon_points.len() - 1 {
                            indices.push(base_idx);
                            indices.push(base_idx + i as u32);
                            indices.push(base_idx + i as u32 + 1);
                        }
                    }
                }
            }
        }
    }

    Ok((positions, indices))
}

/// Process a B-spline surface face.
/// When `weights` is `Some`, rational (NURBS) evaluation is used.
fn process_bspline_face(
    bspline: &DecodedEntity,
    decoder: &mut EntityDecoder,
    weights: Option<&[Vec<f64>]>,
) -> Result<(Vec<f32>, Vec<u32>)> {
    // Get degrees
    let u_degree = bspline.get_float(0).unwrap_or(3.0) as usize;
    let v_degree = bspline.get_float(1).unwrap_or(1.0) as usize;

    // Parse control points
    let control_points = parse_control_points(bspline, decoder)?;

    // Parse knot vectors
    let (u_knots, v_knots) = parse_knot_vectors(bspline)?;

    // Determine tessellation resolution based on surface complexity
    let u_segments = (control_points.len() * 3).clamp(8, 24);
    let v_segments = if !control_points.is_empty() {
        (control_points[0].len() * 3).clamp(4, 24)
    } else {
        4
    };

    // Tessellate the surface (returns None if knot data is inconsistent)
    match tessellate_bspline_surface(
        u_degree,
        v_degree,
        &control_points,
        &u_knots,
        &v_knots,
        weights,
        u_segments,
        v_segments,
    ) {
        Some((positions, indices)) => Ok((positions, indices)),
        None => Ok((Vec::new(), Vec::new())),
    }
}

/// Process a cylindrical surface face
fn process_cylindrical_face(
    face: &DecodedEntity,
    surface: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<(Vec<f32>, Vec<u32>)> {
    // Get the radius from IfcCylindricalSurface (attribute 1)
    let radius = surface
        .get(1)
        .and_then(|v| v.as_float())
        .ok_or_else(|| Error::geometry("CylindricalSurface missing Radius".to_string()))?;

    // Get position/axis from IfcCylindricalSurface (attribute 0)
    let position_attr = surface.get(0);
    let axis_transform = if let Some(attr) = position_attr {
        if let Some(pos_id) = attr.as_entity_ref() {
            get_axis2_placement_transform_by_id(pos_id, decoder)?
        } else {
            Matrix4::identity()
        }
    } else {
        Matrix4::identity()
    };

    // Extract boundary points using the shared edge-loop sampler so that
    // B-spline and circle edges contribute interpolated points (instead of
    // collapsing the boundary to vertex corners). This is critical for the
    // glazing-mullion fillet faces in IFC4 door exports, where each
    // cylindrical face has B-spline edge curves running along the surface.
    let boundary_points: Vec<Point3<f64>> = extract_edge_loop_points_for_bounds(face, decoder);

    if boundary_points.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }

    // Transform boundary points to local cylinder coordinates
    let inv_transform = axis_transform
        .try_inverse()
        .unwrap_or(Matrix4::identity());
    let local_points: Vec<Point3<f64>> = boundary_points
        .iter()
        .map(|p| inv_transform.transform_point(p))
        .collect();

    // Determine angular extent via the largest-gap-on-the-circle algorithm
    // (same approach as SoR). Robust to faces that straddle θ=π — the
    // previous min/max + wrap heuristic could give a 270° span for a
    // half-cylinder face whose samples cluster at the seam, leaving a
    // visible misalignment with the opposite half.
    let mut angles: Vec<f64> = local_points
        .iter()
        .map(|p| {
            let mut a = p.y.atan2(p.x);
            if a < 0.0 {
                a += std::f64::consts::TAU;
            }
            a
        })
        .collect();
    angles.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    angles.dedup_by(|a, b| (*a - *b).abs() < 1e-6);

    let (min_angle, max_angle) = if angles.len() < 2 {
        (0.0, std::f64::consts::TAU)
    } else {
        let n = angles.len();
        let mut max_gap = 0.0;
        let mut max_gap_idx = 0usize;
        for i in 0..n {
            let next = if i + 1 < n {
                angles[i + 1]
            } else {
                angles[0] + std::f64::consts::TAU
            };
            let gap = next - angles[i];
            if gap > max_gap {
                max_gap = gap;
                max_gap_idx = i;
            }
        }
        let start = angles[(max_gap_idx + 1) % n];
        let end_raw = angles[max_gap_idx];
        let end = if end_raw < start {
            end_raw + std::f64::consts::TAU
        } else {
            end_raw
        };
        let span = end - start;
        if span < 1e-6 || span > std::f64::consts::TAU - 1e-6 {
            (0.0, std::f64::consts::TAU)
        } else {
            (start, end)
        }
    };

    let mut min_z = f64::MAX;
    let mut max_z = f64::MIN;
    for p in &local_points {
        min_z = min_z.min(p.z);
        max_z = max_z.max(p.z);
    }

    // Tessellation parameters
    let angle_span = max_angle - min_angle;
    let height = max_z - min_z;

    // Balance between accuracy and matching web-ifc's output
    // Use ~10 degrees per segment for smooth handle/glazing curvature
    let angle_segments =
        ((angle_span / (std::f64::consts::PI / 18.0)).ceil() as usize).clamp(6, 32);
    // Height segments based on aspect ratio - at least 1, more for tall cylinders
    let height_segments = ((height / (radius * 2.0)).ceil() as usize).clamp(1, 8);

    let mut positions = Vec::new();
    let mut indices = Vec::new();

    // Generate cylinder patch vertices
    for h in 0..=height_segments {
        let z = min_z + (height * h as f64 / height_segments as f64);
        for a in 0..=angle_segments {
            let angle = min_angle + (angle_span * a as f64 / angle_segments as f64);
            let x = radius * angle.cos();
            let y = radius * angle.sin();

            // Transform back to world coordinates
            let local_point = Point3::new(x, y, z);
            let world_point = axis_transform.transform_point(&local_point);

            positions.push(world_point.x as f32);
            positions.push(world_point.y as f32);
            positions.push(world_point.z as f32);
        }
    }

    // Generate indices for quad strip
    let cols = angle_segments + 1;
    for h in 0..height_segments {
        for a in 0..angle_segments {
            let base = (h * cols + a) as u32;
            let next_row = base + cols as u32;

            // Two triangles per quad
            indices.push(base);
            indices.push(base + 1);
            indices.push(next_row + 1);

            indices.push(base);
            indices.push(next_row + 1);
            indices.push(next_row);
        }
    }

    Ok((positions, indices))
}

// ---------- Surface-of-revolution ----------

/// Sample points along a curve in 3D. Currently handles `IfcLine`, `IfcCircle`,
/// `IfcTrimmedCurve` and `IfcBSplineCurveWithKnots`. Returns a polyline that
/// approximates the curve. Used as the generator profile for surfaces of
/// revolution.
fn sample_curve_polyline(
    curve: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Vec<Point3<f64>> {
    use std::f64::consts::TAU;
    let kind = curve.ifc_type.as_str().to_uppercase();
    if kind == "IFCBSPLINECURVEWITHKNOTS" {
        // Reuse the helper with a synthetic start; we just need the polyline.
        let mut pts = sample_bspline_edge_curve(
            curve,
            &Point3::new(0.0, 0.0, 0.0),
            true,
            decoder,
        );
        if !pts.is_empty() {
            // Replace the synthetic start with an explicit evaluation at t_min.
            let degree = curve.get_float(0).unwrap_or(3.0) as usize;
            if let (Some(cp_list), Some(mults), Some(knot_values)) = (
                curve.get(1).and_then(|a| a.as_list()),
                curve
                    .get(6)
                    .and_then(|a| a.as_list())
                    .map(|l| l.iter().filter_map(|v| v.as_int()).collect::<Vec<_>>()),
                curve
                    .get(7)
                    .and_then(|a| a.as_list())
                    .map(|l| l.iter().filter_map(|v| v.as_float()).collect::<Vec<_>>()),
            ) {
                let cps: Vec<Point3<f64>> = cp_list
                    .iter()
                    .filter_map(|r| {
                        let id = r.as_entity_ref()?;
                        let pt = decoder.decode_by_id(id).ok()?;
                        let coords = pt.get(0)?.as_list()?;
                        let x = coords.first()?.as_float().unwrap_or(0.0);
                        let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                        let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
                        Some(Point3::new(x, y, z))
                    })
                    .collect();
                if !cps.is_empty() && !mults.is_empty() && !knot_values.is_empty() {
                    let knots = expand_knots(&knot_values, &mults);
                    if knots.len() > degree {
                        let t0 = knots[degree];
                        pts[0] = evaluate_bspline_curve(t0, degree, &cps, &knots);
                        // Also append the explicit terminal endpoint so
                        // standalone polyline callers (e.g. SoR generator
                        // profiles) don't lose the last segment. Edge-loop
                        // callers tolerate the duplicate via dedup later.
                        // Per CodeRabbit feedback on PR #605.
                        let t_max_idx = knots.len().saturating_sub(degree + 1);
                        if t_max_idx > degree {
                            let t_max = knots[t_max_idx];
                            let p_end = evaluate_bspline_curve(t_max, degree, &cps, &knots);
                            // Avoid duplicating the last sampled point.
                            let near_dup = pts
                                .last()
                                .map(|p| (p - p_end).norm_squared() < 1e-18)
                                .unwrap_or(false);
                            if !near_dup {
                                pts.push(p_end);
                            }
                        }
                    }
                }
            }
        }
        return pts;
    }
    if kind == "IFCLINE" {
        // IfcLine: 0=Pnt, 1=Dir(IfcVector). Treat as segment [Pnt, Pnt+Dir·magnitude].
        let pnt = curve
            .get(0)
            .and_then(|a| decoder.resolve_ref(a).ok().flatten())
            .and_then(|p| {
                let coords = p.get(0).and_then(|v| v.as_list())?;
                let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
                Some(Point3::new(x, y, z))
            });
        let (dir, mag) = curve
            .get(1)
            .and_then(|a| decoder.resolve_ref(a).ok().flatten())
            .map(|v| {
                let direction = v.get(0).and_then(|a| decoder.resolve_ref(a).ok().flatten());
                let magnitude = v.get(1).and_then(|a| a.as_float()).unwrap_or(1.0);
                let dir = direction
                    .and_then(|d| {
                        let coords = d.get(0).and_then(|v| v.as_list())?;
                        let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                        let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                        let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
                        Some(nalgebra::Vector3::new(x, y, z))
                    })
                    .and_then(|v| v.try_normalize(1e-12))
                    .unwrap_or_else(|| nalgebra::Vector3::new(1.0, 0.0, 0.0));
                (dir, magnitude)
            })
            .unwrap_or_else(|| (nalgebra::Vector3::new(1.0, 0.0, 0.0), 1.0));
        let start = pnt.unwrap_or_else(|| Point3::new(0.0, 0.0, 0.0));
        return vec![start, start + dir * mag];
    }
    if kind == "IFCCIRCLE" {
        let radius = curve.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
        if radius <= 0.0 {
            return Vec::new();
        }
        let placement = match curve.get(0).and_then(|a| decoder.resolve_ref(a).ok().flatten()) {
            Some(p) => p,
            None => return Vec::new(),
        };
        let (center, axis_z, axis_x) = read_axis2_placement_3d(&placement, decoder);
        let axis_y = axis_z.cross(&axis_x);
        let n = 24usize;
        return (0..=n)
            .map(|i| {
                let a = TAU * (i as f64) / (n as f64);
                center + axis_x * (radius * a.cos()) + axis_y * (radius * a.sin())
            })
            .collect();
    }
    if kind == "IFCTRIMMEDCURVE" {
        // 0=BasisCurve, 1=Trim1, 2=Trim2, 3=Sense, 4=MasterRepresentation.
        let basis = match curve.get(0).and_then(|a| decoder.resolve_ref(a).ok().flatten()) {
            Some(b) => b,
            None => return Vec::new(),
        };
        let basis_kind = basis.ifc_type.as_str().to_uppercase();
        let sense = curve
            .get(3)
            .and_then(|a| a.as_enum())
            .map(|e| e == "T" || e == "TRUE")
            .unwrap_or(true);

        let mut read_trim_point = |idx: usize| -> Option<Point3<f64>> {
            let list = curve.get(idx)?.as_list()?;
            for v in list {
                if let Some(id) = v.as_entity_ref() {
                    if let Ok(e) = decoder.decode_by_id(id) {
                        if e.ifc_type.as_str().eq_ignore_ascii_case("IFCCARTESIANPOINT") {
                            let coords = e.get(0).and_then(|a| a.as_list())?;
                            let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                            let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                            let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
                            return Some(Point3::new(x, y, z));
                        }
                    }
                }
            }
            None
        };

        let p1 = read_trim_point(1);
        let p2 = read_trim_point(2);

        if basis_kind == "IFCCIRCLE" {
            if let (Some(p_start), Some(p_end)) = (p1, p2) {
                // Edge-loop callers consume `start..pre_end` and rely on the
                // *next* edge to add the end vertex. When this helper is used
                // standalone (e.g. as a surface-of-revolution generator
                // profile) we have to append the terminal point ourselves so
                // the polyline isn't truncated by one segment.
                // Per CodeRabbit feedback on PR #605.
                let mut pts = sample_circle_edge_curve(&basis, &p_start, &p_end, sense, decoder);
                pts.push(p_end);
                return pts;
            }
        }
        if basis_kind == "IFCBSPLINECURVEWITHKNOTS" {
            if let (Some(p_start), Some(p_end)) = (p1, p2) {
                let mut pts = sample_bspline_edge_curve(&basis, &p_start, sense, decoder);
                pts.push(p_end);
                return pts;
            }
            if let Some(p_start) = p1 {
                return sample_bspline_edge_curve(&basis, &p_start, sense, decoder);
            }
        }
        return sample_curve_polyline(&basis, decoder);
    }
    Vec::new()
}

/// Tessellate an `IfcSurfaceOfRevolution` face by sweeping its profile curve
/// around the axis through the angular extent recovered from the face's edge
/// loops. Falls back to the planar boundary approximation when the profile or
/// axis can't be parsed.
fn process_surface_of_revolution_face(
    face: &DecodedEntity,
    surface: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<(Vec<f32>, Vec<u32>)> {
    use nalgebra::Vector3;
    use std::f64::consts::TAU;

    let swept = surface
        .get(0)
        .and_then(|a| decoder.resolve_ref(a).ok().flatten());
    let axis_pos = surface
        .get(1)
        .and_then(|a| decoder.resolve_ref(a).ok().flatten());

    let (axis_origin, axis_dir) = if let Some(ap) = axis_pos {
        // IfcAxis1Placement: 0=Location, 1=Axis(Direction)
        let loc = ap
            .get(0)
            .and_then(|a| decoder.resolve_ref(a).ok().flatten())
            .and_then(|p| {
                let coords = p.get(0).and_then(|v| v.as_list())?;
                let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
                Some(Point3::new(x, y, z))
            })
            .unwrap_or_else(|| Point3::new(0.0, 0.0, 0.0));
        let dir = ap
            .get(1)
            .and_then(|a| decoder.resolve_ref(a).ok().flatten())
            .and_then(|d| {
                let coords = d.get(0).and_then(|v| v.as_list())?;
                let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
                let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
                let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
                Some(Vector3::new(x, y, z))
            })
            .and_then(|v| v.try_normalize(1e-12))
            .unwrap_or_else(|| Vector3::new(0.0, 0.0, 1.0));
        (loc, dir)
    } else {
        (Point3::new(0.0, 0.0, 0.0), Vector3::new(0.0, 0.0, 1.0))
    };

    // Sample the generator profile curve.
    let profile_pts: Vec<Point3<f64>> = match swept {
        Some(s) if s.ifc_type.as_str().eq_ignore_ascii_case("IFCARBITRARYOPENPROFILEDEF") => {
            // Attribute 2 is the curve.
            if let Some(curve) = s.get(2).and_then(|a| decoder.resolve_ref(a).ok().flatten()) {
                sample_curve_polyline(&curve, decoder)
            } else {
                Vec::new()
            }
        }
        Some(s) => sample_curve_polyline(&s, decoder),
        None => Vec::new(),
    };

    if profile_pts.len() < 2 {
        return process_planar_face(face, decoder);
    }

    // Build an orthonormal basis (axis_x, axis_y, axis_dir).
    let ref_dir = if axis_dir.x.abs() < 0.9 {
        Vector3::new(1.0, 0.0, 0.0)
    } else {
        Vector3::new(0.0, 1.0, 0.0)
    };
    let axis_x = (ref_dir - axis_dir * ref_dir.dot(&axis_dir))
        .try_normalize(1e-12)
        .unwrap_or_else(|| Vector3::new(1.0, 0.0, 0.0));
    let axis_y = axis_dir.cross(&axis_x);

    // Determine angular extent from the boundary edge points. We project each
    // boundary point's radial vector to a [0, TAU) angle, then find the
    // *largest gap* between sorted angles — the face occupies the complement.
    // This robustly handles faces that straddle the θ=π discontinuity (e.g.
    // a fillet at θ=−π/2..π) where naive min/max gives 3π/2 instead of π/2.
    let boundary = extract_edge_loop_points_for_bounds(face, decoder);
    let (a_min, span) = if boundary.is_empty() {
        (0.0, TAU)
    } else {
        let mut angles: Vec<f64> = boundary
            .iter()
            .map(|p| {
                let v = p - axis_origin;
                let mut a = v.dot(&axis_y).atan2(v.dot(&axis_x));
                if a < 0.0 {
                    a += TAU;
                }
                a
            })
            .collect();
        angles.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        angles.dedup_by(|a, b| (*a - *b).abs() < 1e-6);

        if angles.len() < 2 {
            (0.0, TAU)
        } else {
            let n = angles.len();
            let mut max_gap = 0.0;
            let mut max_gap_idx = 0usize;
            for i in 0..n {
                let next = if i + 1 < n { angles[i + 1] } else { angles[0] + TAU };
                let gap = next - angles[i];
                if gap > max_gap {
                    max_gap = gap;
                    max_gap_idx = i;
                }
            }
            // The face occupies the complement of the largest gap. If the
            // boundary samples are all on one side, the largest gap is on the
            // other side, and the face spans angles[(idx+1)%n] → angles[idx]+TAU.
            let start = angles[(max_gap_idx + 1) % n];
            let end_raw = angles[max_gap_idx];
            let end = if end_raw < start { end_raw + TAU } else { end_raw };
            let s = end - start;
            // If the gap is near zero or full, treat it as a full revolution.
            if s < 1e-6 || s > TAU - 1e-6 {
                (0.0, TAU)
            } else {
                (start, s)
            }
        }
    };
    let n_angle = ((span / (TAU / 36.0)).ceil() as usize).clamp(4, 48);
    let n_v = profile_pts.len();

    // Generate vertices using cylindrical (r, axial) coordinates of each
    // profile point — the profile's own angular position around the axis is
    // irrelevant for the swept surface, only its (radius, axial) matters.
    let mut positions = Vec::with_capacity((n_angle + 1) * n_v * 3);
    for i in 0..=n_angle {
        let theta = a_min + span * (i as f64) / (n_angle as f64);
        let cos_t = theta.cos();
        let sin_t = theta.sin();
        for p in &profile_pts {
            let r = p - axis_origin;
            let rx = r.dot(&axis_x);
            let ry = r.dot(&axis_y);
            let z = r.dot(&axis_dir);
            let radius = (rx * rx + ry * ry).sqrt();
            let world =
                axis_origin + axis_x * (radius * cos_t) + axis_y * (radius * sin_t) + axis_dir * z;
            positions.push(world.x as f32);
            positions.push(world.y as f32);
            positions.push(world.z as f32);
        }
    }

    let mut indices = Vec::with_capacity(n_angle * (n_v - 1) * 6);
    for i in 0..n_angle {
        for j in 0..(n_v - 1) {
            let a = (i * n_v + j) as u32;
            let b = a + n_v as u32;
            let c = b + 1;
            let d = a + 1;
            indices.push(a);
            indices.push(b);
            indices.push(c);
            indices.push(a);
            indices.push(c);
            indices.push(d);
        }
    }

    if positions.is_empty() || indices.is_empty() {
        return process_planar_face(face, decoder);
    }
    Ok((positions, indices))
}

/// Helper that runs `extract_edge_loop_points` over every outer/inner bound of a
/// face and concatenates the results. Used to recover boundary coverage when we
/// need angular extents (e.g. for surfaces of revolution).
fn extract_edge_loop_points_for_bounds(
    face: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Vec<Point3<f64>> {
    let mut all = Vec::new();
    let bounds = match face.get(0).and_then(|a| a.as_list()) {
        Some(b) => b,
        None => return all,
    };
    for bound in bounds {
        if let Some(bound_id) = bound.as_entity_ref() {
            if let Ok(bound_entity) = decoder.decode_by_id(bound_id) {
                if let Some(loop_attr) = bound_entity.get(0) {
                    if let Some(loop_entity) = decoder.resolve_ref(loop_attr).ok().flatten() {
                        if loop_entity
                            .ifc_type
                            .as_str()
                            .eq_ignore_ascii_case("IFCEDGELOOP")
                        {
                            all.extend(extract_edge_loop_points(&loop_entity, decoder));
                        }
                    }
                }
            }
        }
    }
    all
}
