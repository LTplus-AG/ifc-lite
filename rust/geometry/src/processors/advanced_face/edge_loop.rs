// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Edge-loop topology walking: extract polygon points from IfcEdgeLoop bounds.

use crate::math::tol;
use crate::{Point3, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

use super::conics::{sample_circle_edge_curve, sample_ellipse_edge_curve};
use super::curves::{
    extract_vertex_coords, sample_bspline_edge_curve, trim_parameter_range,
    resolve_present, sample_bspline_edge_curve_range, Refused,
};
use super::polyline::{polyline_points, try_sample_curve_polyline};

/// Sample one `IfcEdgeCurve` in edge traversal order, including both authored
/// vertices. `orientation=true` walks EdgeStart to EdgeEnd; false walks the
/// opposite direction. Kept here so face loops and standalone structural edge
/// rendering share the same curve/sense implementation.
///
/// `None` is an edge without both vertices. An edge whose curve does not
/// resolve (#7687, PROC-S21) is an error: the chord drawn in its place would
/// be a different edge.
pub(in crate::processors) fn sample_edge_curve_points(
    edge_curve: &DecodedEntity,
    orientation: bool,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> crate::Result<Option<Vec<Point3<f64>>>> {
    sample_edge_curve_points_or_refuse(edge_curve, orientation, decoder, quality).map_err(|Refused| {
        crate::Error::geometry(format!(
            "IfcEdgeCurve #{} has a curve whose points do not resolve",
            edge_curve.id
        ))
    })
}

fn sample_edge_curve_points_or_refuse(
    edge_curve: &DecodedEntity,
    orientation: bool,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> Result<Option<Vec<Point3<f64>>>, Refused> {
    let start_vertex = edge_curve
        .get(0)
        .and_then(|attr| decoder.resolve_ref(attr).ok().flatten());
    let end_vertex = edge_curve
        .get(1)
        .and_then(|attr| decoder.resolve_ref(attr).ok().flatten());
    let edge_start = start_vertex
        .as_ref()
        .and_then(|vertex| extract_vertex_coords(vertex, decoder));
    let edge_end = end_vertex
        .as_ref()
        .and_then(|vertex| extract_vertex_coords(vertex, decoder));
    let (walk_start, walk_end) = if orientation {
        (edge_start, edge_end)
    } else {
        (edge_end, edge_start)
    };
    let (Some(start), Some(end)) = (walk_start, walk_end) else {
        return Ok(None);
    };
    let same_sense = edge_curve.get_bool(3).unwrap_or(true);
    let curve_forward = orientation == same_sense;
    // An absent EdgeGeometry is a straight edge (the chord); a dangling one
    // is refused (#7687).
    let geometry = resolve_present(edge_curve.get(2), decoder)?;
    let sampled = match geometry.as_ref() {
        Some(geometry) => sample_edge_geometry(
            geometry,
            &Some(start),
            &Some(end),
            curve_forward,
            decoder,
            quality,
        )?,
        None => None,
    };
    let mut points = sampled.unwrap_or_else(|| vec![start]);
    if points.last().is_none_or(|point| point != &end) {
        points.push(end);
    }
    Ok(Some(points))
}

/// Extract polygon points from an edge loop, sampling B-spline curve edges
/// for intermediate points to preserve curvature.
///
/// A loop entry, edge curve or vertex that does not resolve refuses the
/// whole loop (#7687, PROC-S21), and the face reading the loop refuses the
/// face (D14): skipping the entry meshed a polygon one edge short, and
/// dropping the loop rendered a hole filled.
pub(super) fn extract_edge_loop_points(
    loop_entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> Result<Vec<Point3<f64>>, Refused> {
    let edges = loop_entity.get(0).and_then(|a| a.as_list()).ok_or(Refused)?;
    edge_loop_points(edges, decoder, quality)
}

fn edge_loop_points(
    edges: &[ifc_lite_core::AttributeValue],
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> Result<Vec<Point3<f64>>, Refused> {
    let mut polygon_points = Vec::new();

    for edge_ref in edges {
        let edge_id = edge_ref.as_entity_ref().ok_or(Refused)?;
        let oriented_edge = decoder.decode_by_id(edge_id).map_err(|_| Refused)?;

        // IfcOrientedEdge: EdgeStart(0), EdgeEnd(1), EdgeElement(2), Orientation(3)
        let orientation = oriented_edge.get_bool(3).unwrap_or(true);

        // Get the EdgeElement (IfcEdgeCurve)
        let edge_curve = oriented_edge
            .get(2)
            .and_then(|attr| decoder.resolve_ref(attr).ok().flatten())
            .ok_or(Refused)?;

        // An edge without both vertices has no known extent in this loop.
        let mut sampled =
            sample_edge_curve_points_or_refuse(&edge_curve, orientation, decoder, quality)?
                .ok_or(Refused)?;
        // The next loop edge contributes this edge's terminal vertex.
        // Keeping it out here avoids duplicating every shared corner.
        sampled.pop();
        polygon_points.extend(sampled);
    }

    Ok(polygon_points)
}

/// Sample intermediate points for one edge's geometry, honouring the loop walk
/// direction. Returns `None` for straight lines and unsupported curve types,
/// in which case the caller falls back to the start vertex (two endpoints are
/// exact for a line). Every curved type MUST be handled here: an unhandled
/// curved edge degrades to a single vertex, which collapses the bounding loop
/// (loops with <3 points are discarded by `process_planar_face`) — walls built
/// from such faces silently lose geometry (issue #1661, CATIA exports).
/// `Err(Refused)` is a curve whose authored points do not resolve.
fn sample_edge_geometry(
    geom: &DecodedEntity,
    walk_start: &Option<Point3<f64>>,
    walk_end: &Option<Point3<f64>>,
    curve_forward: bool,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> Result<Option<Vec<Point3<f64>>>, Refused> {
    let geom_type = geom.ifc_type.as_str().to_uppercase();
    Ok(match geom_type.as_str() {
        // The rational variant shares attributes 0-7 and adds WeightsData,
        // which `parse_bspline_curve` reads (#7750).
        "IFCBSPLINECURVEWITHKNOTS" | "IFCRATIONALBSPLINECURVEWITHKNOTS" => {
            let s = walk_start.unwrap_or(Point3::new(0.0, 0.0, 0.0));
            Some(sample_bspline_edge_curve(geom, &s, curve_forward, decoder, quality)?)
        }
        // Sample the arc from walk_start to the other endpoint of THIS edge in
        // the loop's walk direction. Without this, every circular boundary
        // collapses to a single vertex per edge — disc caps and curved fillets
        // become slivers.
        "IFCCIRCLE" => walk_start
            .zip(*walk_end)
            .map(|(s, e)| sample_circle_edge_curve(geom, &s, &e, curve_forward, decoder, quality))
            .transpose()?,
        "IFCELLIPSE" => walk_start
            .zip(*walk_end)
            .map(|(s, e)| sample_ellipse_edge_curve(geom, &s, &e, curve_forward, decoder, quality))
            .transpose()?,
        // IfcTrimmedCurve: 0=BasisCurve, 1=Trim1, 2=Trim2, 3=SenseAgreement.
        // The edge's vertices anchor the endpoints, so the trim parameters are
        // not needed; only the basis curve's shape and the combined walk sense
        // matter. SenseAgreement relates the trim direction to the basis
        // parameterization, so the effective basis direction flips when it is
        // FALSE.
        "IFCTRIMMEDCURVE" => {
            let Some(basis) = resolve_present(geom.get(0), decoder)? else {
                return Ok(None);
            };
            let sense = geom.get_bool(3).unwrap_or(true);
            let basis_forward = curve_forward == sense;
            let basis_type = basis.ifc_type.as_str().to_uppercase();
            match basis_type.as_str() {
                "IFCCIRCLE" => walk_start
                    .zip(*walk_end)
                    .map(|(s, e)| sample_circle_edge_curve(&basis, &s, &e, basis_forward, decoder, quality))
                    .transpose()?,
                "IFCELLIPSE" => walk_start
                    .zip(*walk_end)
                    .map(|(s, e)| sample_ellipse_edge_curve(&basis, &s, &e, basis_forward, decoder, quality))
                    .transpose()?,
                "IFCBSPLINECURVEWITHKNOTS" | "IFCRATIONALBSPLINECURVEWITHKNOTS" => {
                    let Some(s) = *walk_start else { return Ok(None) };
                    // Honour parameter trims so sampling stays on the trimmed
                    // subspan instead of running the basis curve's full knot
                    // range (both trims must be present to bound a range).
                    let trim_range = trim_parameter_range(geom);
                    Some(sample_bspline_edge_curve_range(
                        &basis,
                        &s,
                        basis_forward,
                        trim_range,
                        decoder,
                        quality,
                    )?)
                }
                // Trimmed line: two endpoints are exact; fall back to the
                // start-vertex default.
                _ => None,
            }
        }
        "IFCCOMPOSITECURVE" => {
            sample_composite_curve_edge(geom, walk_start, curve_forward, decoder, quality)?
        }
        "IFCPOLYLINE" => sample_polyline_edge(geom, walk_start, curve_forward, decoder)?,
        _ => None,
    })
}

/// Sample an `IfcCompositeCurve` edge by concatenating its segments' polylines
/// in walk order. Returns start + intermediate points; the terminal point is
/// dropped (the next edge in the loop contributes it). A segment that does
/// not resolve refuses the edge; a segment of an unsupported curve type
/// samples empty and is bridged, as before.
fn sample_composite_curve_edge(
    geom: &DecodedEntity,
    walk_start: &Option<Point3<f64>>,
    curve_forward: bool,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> Result<Option<Vec<Point3<f64>>>, Refused> {
    // IfcCompositeCurve: 0=Segments (list of IfcCompositeCurveSegment)
    let Some(segments) = geom.get(0).and_then(|a| a.as_list()) else {
        return Ok(None);
    };

    let mut pts: Vec<Point3<f64>> = Vec::new();
    for seg_ref in segments {
        let seg_id = seg_ref.as_entity_ref().ok_or(Refused)?;
        let segment = decoder.decode_by_id(seg_id).map_err(|_| Refused)?;
        // IfcCompositeCurveSegment: 0=Transition, 1=SameSense, 2=ParentCurve
        let same_sense = segment.get_bool(1).unwrap_or(true);
        let parent = segment
            .get(2)
            .and_then(|a| decoder.resolve_ref(a).ok().flatten())
            .ok_or(Refused)?;
        let mut seg_pts = try_sample_curve_polyline(&parent, decoder, quality)?;
        if seg_pts.is_empty() {
            continue;
        }
        if !same_sense {
            seg_pts.reverse();
        }
        // Drop the duplicate joint point between consecutive segments.
        if let (Some(last), Some(first)) = (pts.last(), seg_pts.first()) {
            if (last - first).norm_squared() < tol::SAMPLE_COINCIDENT_SQ {
                seg_pts.remove(0);
            }
        }
        pts.extend(seg_pts);
    }

    Ok(orient_and_trim_edge_polyline(pts, walk_start, curve_forward))
}

/// Sample an `IfcPolyline` edge: emit its points in walk order, dropping the
/// terminal point (the next edge in the loop contributes it).
fn sample_polyline_edge(
    geom: &DecodedEntity,
    walk_start: &Option<Point3<f64>>,
    curve_forward: bool,
    decoder: &mut EntityDecoder,
) -> Result<Option<Vec<Point3<f64>>>, Refused> {
    // IfcPolyline: 0=Points (list of IfcCartesianPoint)
    let Some(refs) = geom.get(0).and_then(|a| a.as_list()) else {
        return Ok(None);
    };
    let pts = polyline_points(refs, decoder)?;
    Ok(orient_and_trim_edge_polyline(pts, walk_start, curve_forward))
}

/// Orient a sampled edge polyline so it starts at the loop-walk start, then
/// drop its terminal point (edge-loop contract: each edge contributes start +
/// intermediates; the next edge supplies the shared endpoint). Anchoring on
/// the walk-start vertex is more robust than trusting sense flags alone.
fn orient_and_trim_edge_polyline(
    mut pts: Vec<Point3<f64>>,
    walk_start: &Option<Point3<f64>>,
    curve_forward: bool,
) -> Option<Vec<Point3<f64>>> {
    if pts.len() < 2 {
        return None;
    }
    match walk_start {
        Some(ws) => {
            let d_first = (pts.first().unwrap() - ws).norm_squared();
            let d_last = (pts.last().unwrap() - ws).norm_squared();
            if d_last < d_first || (d_last == d_first && !curve_forward) {
                pts.reverse();
            }
        }
        None => {
            if !curve_forward {
                pts.reverse();
            }
        }
    }
    pts.pop();
    Some(pts)
}

/// Helper that runs `extract_edge_loop_points` over every outer/inner bound of a
/// face and concatenates the results. Used to recover boundary coverage when we
/// need angular extents (e.g. for surfaces of revolution). A bound that does
/// not resolve, or an edge loop refused by [`extract_edge_loop_points`],
/// refuses the face (D14), the rule [`super::bounds::extract_face_bounds`]
/// applies; non-edge loops add no points, as before.
pub(super) fn extract_edge_loop_points_for_bounds(
    face: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> crate::Result<Vec<Point3<f64>>> {
    let mut all = Vec::new();
    let Some(bounds) = face.get(0).and_then(|a| a.as_list()) else {
        return Ok(all);
    };
    for bound in bounds {
        let (_, loop_entity) = super::bounds::resolve_bound_loop(face, bound, decoder)?;
        if loop_entity.ifc_type == ifc_lite_core::IfcType::IfcEdgeLoop {
            all.extend(super::bounds::refuse_unreadable(
                face,
                &loop_entity,
                extract_edge_loop_points(&loop_entity, decoder, quality),
            )?);
        }
    }
    Ok(all)
}
