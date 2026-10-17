// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Low-level per-edge curve samplers (vertex coords, axis placement, B-spline
//! and circle edge discretization).

use crate::math::tol;
use crate::{scale_segments, Point3, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

use super::bspline::evaluate_bspline_curve;
use super::bspline_budget::{MAX_BSPLINE_CURVE_CONTROL_POINTS, MAX_BSPLINE_DEGREE};
use super::bspline_parse::expand_knots;

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
///
/// A layout is matched on its RAW list lengths (one multiplicity per knot).
/// An entry of the matched layout that is not a number refuses the curve
/// (#7687): it used to be dropped, shifting every later knot.
pub(super) fn parse_curve_knots(curve: &DecodedEntity) -> Result<Option<(Vec<i64>, Vec<f64>)>, Refused> {
    for (mi, ki) in [(5usize, 6usize), (6, 7)] {
        let (Some(mults), Some(knots)) = (
            curve.get(mi).and_then(|a| a.as_list()),
            curve.get(ki).and_then(|a| a.as_list()),
        ) else {
            continue;
        };
        if mults.is_empty() || mults.len() != knots.len() {
            continue;
        }
        let mults = mults.iter().map(|v| v.as_int()).collect::<Option<Vec<_>>>().ok_or(Refused)?;
        let knots = knots.iter().map(|v| v.as_float()).collect::<Option<Vec<_>>>().ok_or(Refused)?;
        return Ok(Some((mults, knots)));
    }
    Ok(None)
}

/// `IfcRationalBSplineCurveWithKnots.WeightsData` (attribute 8): mandatory,
/// one finite weight > 0 per control point, the rule the rational surface
/// path applies (#7687). A missing, short, non-numeric or non-positive entry
/// refuses the curve (#7750): sampling it unweighted drew a different curve.
fn parse_curve_weights(curve: &DecodedEntity, control_points: usize) -> Result<Vec<f64>, Refused> {
    let weights = curve
        .get(8)
        .and_then(|a| a.as_list())
        .ok_or(Refused)?
        .iter()
        .map(|v| v.as_float().filter(|w| w.is_finite() && *w > 0.0))
        .collect::<Option<Vec<_>>>()
        .ok_or(Refused)?;
    if weights.len() == control_points {
        Ok(weights)
    } else {
        Err(Refused)
    }
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

/// The `(Trim1, Trim2)` parameter pair of an `IfcTrimmedCurve`, when both
/// trims carry a parameter: the subspan a B-spline basis is sampled over.
pub(super) fn trim_parameter_range(trimmed: &DecodedEntity) -> Option<(f64, f64)> {
    trimmed
        .get(1)
        .and_then(read_trim_parameter)
        .zip(trimmed.get(2).and_then(read_trim_parameter))
}

/// A curve whose authored data does not resolve (#7687, PROC-S21): a
/// control point, polyline point or composite segment that names no usable
/// entity. Sampling what remains would draw a different curve, so callers
/// refuse the curve and the loop holding it, matching the core decoder's
/// rule for poly-loops (`get_polyloop_point_ids_fast`, #3421).
#[derive(Debug)]
pub(super) struct Refused;

/// Resolve an entity-valued attribute that may be absent. Absent, `$` or `*`
/// is `Ok(None)`, leaving the caller's old fallback (a chord, a default
/// frame). A reference that is PRESENT but does not decode is
/// `Err(Refused)` (#7687): the file names a curve or placement that is not
/// there, and the fallback would draw something the file never described.
pub(super) fn resolve_present(
    attr: Option<&ifc_lite_core::AttributeValue>,
    decoder: &mut EntityDecoder,
) -> Result<Option<DecodedEntity>, Refused> {
    match attr.and_then(|a| a.as_entity_ref()) {
        None => Ok(None),
        Some(id) => decoder.decode_by_id(id).map(Some).map_err(|_| Refused),
    }
}

/// A decoded `IfcBSplineCurveWithKnots`: degree, control points and the
/// expanded knot vector, with `knots.len() > degree` guaranteed. `weights`
/// is `Some` (one per control point, finite and > 0) for an
/// `IfcRationalBSplineCurveWithKnots` (#7750).
struct BSplineCurve {
    degree: usize,
    control_points: Vec<Point3<f64>>,
    weights: Option<Vec<f64>>,
    knots: Vec<f64>,
}

impl BSplineCurve {
    /// The valid parameter domain `[knots[degree], knots[len - degree - 1]]`.
    fn domain(&self) -> (f64, f64) {
        (self.knots[self.degree], self.knots[self.knots.len() - self.degree - 1])
    }

    fn at(&self, t: f64) -> Point3<f64> {
        evaluate_bspline_curve(t, self.degree, &self.control_points, self.weights.as_deref(), &self.knots)
    }
}

/// Decode a B-spline curve once for every sampler. `Ok(None)` is a curve the
/// samplers have always degraded rather than refused: a degree or point count
/// past its bound (#4901, reported through `note_curve_capped`), too few
/// control points, or an unusable knot vector. `Err(Refused)` is a control
/// point that does not resolve; it was skipped, shifting every later point
/// against the knots.
fn parse_bspline_curve(
    curve: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<Option<BSplineCurve>, Refused> {
    // Parse B-spline curve: degree(0), control_points(1), ..., knot_mults(5), knots(6)
    let degree = curve.get_float(0).unwrap_or(3.0) as usize;
    // Same bound as the surface path (#4901): `evaluate_bspline_curve`'s table
    // build is safe at any degree (internally clamped too), but a huge
    // file-supplied degree is never legitimate, so reject it the same way
    // every other malformed-curve guard here does, rather than spend the
    // (still-bounded, but pointless) table-build cost.
    if degree > MAX_BSPLINE_DEGREE {
        super::bspline_budget::note_curve_capped();
        return Ok(None);
    }

    // Parse control points (attribute 1: LIST of IfcCartesianPoint)
    let Some(cp_list) = curve.get(1).and_then(|a| a.as_list()) else {
        return Ok(None);
    };
    // Bound the point count too (#4901): the table build is `O(degree * (n +
    // degree))`, so an attacker-sized `n` scales it even at a capped degree.
    if cp_list.len() > MAX_BSPLINE_CURVE_CONTROL_POINTS {
        super::bspline_budget::note_curve_capped();
        return Ok(None);
    }
    let control_points = cp_list
        .iter()
        .map(|ref_val| {
            let id = ref_val.as_entity_ref()?;
            let pt = decoder.decode_by_id(id).ok()?;
            let coords = pt.get(0)?.as_list()?;
            let x = coords.first()?.as_float().unwrap_or(0.0);
            let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
            let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
            Some(Point3::new(x, y, z))
        })
        .collect::<Option<Vec<_>>>()
        .ok_or(Refused)?;
    let weights = if curve.ifc_type == IfcType::IfcRationalBSplineCurveWithKnots {
        Some(parse_curve_weights(curve, control_points.len())?)
    } else {
        None
    };

    if control_points.len() <= degree {
        return Ok(None);
    }
    let Some((mults, knot_values)) = parse_curve_knots(curve)? else {
        return Ok(None);
    };
    let knots = expand_knots(&knot_values, &mults);
    // A malformed IfcBSplineCurveWithKnots can carry multiplicities summing to
    // fewer than degree+1 knots (or expand_knots may have bailed to empty on an
    // over-large multiplicity). Indexing knots[degree] / knots[len-degree-1]
    // would then panic (OOB, or a usize underflow in len-degree-1), so the
    // curve is unusable.
    if knots.len() <= degree {
        return Ok(None);
    }
    Ok(Some(BSplineCurve { degree, control_points, weights, knots }))
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
) -> Result<Vec<Point3<f64>>, Refused> {
    sample_bspline_edge_curve_range(curve, start, curve_forward, None, decoder, quality)
}

/// Like [`sample_bspline_edge_curve`], but optionally restricted to a
/// parameter subrange (an `IfcTrimmedCurve` over a B-spline basis whose trims
/// select only part of the curve). Without the restriction, intermediate
/// samples would run over the basis curve's full knot span and jump outside
/// the trimmed edge, corrupting the face loop. An unusable curve degrades to
/// the single start vertex (the edge becomes a chord).
pub(super) fn sample_bspline_edge_curve_range(
    curve: &DecodedEntity,
    start: &Point3<f64>,
    curve_forward: bool,
    trim_range: Option<(f64, f64)>,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> Result<Vec<Point3<f64>>, Refused> {
    Ok(match parse_bspline_curve(curve, decoder)? {
        Some(parsed) => sample_between(&parsed, start, curve_forward, trim_range, quality),
        None => vec![*start],
    })
}

/// Sample a whole B-spline curve from its start parameter to its end
/// parameter, both endpoints included, for callers that use the curve on its
/// own (a surface-of-revolution profile, a composite-curve segment) rather
/// than as one edge of a loop. An unusable curve yields no points.
pub(super) fn sample_bspline_curve_polyline(
    curve: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> Result<Vec<Point3<f64>>, Refused> {
    let Some(parsed) = parse_bspline_curve(curve, decoder)? else {
        return Ok(Vec::new());
    };
    let (t_min, t_max) = parsed.domain();
    let mut points = sample_between(&parsed, &parsed.at(t_min), true, None, quality);
    let end = parsed.at(t_max);
    if points.last().is_none_or(|last| (last - end).norm_squared() >= tol::SAMPLE_END_COINCIDENT_SQ) {
        points.push(end);
    }
    Ok(points)
}

/// `start` plus the interior samples of `parsed` over its domain, or over
/// `trim_range` clamped to it; the end point is left to the caller.
fn sample_between(
    parsed: &BSplineCurve,
    start: &Point3<f64>,
    curve_forward: bool,
    trim_range: Option<(f64, f64)>,
    quality: TessellationQuality,
) -> Vec<Point3<f64>> {
    let (t_min, t_max) = parsed.domain();

    // Restrict to the trim subrange when one was authored; degenerate or
    // out-of-span trims fall back to the full valid span.
    let (t_lo, t_hi) = match trim_range {
        Some((a, b)) => {
            let lo = a.min(b).max(t_min);
            let hi = a.max(b).min(t_max);
            if hi - lo > tol::TRIM_SPAN_MIN { (lo, hi) } else { (t_min, t_max) }
        }
        None => (t_min, t_max),
    };

    // Adaptive segment count based on control point density; scaled by quality.
    let n_segments = scale_segments(parsed.control_points.len() * 2, 4, 16, quality);

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
        let t_clamped = t.min(t_hi - tol::PARAM_END_MARGIN).max(t_lo);
        let pt = parsed.at(t_clamped);
        // Skip degenerate points (too close to previous)
        if let Some(prev) = points.last() {
            let dist_sq = (pt.x - prev.x).powi(2) + (pt.y - prev.y).powi(2) + (pt.z - prev.z).powi(2);
            if dist_sq < tol::SAMPLE_COINCIDENT_SQ {
                continue;
            }
        }
        points.push(pt);
    }

    points
}

#[cfg(test)]
#[path = "curves_tests.rs"]
mod tests;
