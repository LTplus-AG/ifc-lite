// SPDX-License-Identifier: MPL-2.0
//! Owned polygon construction, before global straight-corner agreement and
//! triangulation. Positions retain the existing f32 file-unit admission; an
//! explicit file-unit RTC is removed in f64 before that narrowing. Product
//! placement and unit scaling remain the router's responsibility.
use super::polygonal::PolygonalFaceSetProcessor;
use super::super::advanced_face::note_face_refused;
use crate::triangulation::straight_corners::StraightCorners;
use crate::{Error, Mesh, Point3, Result};
use ifc_lite_core::{slot, AttributeValue, DecodedEntity, EntityDecoder, IfcType};

type FaceLoops = (IfcType, Vec<u32>, Vec<Vec<u32>>);
#[derive(Debug, Clone)]
pub(crate) enum PolygonalFaceSetPlan {
    Empty,
    Faces {
        positions: Vec<f32>,
        parsed: Vec<FaceLoops>,
        index_capacity: usize,
        orient_outward: bool,
        rtc_applied: bool,
    },
}

/// One face loop as 1-based corners for `triangulate_polygon`, under the
/// shared index rule and `PnIndex` remap; an invalid corner is `0`, which
/// drops the whole face rather than a vertex of it (#7689).
#[inline]
fn parse_index_loop(indices: &[AttributeValue], pn_index: Option<&[u32]>) -> Vec<u32> {
    indices
        .iter()
        .map(|value| super::indices::polygon_corner(value, pn_index))
        .collect()
}

#[inline]
fn parse_face_inner_indices(
    face_entity: &DecodedEntity,
    pn_index: Option<&[u32]>,
) -> Vec<Vec<u32>> {
    if face_entity.ifc_type != IfcType::IfcIndexedPolygonalFaceWithVoids {
        return Vec::new();
    }

    let Some(inner_attr) = face_entity
        .attr(slot::IfcIndexedPolygonalFaceWithVoids::INNER_COORD_INDICES)
        .and_then(|a| a.as_list())
    else {
        return Vec::new();
    };

    let mut result = Vec::with_capacity(inner_attr.len());
    for loop_attr in inner_attr {
        let Some(loop_values) = loop_attr.as_list() else {
            continue;
        };
        let parsed = parse_index_loop(loop_values, pn_index);
        if parsed.len() >= 3 {
            result.push(parsed);
        }
    }

    result
}

/// Retain decoded rings, not their triangulated output. Preserve source
/// admission order, including the empty-coordinate early return.
pub(crate) fn lower(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
    rtc_file_units: Option<(f64, f64, f64)>,
) -> Result<PolygonalFaceSetPlan> {
    let coord_entity_id = entity
        .attr(slot::IfcPolygonalFaceSet::COORDINATES)
        .ok_or_else(|| Error::geometry("PolygonalFaceSet missing Coordinates".to_string()))?
        .as_entity_ref()
        .ok_or_else(|| Error::geometry("Expected entity reference for Coordinates".to_string()))?;
    let positions = super::read_point_list(decoder, coord_entity_id, rtc_file_units)?;

    if positions.is_empty() {
        return Ok(PolygonalFaceSetPlan::Empty);
    }

    // Get faces list (attribute 2)
    let faces_attr = entity
        .attr(slot::IfcPolygonalFaceSet::FACES)
        .ok_or_else(|| Error::geometry("PolygonalFaceSet missing Faces".to_string()))?;

    let face_refs = faces_attr
        .as_list()
        .ok_or_else(|| Error::geometry("Expected faces list".to_string()))?;

    // Optional point remapping list (attribute 3): CoordIndex values
    // index it when present.
    let pn_index =
        super::indices::read_pn_index(entity, slot::IfcPolygonalFaceSet::PN_INDEX.index());

    // Pre-allocate indices - estimate 2 triangles per face average
    let index_capacity = face_refs.len() * 6;

    // Parse every face first: which corners are straight is a property of the
    // whole set (see `StraightCorners`), not of any one face.
    let mut parsed = Vec::with_capacity(face_refs.len());
    for face_ref in face_refs {
        let face_id = face_ref
            .as_entity_ref()
            .ok_or_else(|| Error::geometry("Expected entity reference for face".to_string()))?;

        let face_entity = match decoder.decode_by_id(face_id) {
            Ok(face) => face,
            Err(_) if decoder.get_raw_bytes(face_id).is_none() => {
                // The source record is absent (#7779); its subtype is unknown.
                note_face_refused(&IfcType::IfcIndexedPolygonalFace);
                continue;
            }
            Err(error) => return Err(error.into()),
        };

        // IfcIndexedPolygonalFace has CoordIndex at attribute 0
        // IfcIndexedPolygonalFaceWithVoids has CoordIndex at 0 and InnerCoordIndices at 1
        let coord_index_attr = face_entity
            .attr(slot::IfcIndexedPolygonalFace::COORD_INDEX)
            .ok_or_else(|| {
                Error::geometry("IndexedPolygonalFace missing CoordIndex".to_string())
            })?;

        let coord_indices = coord_index_attr
            .as_list()
            .ok_or_else(|| Error::geometry("Expected coord index list".to_string()))?;

        // Parse face indices (1-based in IFC), with optional PnIndex remapping.
        let face_indices = parse_index_loop(coord_indices, pn_index.as_deref());
        if face_indices.len() < 3 {
            continue;
        }

        // Parse optional inner loops for IfcIndexedPolygonalFaceWithVoids.
        let inner_indices = parse_face_inner_indices(&face_entity, pn_index.as_deref());
        parsed.push((face_entity.ifc_type.clone(), face_indices, inner_indices));
    }

    Ok(PolygonalFaceSetPlan::Faces {
        positions,
        parsed,
        index_capacity,
        orient_outward: super::orients_outward(entity.attr(slot::IfcPolygonalFaceSet::CLOSED)),
        rtc_applied: rtc_file_units.is_some(),
    })
}

impl PolygonalFaceSetPlan {
    /// Replay the same global straight-corner and polygon builders without a decoder.
    pub(crate) fn evaluate(self) -> Mesh {
        let Self::Faces {
            positions,
            parsed,
            index_capacity,
            orient_outward,
            rtc_applied,
        } = self
        else {
            return Mesh::new();
        };
        let mut indices = Vec::with_capacity(index_capacity);
        let ring_points = |loop_indices: &[u32]| -> Option<Vec<Point3<f64>>> {
            loop_indices
                .iter()
                .map(|&idx| {
                    let base = idx.checked_sub(1)?.checked_mul(3)? as usize;
                    let p = positions.get(base..base.checked_add(3)?)?;
                    Some(Point3::new(p[0] as f64, p[1] as f64, p[2] as f64))
                })
                .collect()
        };
        // Positions this close may weld downstream; see `StraightCorners::weld`.
        let extent =
            positions
                .chunks_exact(3)
                .fold([f32::INFINITY, f32::NEG_INFINITY], |[lo, hi], p| {
                    [
                        p.iter().fold(lo, |a, &v| a.min(v)),
                        p.iter().fold(hi, |a, &v| a.max(v)),
                    ]
                });
        let mut corners = StraightCorners::with_weld(1e-5 * f64::from(extent[1] - extent[0]));
        for (_, outer, inner) in &parsed {
            let holed = inner.iter().any(|l| l.len() >= 3);
            for (loop_indices, keep_all) in
                std::iter::once((outer, holed)).chain(inner.iter().map(|l| (l, true)))
            {
                if let Some(ring) = ring_points(loop_indices) {
                    corners.note_ring(&ring, keep_all);
                }
            }
        }

        let hole_free: Vec<Vec<Point3<f64>>> = parsed
            .iter()
            .filter(|(_, _, inner)| inner.iter().all(|l| l.len() < 3))
            .filter_map(|(_, outer, _)| ring_points(outer))
            .collect();
        corners.settle(&hole_free);

        for (face_type, outer, inner) in &parsed {
            // Straight corners every face agrees on leave the face, so no
            // ear-clipper can keep them on one side of an edge and cut them on
            // the other.
            let dissolved: Option<Vec<u32>> = ring_points(outer)
                .filter(|_| inner.iter().all(|l| l.len() < 3))
                .and_then(|ring| corners.kept_corners(&ring))
                .map(|kept| kept.into_iter().map(|i| outer[i]).collect());
            let outer = dissolved.as_ref().unwrap_or(outer);
            PolygonalFaceSetProcessor::triangulate_polygon(
                face_type,
                outer,
                inner,
                &positions,
                &mut indices,
            );
        }

        // Closed shells from some exporters may be consistently inward.
        // Flip globally to outward winding when needed, under the one
        // `Closed` policy shared with the triangulated processor.
        if orient_outward {
            PolygonalFaceSetProcessor::orient_closed_shell_outward(&positions, &mut indices);
        }

        let mut mesh = PolygonalFaceSetProcessor::build_flat_shaded_mesh(&positions, &indices);
        mesh.rtc_applied = rtc_applied;
        mesh
    }
}

#[cfg(test)]
#[path = "polygonal_plan_tests.rs"]
mod tests;
