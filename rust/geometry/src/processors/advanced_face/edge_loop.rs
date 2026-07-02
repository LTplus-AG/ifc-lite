// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Edge-loop topology walking: extract polygon points from IfcEdgeLoop bounds.

use crate::{Point3, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

use super::curves::{extract_vertex_coords, sample_bspline_edge_curve, sample_circle_edge_curve};

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
            let geom_type = geom.ifc_type.as_str().to_uppercase();
            if geom_type == "IFCBSPLINECURVEWITHKNOTS" {
                // Sample B-spline curve for intermediate points
                let s = walk_start.unwrap_or(Point3::new(0.0, 0.0, 0.0));
                let sampled =
                    sample_bspline_edge_curve(&geom, &s, curve_forward, decoder, quality);
                polygon_points.extend(sampled);
                continue;
            }
            if geom_type == "IFCCIRCLE" {
                // Sample arc from walk_start to the next edge's start (i.e. the
                // other endpoint of THIS edge in the loop's walk direction).
                // Without this, every circular boundary collapses to a single
                // vertex per edge — disc caps and curved fillets become slivers.
                if let (Some(s), Some(e)) = (walk_start, _walk_end) {
                    let sampled =
                        sample_circle_edge_curve(&geom, &s, &e, curve_forward, decoder, quality);
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
