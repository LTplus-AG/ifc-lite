// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Canonical face-bound extraction shared by advanced and standalone face surfaces.

use crate::{Error, Point3, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

use super::super::helpers::read_loop_points_by_id;
use super::curves::Refused;
use super::edge_loop::extract_edge_loop_points;
use crate::triangulation::{calculate_polygon_normal, project_to_2d};

pub(super) struct FaceBounds {
    pub(super) outer: Option<Vec<Point3<f64>>>,
    pub(super) holes: Vec<Vec<Point3<f64>>>,
}

// ───────────────────────── face-refusal counter relay ─────────────────────
//
// D3 is "fail closed PLUS a counter". A refused face comes back as an `Err`,
// which the brep and surface-model processors skip per face (#5053) with
// only a debug trace, so without this the refusal was invisible: an element
// could lose faces, or every face, and report nothing. Same shape as
// `bspline_budget::CURVE_CAPPED`: a thread-local flag set where a face is
// refused and drained once per representation item by the router
// (`process_item_in_rtc_frame`), which records the REAL face type: an
// `IfcAdvancedFace` / `IfcFaceSurface` for a surface face, an `IfcFace` for a
// faceted brep or surface-model polyloop face, an
// `IfcIndexedPolygonalFaceWithVoids` for a tessellated face. They were all
// counted as `IfcAdvancedFace` (#7787 audit).
thread_local! {
    static FACE_REFUSED: std::cell::RefCell<Vec<IfcType>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Record that a face of type `face_type` was refused (#7687). Once per type
/// per drain, so the count stays one per item and type.
pub(in crate::processors) fn note_face_refused(face_type: &IfcType) {
    FACE_REFUSED.with(|c| {
        let mut types = c.borrow_mut();
        if !types.contains(face_type) {
            types.push(face_type.clone());
        }
    });
}

/// Drain the refused face types since the last drain on this thread (empty
/// when no face was refused). Drained once per top-level item, so it counts
/// items.
pub(crate) fn take_face_refused() -> Vec<IfcType> {
    FACE_REFUSED.with(|c| std::mem::take(&mut *c.borrow_mut()))
}

/// `result`, noting a refusal of `face` when it is an `Err`.
pub(super) fn noting_refusal<T>(face: &DecodedEntity, result: Result<T>) -> Result<T> {
    if result.is_err() {
        note_face_refused(&face.ifc_type);
    }
    result
}

/// Resolve one `Bounds` entry of `face` to `(bound, loop)` entities. A bound
/// that does not resolve refuses the face (#7687, D14).
pub(super) fn resolve_bound_loop(
    face: &DecodedEntity,
    bound: &ifc_lite_core::AttributeValue,
    decoder: &mut EntityDecoder,
) -> Result<(DecodedEntity, DecodedEntity)> {
    noting_refusal(face, resolve_bound_loop_unnoted(face, bound, decoder))
}

fn resolve_bound_loop_unnoted(
    face: &DecodedEntity,
    bound: &ifc_lite_core::AttributeValue,
    decoder: &mut EntityDecoder,
) -> Result<(DecodedEntity, DecodedEntity)> {
    let bound_id = bound.as_entity_ref().ok_or_else(|| {
        Error::geometry(format!("face #{} has a bound that is not a reference (D14)", face.id))
    })?;
    let bound_entity = decoder.decode_by_id(bound_id)?;
    let loop_attr = bound_entity
        .get(0)
        .ok_or_else(|| Error::geometry("FaceBound missing Bound".to_string()))?;
    let loop_entity = decoder
        .resolve_ref(loop_attr)?
        .ok_or_else(|| Error::geometry("Failed to resolve FaceBound loop".to_string()))?;
    Ok((bound_entity, loop_entity))
}

/// Turn a loop that does not read into the face's refusal (#7687, D14,
/// under D3). Dropping an unreadable HOLE rendered the face filled over its
/// opening, and dropping an unreadable outer loop let a hole become the
/// outer boundary; neither is the authored face.
pub(super) fn refuse_unreadable(
    face: &DecodedEntity,
    loop_entity: &DecodedEntity,
    points: std::result::Result<Vec<Point3<f64>>, Refused>,
) -> Result<Vec<Point3<f64>>> {
    points.map_err(|Refused| {
        note_face_refused(&face.ifc_type);
        Error::geometry(format!(
            "face #{} loop #{} does not resolve; refusing the face rather than drop the loop (D14)",
            face.id, loop_entity.id
        ))
    })
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
        let (bound_entity, loop_entity) = resolve_bound_loop(face, bound, decoder)?;
        let read = match loop_entity.ifc_type {
            IfcType::IfcEdgeLoop => extract_edge_loop_points(&loop_entity, decoder, quality),
            IfcType::IfcPolyLoop => read_loop_points_by_id(loop_entity.id, decoder).ok_or(Refused),
            // Other loop kinds (IfcVertexLoop) carry no area; skipped as before.
            _ => Ok(Vec::new()),
        };
        let mut points = refuse_unreadable(face, &loop_entity, read)?;
        // A readable loop of under three points is degenerate, not unread.
        if points.len() < 3 {
            continue;
        }
        let orientation = bound_entity.get_bool(1).unwrap_or(true);
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
