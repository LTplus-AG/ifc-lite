// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{Error, Mesh, Result, TessellationQuality};
use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, IfcSchema, IfcType};

use crate::router::GeometryProcessor;

/// Handles IfcPolygonalFaceSet - explicit polygon meshes that need triangulation
/// Unlike IfcTriangulatedFaceSet, faces can be arbitrary polygons (not just triangles)
pub struct PolygonalFaceSetProcessor;

impl PolygonalFaceSetProcessor {
    pub fn new() -> Self {
        Self
    }

    #[inline]
    fn parse_index_loop(indices: &[AttributeValue], pn_index: Option<&[u32]>) -> Vec<u32> {
        indices
            .iter()
            .filter_map(|value| {
                let idx = value.as_int()?;
                if idx <= 0 {
                    return None;
                }
                let idx = idx as usize;

                if let Some(remap) = pn_index {
                    remap.get(idx - 1).copied().filter(|mapped| *mapped > 0)
                } else {
                    Some(idx as u32)
                }
            })
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

        let Some(inner_attr) = face_entity.get(1).and_then(|a| a.as_list()) else {
            return Vec::new();
        };

        let mut result = Vec::with_capacity(inner_attr.len());
        for loop_attr in inner_attr {
            let Some(loop_values) = loop_attr.as_list() else {
                continue;
            };
            let parsed = Self::parse_index_loop(loop_values, pn_index);
            if parsed.len() >= 3 {
                result.push(parsed);
            }
        }

        result
    }
}

impl GeometryProcessor for PolygonalFaceSetProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        _quality: TessellationQuality,
    ) -> Result<Mesh> {
        // IfcPolygonalFaceSet attributes:
        // 0: Coordinates (IfcCartesianPointList3D)
        // 1: Closed (optional BOOLEAN)
        // 2: Faces (LIST of IfcIndexedPolygonalFace)
        // 3: PnIndex (optional - point index remapping)

        // Get coordinate entity reference
        let coords_attr = entity
            .get(0)
            .ok_or_else(|| Error::geometry("PolygonalFaceSet missing Coordinates".to_string()))?;

        let coord_entity_id = coords_attr.as_entity_ref().ok_or_else(|| {
            Error::geometry("Expected entity reference for Coordinates".to_string())
        })?;

        // Parse coordinates - try fast path first
        use ifc_lite_core::extract_coordinate_list_from_entity;

        let positions = if let Some(raw_bytes) = decoder.get_raw_bytes(coord_entity_id) {
            extract_coordinate_list_from_entity(raw_bytes).unwrap_or_default()
        } else {
            // Fallback path
            let coords_entity = decoder.decode_by_id(coord_entity_id)?;
            let coord_list_attr = coords_entity.get(0).ok_or_else(|| {
                Error::geometry("CartesianPointList3D missing CoordList".to_string())
            })?;
            let coord_list = coord_list_attr
                .as_list()
                .ok_or_else(|| Error::geometry("Expected coordinate list".to_string()))?;
            AttributeValue::parse_coordinate_list_3d(coord_list)
        };

        if positions.is_empty() {
            return Ok(Mesh::new());
        }

        // Get faces list (attribute 2)
        let faces_attr = entity
            .get(2)
            .ok_or_else(|| Error::geometry("PolygonalFaceSet missing Faces".to_string()))?;

        let face_refs = faces_attr
            .as_list()
            .ok_or_else(|| Error::geometry("Expected faces list".to_string()))?;

        // Optional point remapping list for IfcPolygonalFaceSet.
        // CoordIndex values refer to this list when present.
        let pn_index = entity.get(3).and_then(|attr| attr.as_list()).map(|list| {
            list.iter()
                .filter_map(|value| value.as_int())
                .filter(|v| *v > 0)
                .map(|v| v as u32)
                .collect::<Vec<u32>>()
        });

        // Pre-allocate indices - estimate 2 triangles per face average
        let mut indices = Vec::with_capacity(face_refs.len() * 6);

        // Process each face
        for face_ref in face_refs {
            let face_id = face_ref
                .as_entity_ref()
                .ok_or_else(|| Error::geometry("Expected entity reference for face".to_string()))?;

            let face_entity = decoder.decode_by_id(face_id)?;

            // IfcIndexedPolygonalFace has CoordIndex at attribute 0
            // IfcIndexedPolygonalFaceWithVoids has CoordIndex at 0 and InnerCoordIndices at 1
            let coord_index_attr = face_entity.get(0).ok_or_else(|| {
                Error::geometry("IndexedPolygonalFace missing CoordIndex".to_string())
            })?;

            let coord_indices = coord_index_attr
                .as_list()
                .ok_or_else(|| Error::geometry("Expected coord index list".to_string()))?;

            // Parse face indices (1-based in IFC), with optional PnIndex remapping.
            let face_indices = Self::parse_index_loop(coord_indices, pn_index.as_deref());
            if face_indices.len() < 3 {
                continue;
            }

            // Parse optional inner loops for IfcIndexedPolygonalFaceWithVoids.
            let inner_indices = Self::parse_face_inner_indices(&face_entity, pn_index.as_deref());

            // Triangulate the polygon face (including holes when present).
            Self::triangulate_polygon(&face_indices, &inner_indices, &positions, &mut indices);
        }

        // Closed shells from some exporters may be consistently inward.
        // Flip globally to outward winding when needed.
        let is_closed = entity
            .get(1)
            .and_then(|a| a.as_enum())
            .map(|v| v == "T")
            .unwrap_or(false);
        if is_closed {
            Self::orient_closed_shell_outward(&positions, &mut indices);
        }

        Ok(Self::build_flat_shaded_mesh(&positions, &indices))
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcPolygonalFaceSet]
    }
}

impl Default for PolygonalFaceSetProcessor {
    fn default() -> Self {
        Self::new()
    }
}
