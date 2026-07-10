// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Low-level per-edge curve samplers (vertex coords, axis placement, B-spline
//! and circle edge discretization).

use crate::{scale_segments, Point3, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

use super::bspline::{evaluate_bspline_curve, expand_knots};

/// Extract a CartesianPoint's coordinates from a VertexPoint entity.
pub(super) fn extract_vertex_coords(vertex: &DecodedEntity, decoder: &mut EntityDecoder) -> Option<Point3<f64>> {
    let point_attr = vertex.get(0)?;
    let point = decoder.resolve_ref(point_attr).ok().flatten()?;
    let coords = point.get(0).and_then(|v| v.as_list())?;
    let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
    let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
    let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
    Some(Point3::new(x, y, z))
}

/// Read a B-spline curve's knot multiplicities and knot values.
///
/// Per the IFC schema, `IfcBSplineCurveWithKnots` carries
/// KnotMultiplicities(5), Knots(6), KnotSpec(7) — the previous code read
/// attributes 6/7, which on any real file yields the knot values as "mults"
/// and the KnotSpec enum as "knots", so every B-spline edge silently bailed
/// to a single vertex (issue #1661). The 6/7 pair is kept as a validated
/// fallback in case a producer emits an extra attribute.
pub(super) fn parse_curve_knots(curve: &DecodedEntity) -> Option<(Vec<i64>, Vec<f64>)> {
    for (mi, ki) in [(5usize, 6usize), (6, 7)] {
        let mults: Vec<i64> = match curve.get(mi).and_then(|a| a.as_list()) {
            Some(l) => l.iter().filter_map(|v| v.as_int()).collect(),
            None => continue,
        };
        let knots: Vec<f64> = match curve.get(ki).and_then(|a| a.as_list()) {
            Some(l) => l.iter().filter_map(|v| v.as_float()).collect(),
            None => continue,
        };
        // The schema requires one multiplicity per knot value; use that as the
        // discriminator between the two attribute layouts.
        if !mults.is_empty() && mults.len() == knots.len() {
            return Some((mults, knots));
        }
    }
    None
}

/// Read a parameter trim from an `IfcTrimmedCurve.Trim1/Trim2` SELECT list:
/// `IFCPARAMETERVALUE(x)` (stored as `List(["IFCPARAMETERVALUE", x])`) or a
/// bare numeric. Cartesian trim points are ignored — the edge-loop walk
/// anchors the endpoints geometrically; the parameter is only needed to bound
/// the SAMPLING range on the basis curve.
pub(super) fn read_trim_parameter(attr: &ifc_lite_core::AttributeValue) -> Option<f64> {
    let list = attr.as_list()?;
    let mut param: Option<f64> = None;
    for item in list {
        if let Some(inner) = item.as_list() {
            if let Some(type_name) = inner.first().and_then(|v| v.as_string()) {
                if type_name == "IFCPARAMETERVALUE" {
                    param = inner.get(1).and_then(|v| v.as_float());
                    continue;
                }
            }
        }
        if item.as_entity_ref().is_some() {
            continue;
        }
        if let Some(f) = item.as_float() {
            param = Some(f);
        }
    }
    param
}

/// Sample points along a B-spline curve edge.
/// Returns the start vertex plus intermediate sample points.
/// The end vertex is omitted (provided by the next edge's start in the loop).
pub(super) fn sample_bspline_edge_curve(
    curve: &DecodedEntity,
    start: &Point3<f64>,
    curve_forward: bool,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> Vec<Point3<f64>> {
    sample_bspline_edge_curve_range(curve, start, curve_forward, None, decoder, quality)
}

/// Like [`sample_bspline_edge_curve`], but optionally restricted to a
/// parameter subrange (an `IfcTrimmedCurve` over a B-spline basis whose trims
/// select only part of the curve). Without the restriction, intermediate
/// samples would run over the basis curve's full knot span and jump outside
/// the trimmed edge, corrupting the face loop.
pub(super) fn sample_bspline_edge_curve_range(
    curve: &DecodedEntity,
    start: &Point3<f64>,
    curve_forward: bool,
    trim_range: Option<(f64, f64)>,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
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

    let Some((mults, knot_values)) = parse_curve_knots(curve) else {
        return vec![*start];
    };

    let knots = expand_knots(&knot_values, &mults);
    // A malformed IfcBSplineCurveWithKnots can carry multiplicities summing to
    // fewer than degree+1 knots (or expand_knots may have bailed to empty on an
    // over-large multiplicity). Indexing knots[degree] / knots[len-degree-1]
    // would then panic (OOB, or a usize underflow in len-degree-1). Mirror the
    // sibling polyline.rs guard and treat the curve as unusable.
    if knots.len() <= degree {
        return vec![*start];
    }
    let t_min = knots[degree];
    let t_max = knots[knots.len() - degree - 1];

    // Restrict to the trim subrange when one was authored; degenerate or
    // out-of-span trims fall back to the full valid span.
    let (t_lo, t_hi) = match trim_range {
        Some((a, b)) => {
            let lo = a.min(b).max(t_min);
            let hi = a.max(b).min(t_max);
            if hi - lo > 1e-12 { (lo, hi) } else { (t_min, t_max) }
        }
        None => (t_min, t_max),
    };

    // Adaptive segment count based on control point density; scaled by quality.
    let n_segments = scale_segments(control_points.len() * 2, 4, 16, quality);

    let mut points = Vec::with_capacity(n_segments + 1);
    // Add the start vertex first
    points.push(*start);

    // Sample intermediate points (skip last = next edge's start vertex)
    for i in 1..n_segments {
        let frac = i as f64 / n_segments as f64;
        let t = if curve_forward {
            t_lo + (t_hi - t_lo) * frac
        } else {
            t_hi - (t_hi - t_lo) * frac
        };
        let t_clamped = t.min(t_hi - 1e-6).max(t_lo);
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
pub(super) fn read_axis2_placement_3d(
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
pub(super) fn sample_circle_edge_curve(
    curve: &DecodedEntity,
    start: &Point3<f64>,
    end: &Point3<f64>,
    curve_forward: bool,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
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

    // ~12° per segment at Medium, clamped to keep simple half-turns affordable;
    // scaled by quality.
    let n_base = (delta / (TAU / 30.0)).ceil() as usize;
    let n_segments = scale_segments(n_base, 2, 32, quality);

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

/// Sample an `IfcEllipse` edge from `start` to `end`, walking the arc in the
/// curve's native (CCW around axis_z) direction when `curve_forward` is true,
/// otherwise CW. Mirrors `sample_circle_edge_curve`; the parametric angle is
/// recovered with the semi-axis scaling folded out so trigonometric parameter
/// t (not geometric angle) drives the walk, matching the IFC parameterization
/// P(t) = C + r1·cos(t)·x + r2·sin(t)·y.
pub(super) fn sample_ellipse_edge_curve(
    curve: &DecodedEntity,
    start: &Point3<f64>,
    end: &Point3<f64>,
    curve_forward: bool,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> Vec<Point3<f64>> {
    use std::f64::consts::TAU;

    // IfcEllipse: 0=Position(IfcAxis2Placement3D|2D), 1=SemiAxis1, 2=SemiAxis2
    let r1 = match curve.get(1).and_then(|v| v.as_float()) {
        Some(r) if r > 0.0 => r,
        _ => return vec![*start],
    };
    let r2 = match curve.get(2).and_then(|v| v.as_float()) {
        Some(r) if r > 0.0 => r,
        _ => return vec![*start],
    };

    let placement = match curve.get(0).and_then(|a| decoder.resolve_ref(a).ok().flatten()) {
        Some(p) => p,
        None => return vec![*start],
    };

    let (center, axis_z, axis_x) = read_axis2_placement_3d(&placement, decoder);
    let axis_y = axis_z.cross(&axis_x);

    // Recover the parametric angle of a point: divide the planar components by
    // their semi-axes first, otherwise a stretched ellipse skews the angle.
    let project_angle = |p: &Point3<f64>| -> f64 {
        let v = p - center;
        (v.dot(&axis_y) / r2).atan2(v.dot(&axis_x) / r1)
    };

    let a_start = project_angle(start);
    let a_end = project_angle(end);

    let mut ccw_delta = (a_end - a_start).rem_euclid(TAU);
    let mut cw_delta = (a_start - a_end).rem_euclid(TAU);

    let coincident = (start - end).norm() < 1e-6 * r1.max(r2).max(1.0);
    if coincident || ccw_delta < 1e-9 {
        ccw_delta = TAU;
        cw_delta = TAU;
    }

    let (delta, sign) = if curve_forward {
        (ccw_delta, 1.0_f64)
    } else {
        (cw_delta, -1.0_f64)
    };

    let n_base = (delta / (TAU / 30.0)).ceil() as usize;
    let n_segments = scale_segments(n_base, 2, 32, quality);

    let mut points = Vec::with_capacity(n_segments);
    points.push(*start);
    for i in 1..n_segments {
        let t = delta * (i as f64) / (n_segments as f64);
        let angle = a_start + sign * t;
        let p = center + axis_x * (r1 * angle.cos()) + axis_y * (r2 * angle.sin());
        points.push(p);
    }
    points
}
