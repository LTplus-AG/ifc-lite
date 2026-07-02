// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{Error, Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

use crate::router::GeometryProcessor;

use super::polygonal::PolygonalFaceSetProcessor;

/// TriangulatedFaceSet processor (P0)
/// Handles IfcTriangulatedFaceSet - explicit triangle meshes
pub struct TriangulatedFaceSetProcessor;

impl TriangulatedFaceSetProcessor {
    pub fn new() -> Self {
        Self
    }

    /// Parse an `IfcTriangulatedFaceSet`'s positions + triangle indices and
    /// apply the closed-shell outward orientation. Returns
    /// `(positions, indices, flipped)` where `flipped` is whether the whole
    /// shell was winding-flipped — the texture path needs it to keep the
    /// parallel `TexCoordIndex` in lockstep (#961). Shared by `process` and
    /// [`Self::process_with_texture`] so there is one parse/orient code path.
    fn parse_positions_and_orient(
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<(Vec<f32>, Vec<u32>, bool)> {
        // IfcTriangulatedFaceSet attributes:
        // 0: Coordinates (IfcCartesianPointList3D)
        // 1: Normals (optional)
        // 2: Closed (optional)
        // 3: CoordIndex (list of list of IfcPositiveInteger)

        // Get coordinate entity reference
        let coords_attr = entity.get(0).ok_or_else(|| {
            Error::geometry("TriangulatedFaceSet missing Coordinates".to_string())
        })?;

        let coord_entity_id = coords_attr.as_entity_ref().ok_or_else(|| {
            Error::geometry("Expected entity reference for Coordinates".to_string())
        })?;

        // FAST PATH: Try direct parsing of raw bytes (3-5x faster)
        // This bypasses Token/AttributeValue allocations entirely
        use ifc_lite_core::{extract_coordinate_list_from_entity, parse_indices_direct};

        let positions = if let Some(raw_bytes) = decoder.get_raw_bytes(coord_entity_id) {
            // Fast path: parse coordinates directly from raw bytes
            // Use extract_coordinate_list_from_entity to skip entity header (#N=IFCTYPE...)
            extract_coordinate_list_from_entity(raw_bytes).unwrap_or_default()
        } else {
            // Fallback path: use standard decoding
            let coords_entity = decoder.decode_by_id(coord_entity_id)?;

            let coord_list_attr = coords_entity.get(0).ok_or_else(|| {
                Error::geometry("CartesianPointList3D missing CoordList".to_string())
            })?;

            let coord_list = coord_list_attr
                .as_list()
                .ok_or_else(|| Error::geometry("Expected coordinate list".to_string()))?;

            use ifc_lite_core::AttributeValue;
            AttributeValue::parse_coordinate_list_3d(coord_list)
        };

        // Get face indices - try fast path first
        let indices_attr = entity
            .get(3)
            .ok_or_else(|| Error::geometry("TriangulatedFaceSet missing CoordIndex".to_string()))?;

        // For indices, we need to extract from the main entity's raw bytes
        // Fast path: parse directly if we can get the raw CoordIndex section
        let indices = if let Some(raw_entity_bytes) = decoder.get_raw_bytes(entity.id) {
            // Find the CoordIndex attribute (4th attribute, index 3)
            // and parse directly
            if let Some(coord_index_bytes) = super::super::extract_coord_index_bytes(raw_entity_bytes) {
                parse_indices_direct(coord_index_bytes)
            } else {
                // Fallback to standard parsing
                let face_list = indices_attr
                    .as_list()
                    .ok_or_else(|| Error::geometry("Expected face index list".to_string()))?;
                use ifc_lite_core::AttributeValue;
                AttributeValue::parse_index_list(face_list)
            }
        } else {
            let face_list = indices_attr
                .as_list()
                .ok_or_else(|| Error::geometry("Expected face index list".to_string()))?;
            use ifc_lite_core::AttributeValue;
            AttributeValue::parse_index_list(face_list)
        };

        // Read Closed (attribute 2): .T. means definitely closed, .F. means
        // definitely open, $ / UNKNOWN means "not specified". Revit-exported
        // light fixtures and similar families in IFC4 often omit Closed
        // ($) but still author closed shells — sometimes with inward-facing
        // winding (issue #819, IFC4TessellationComplex.ifc). Mirror the
        // PolygonalFaceSet orientation pass but be less strict: also apply
        // it when Closed is unknown, never when explicitly .F.
        let closed_attr = entity.get(2);
        let is_open = closed_attr
            .and_then(|a| a.as_enum())
            .map(|v| v == "F")
            .unwrap_or(false);

        let mut indices = indices;
        let flipped = if !is_open {
            PolygonalFaceSetProcessor::orient_closed_shell_outward(&positions, &mut indices)
        } else {
            false
        };

        Ok((positions, indices, flipped))
    }

    /// Tessellate a textured `IfcTriangulatedFaceSet` (#961): builds the same
    /// flat-shaded mesh as [`process`] plus a per-vertex UV array aligned 1:1
    /// with the emitted vertices. `map.tex_coord_index` is parallel to the
    /// original `CoordIndex`; the same whole-shell winding flip is applied to it
    /// so corners stay aligned after orientation.
    pub fn process_with_texture(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        map: &crate::processors::texture::ResolvedTextureMap,
    ) -> Result<(Mesh, Vec<f32>)> {
        let (positions, indices, flipped) = Self::parse_positions_and_orient(entity, decoder)?;
        let mut tex_coord_index = map.tex_coord_index.clone();
        if flipped {
            for tri in tex_coord_index.iter_mut() {
                tri.swap(1, 2);
            }
        }
        let (mut mesh, uvs) = PolygonalFaceSetProcessor::build_flat_shaded_mesh_with_uvs(
            &positions,
            &indices,
            &map.tex_coords,
            &tex_coord_index,
        );
        mesh.validate_indices();
        Ok((mesh, uvs))
    }
}

impl GeometryProcessor for TriangulatedFaceSetProcessor {
    #[inline]
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        _quality: TessellationQuality,
    ) -> Result<Mesh> {
        let (positions, indices, _flipped) = Self::parse_positions_and_orient(entity, decoder)?;

        // Flat-shade by duplicating vertices per-triangle. Without this, the
        // downstream per-vertex normal accumulator (`csg::calculate_normals`)
        // averages adjacent face normals at every shared vertex, which
        // softens crisp facet edges into a muddy gradient on faceted
        // geometry — visible in issue #819 on `IFC4TessellationComplex.ifc`
        // where the user contrasted ifc-lite's smoothed dome with the
        // facet-sharp BIMVision render. `PolygonalFaceSetProcessor` already
        // does this; bringing `IfcTriangulatedFaceSet` to parity matches
        // IfcOpenShell / web-ifc behaviour for `Normals = $`.
        //
        // 3× vertex bloat. Acceptable for Revit lighting/family export
        // sizes; if it ever becomes a bottleneck on giant tessellated
        // models, gate this on per-edge crease angle.
        let mut mesh = PolygonalFaceSetProcessor::build_flat_shaded_mesh(&positions, &indices);
        mesh.validate_indices();
        Ok(mesh)
    }

    fn supported_types(&self) -> Vec<IfcType> {
        // IfcTriangulatedIrregularNetwork is a subtype of IfcTriangulatedFaceSet
        // that adds an optional `ClosedOrOpen` list at the end and is used for
        // terrain (TIN) surfaces. We don't read the extra attribute and the
        // inherited Coordinates / Closed / CoordIndex layout is identical, so
        // routing TIN through the same processor is correct.
        vec![
            IfcType::IfcTriangulatedFaceSet,
            IfcType::IfcTriangulatedIrregularNetwork,
        ]
    }
}

impl Default for TriangulatedFaceSetProcessor {
    fn default() -> Self {
        Self::new()
    }
}
