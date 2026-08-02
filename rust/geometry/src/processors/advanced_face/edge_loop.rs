// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Edge-loop topology walking: extract polygon points from IfcEdgeLoop bounds.

use crate::{Point3, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

use super::conics::{sample_circle_edge_curve, sample_ellipse_edge_curve};
use super::curves::{
    extract_vertex_coords, read_trim_parameter, sample_bspline_edge_curve,
    sample_bspline_edge_curve_range,
};
use super::polyline::sample_curve_polyline;

/// Extract polygon points from an edge loop, sampling B-spline curve edges
/// for intermediate points to preserve curvature.
pub(super) fn extract_edge_loop_points(
    loop_entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
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
            if let Some(sampled) = sample_edge_geometry(
                &geom,
                &walk_start,
                &_walk_end,
                curve_forward,
                decoder,
                quality,
            ) {
                polygon_points.extend(sampled);
                continue;
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

/// Sample intermediate points for one edge's geometry, honouring the loop walk
/// direction. Returns `None` for straight lines and unsupported curve types,
/// in which case the caller falls back to the start vertex (two endpoints are
/// exact for a line). Every curved type MUST be handled here: an unhandled
/// curved edge degrades to a single vertex, which collapses the bounding loop
/// (loops with <3 points are discarded by `process_planar_face`) — walls built
/// from such faces silently lose geometry (issue #1661, CATIA exports).
fn sample_edge_geometry(
    geom: &DecodedEntity,
    walk_start: &Option<Point3<f64>>,
    walk_end: &Option<Point3<f64>>,
    curve_forward: bool,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> Option<Vec<Point3<f64>>> {
    let geom_type = geom.ifc_type.as_str().to_uppercase();
    match geom_type.as_str() {
        // The rational variant shares attributes 0-7; sampling it unweighted is
        // a far better approximation than the single-vertex fallback.
        "IFCBSPLINECURVEWITHKNOTS" | "IFCRATIONALBSPLINECURVEWITHKNOTS" => {
            let s = walk_start.unwrap_or(Point3::new(0.0, 0.0, 0.0));
            Some(sample_bspline_edge_curve(geom, &s, curve_forward, decoder, quality))
        }
        // Sample the arc from walk_start to the other endpoint of THIS edge in
        // the loop's walk direction. Without this, every circular boundary
        // collapses to a single vertex per edge — disc caps and curved fillets
        // become slivers.
        "IFCCIRCLE" => {
            let (s, e) = ((*walk_start)?, (*walk_end)?);
            Some(sample_circle_edge_curve(geom, &s, &e, curve_forward, decoder, quality))
        }
        "IFCELLIPSE" => {
            let (s, e) = ((*walk_start)?, (*walk_end)?);
            Some(sample_ellipse_edge_curve(geom, &s, &e, curve_forward, decoder, quality))
        }
        // IfcTrimmedCurve: 0=BasisCurve, 1=Trim1, 2=Trim2, 3=SenseAgreement.
        // The edge's vertices anchor the endpoints, so the trim parameters are
        // not needed; only the basis curve's shape and the combined walk sense
        // matter. SenseAgreement relates the trim direction to the basis
        // parameterization, so the effective basis direction flips when it is
        // FALSE.
        "IFCTRIMMEDCURVE" => {
            let basis = geom.get(0).and_then(|a| decoder.resolve_ref(a).ok().flatten())?;
            let sense = geom
                .get(3)
                .and_then(|a| a.as_enum())
                .map(|e| e == "T" || e == "TRUE")
                .unwrap_or(true);
            let basis_forward = curve_forward == sense;
            let basis_type = basis.ifc_type.as_str().to_uppercase();
            match basis_type.as_str() {
                "IFCCIRCLE" => {
                    let (s, e) = ((*walk_start)?, (*walk_end)?);
                    Some(sample_circle_edge_curve(&basis, &s, &e, basis_forward, decoder, quality))
                }
                "IFCELLIPSE" => {
                    let (s, e) = ((*walk_start)?, (*walk_end)?);
                    Some(sample_ellipse_edge_curve(&basis, &s, &e, basis_forward, decoder, quality))
                }
                "IFCBSPLINECURVEWITHKNOTS" | "IFCRATIONALBSPLINECURVEWITHKNOTS" => {
                    let s = (*walk_start)?;
                    // Honour parameter trims so sampling stays on the trimmed
                    // subspan instead of running the basis curve's full knot
                    // range (both trims must be present to bound a range).
                    let trim_range = match (
                        geom.get(1).and_then(read_trim_parameter),
                        geom.get(2).and_then(read_trim_parameter),
                    ) {
                        (Some(a), Some(b)) => Some((a, b)),
                        _ => None,
                    };
                    Some(sample_bspline_edge_curve_range(
                        &basis,
                        &s,
                        basis_forward,
                        trim_range,
                        decoder,
                        quality,
                    ))
                }
                // Trimmed line: two endpoints are exact; fall back to the
                // start-vertex default.
                _ => None,
            }
        }
        "IFCCOMPOSITECURVE" => {
            sample_composite_curve_edge(geom, walk_start, curve_forward, decoder, quality)
        }
        "IFCPOLYLINE" => sample_polyline_edge(geom, walk_start, curve_forward, decoder),
        _ => None,
    }
}

/// Sample an `IfcCompositeCurve` edge by concatenating its segments' polylines
/// in walk order. Returns start + intermediate points; the terminal point is
/// dropped (the next edge in the loop contributes it).
fn sample_composite_curve_edge(
    geom: &DecodedEntity,
    walk_start: &Option<Point3<f64>>,
    curve_forward: bool,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> Option<Vec<Point3<f64>>> {
    // IfcCompositeCurve: 0=Segments (list of IfcCompositeCurveSegment)
    let segments = geom.get(0).and_then(|a| a.as_list())?;

    let mut pts: Vec<Point3<f64>> = Vec::new();
    for seg_ref in segments {
        let Some(seg_id) = seg_ref.as_entity_ref() else { continue };
        let Ok(segment) = decoder.decode_by_id(seg_id) else { continue };
        // IfcCompositeCurveSegment: 0=Transition, 1=SameSense, 2=ParentCurve
        let same_sense = segment
            .get(1)
            .and_then(|a| a.as_enum())
            .map(|e| e == "T" || e == "TRUE")
            .unwrap_or(true);
        let Some(parent) = segment.get(2).and_then(|a| decoder.resolve_ref(a).ok().flatten())
        else {
            continue;
        };
        let mut seg_pts = sample_curve_polyline(&parent, decoder, quality);
        if seg_pts.is_empty() {
            continue;
        }
        if !same_sense {
            seg_pts.reverse();
        }
        // Drop the duplicate joint point between consecutive segments.
        if let (Some(last), Some(first)) = (pts.last(), seg_pts.first()) {
            if (last - first).norm_squared() < 1e-12 {
                seg_pts.remove(0);
            }
        }
        pts.extend(seg_pts);
    }

    orient_and_trim_edge_polyline(pts, walk_start, curve_forward)
}

/// Sample an `IfcPolyline` edge: emit its points in walk order, dropping the
/// terminal point (the next edge in the loop contributes it).
fn sample_polyline_edge(
    geom: &DecodedEntity,
    walk_start: &Option<Point3<f64>>,
    curve_forward: bool,
    decoder: &mut EntityDecoder,
) -> Option<Vec<Point3<f64>>> {
    // IfcPolyline: 0=Points (list of IfcCartesianPoint)
    let refs = geom.get(0).and_then(|a| a.as_list())?;
    let mut pts: Vec<Point3<f64>> = Vec::new();
    for r in refs {
        let Some(id) = r.as_entity_ref() else { continue };
        let Ok(p) = decoder.decode_by_id(id) else { continue };
        let Some(coords) = p.get(0).and_then(|v| v.as_list()) else { continue };
        let x = coords.first().and_then(|v| v.as_float()).unwrap_or(0.0);
        let y = coords.get(1).and_then(|v| v.as_float()).unwrap_or(0.0);
        let z = coords.get(2).and_then(|v| v.as_float()).unwrap_or(0.0);
        pts.push(Point3::new(x, y, z));
    }
    orient_and_trim_edge_polyline(pts, walk_start, curve_forward)
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
            if d_last < d_first {
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
/// need angular extents (e.g. for surfaces of revolution).
pub(super) fn extract_edge_loop_points_for_bounds(
    face: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
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
                            all.extend(extract_edge_loop_points(&loop_entity, decoder, quality));
                        }
                    }
                }
            }
        }
    }
    all
}
