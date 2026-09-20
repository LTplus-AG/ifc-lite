// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Canonical face-bound extraction shared by advanced and standalone face surfaces.

use crate::{Error, Point3, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

use super::super::helpers::extract_loop_points_by_id;
use super::edge_loop::extract_edge_loop_points;
use crate::triangulation::{calculate_polygon_normal, project_to_2d};

pub(super) struct FaceBounds {
    pub(super) outer: Option<Vec<Point3<f64>>>,
    pub(super) holes: Vec<Vec<Point3<f64>>>,
}

pub(super) fn extract_face_bounds(
    face: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
) -> Result<FaceBounds> {
    let bounds = face
        .get(0)
        .ok_or_else(|| Error::geometry("FaceSurface missing Bounds".to_string()))?
        .as_list()
        .ok_or_else(|| Error::geometry("Expected bounds list".to_string()))?;
    let mut outer = None;
    let mut holes = Vec::new();
    let mut unclassified = Vec::new();

    for bound in bounds {
        let Some(bound_id) = bound.as_entity_ref() else {
            continue;
        };
        let bound_entity = decoder.decode_by_id(bound_id)?;
        let loop_attr = bound_entity
            .get(0)
            .ok_or_else(|| Error::geometry("FaceBound missing Bound".to_string()))?;
        let loop_entity = decoder
            .resolve_ref(loop_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve FaceBound loop".to_string()))?;
        let mut points = match loop_entity.ifc_type {
            IfcType::IfcEdgeLoop => extract_edge_loop_points(&loop_entity, decoder, quality),
            IfcType::IfcPolyLoop => {
                extract_loop_points_by_id(loop_entity.id, decoder).unwrap_or_default()
            }
            _ => Vec::new(),
        };
        if points.len() < 3 {
            continue;
        }
        let orientation = bound_entity
            .get(1)
            .and_then(|attr| attr.as_enum())
            .is_none_or(|value| value == "T" || value == "TRUE");
        if !orientation {
            points.reverse();
        }

        let is_outer = bound_entity.ifc_type == IfcType::IfcFaceOuterBound;
        if is_outer {
            if let Some(previous) = outer.take() {
                holes.push(previous);
            }
            outer = Some(points);
        } else {
            unclassified.push(points);
        }
    }
    if outer.is_some() {
        holes.extend(unclassified);
    } else if let Some((outer_index, _)) = unclassified.iter().enumerate().max_by(|a, b| {
        projected_area(a.1)
            .total_cmp(&projected_area(b.1))
            .then_with(|| compare_ring_key(a.1, b.1))
    }) {
        outer = Some(unclassified.swap_remove(outer_index));
        holes.extend(unclassified);
    }
    Ok(FaceBounds { outer, holes })
}

fn projected_area(points: &[Point3<f64>]) -> f64 {
    let normal = calculate_polygon_normal(points);
    let (ring, _, _, _) = project_to_2d(points, &normal);
    ring.iter()
        .zip(ring.iter().cycle().skip(1))
        .take(ring.len())
        .map(|(a, b)| a.x * b.y - b.x * a.y)
        .sum::<f64>()
        .abs()
        * 0.5
}

fn compare_ring_key(a: &[Point3<f64>], b: &[Point3<f64>]) -> std::cmp::Ordering {
    let point_cmp = |left: &&Point3<f64>, right: &&Point3<f64>| {
        left.x
            .total_cmp(&right.x)
            .then_with(|| left.y.total_cmp(&right.y))
            .then_with(|| left.z.total_cmp(&right.z))
    };
    match (a.iter().min_by(point_cmp), b.iter().min_by(point_cmp)) {
        (Some(left), Some(right)) => point_cmp(&left, &right),
        (Some(_), None) => std::cmp::Ordering::Greater,
        (None, Some(_)) => std::cmp::Ordering::Less,
        (None, None) => std::cmp::Ordering::Equal,
    }
}
