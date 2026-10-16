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
    /// `(positions, indices, flipped, authored)`: `flipped` is whether the
    /// whole shell was winding-flipped (the texture path needs it to keep the
    /// parallel `TexCoordIndex` in lockstep, #961), and `authored` is the
    /// CoordIndex before the `PnIndex` remap, winding-flipped the same way,
    /// when the face set has a `PnIndex` (`None` otherwise: `indices` is the
    /// authored CoordIndex then). Shared by `process` and
    /// [`Self::process_with_texture`] so there is one parse/orient code path.
    /// `rtc_file_units` rebases before f32 narrowing (see `read_point_list`).
    fn parse_positions_and_orient(
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        rtc_file_units: Option<(f64, f64, f64)>,
    ) -> Result<(Vec<f32>, Vec<u32>, bool, Option<Vec<u32>>)> {
        // IfcTriangulatedFaceSet attributes:
        // 0: Coordinates (IfcCartesianPointList3D)
        // 1: Normals (optional)
        // 2: Closed (optional)
        // 3: CoordIndex (list of list of IfcPositiveInteger)
        // 4: PnIndex (optional; CoordIndex values index it, its values
        //    index Coordinates)

        let coords_attr = entity.get(0).ok_or_else(|| {
            Error::geometry("TriangulatedFaceSet missing Coordinates".to_string())
        })?;
        let coord_entity_id = coords_attr.as_entity_ref().ok_or_else(|| {
            Error::geometry("Expected entity reference for Coordinates".to_string())
        })?;
        let positions = super::read_point_list(decoder, coord_entity_id, rtc_file_units)?;

        let mut indices = super::indices::read_triangle_coord_index(entity, decoder)?;
        let mut authored = None;
        if let Some(pn_index) = super::indices::read_pn_index(entity, 4) {
            let remapped = indices
                .iter()
                .map(|&corner| super::indices::through_pn_index(corner, Some(&pn_index)))
                .collect();
            authored = Some(std::mem::replace(&mut indices, remapped));
        }

        let flipped = super::orients_outward(entity.get(2))
            && PolygonalFaceSetProcessor::orient_closed_shell_outward(&positions, &mut indices);
        if flipped {
            for tri in authored.iter_mut().flat_map(|a| a.chunks_exact_mut(3)) {
                tri.swap(1, 2);
            }
        }

        Ok((positions, indices, flipped, authored))
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
        self.process_with_texture_rebased(entity, decoder, map, None)
    }

    /// [`Self::process_with_texture`]; `rtc_file_units` rebases positions
    /// before f32 narrowing, as [`GeometryProcessor::process_in_rtc_frame`]
    /// does, and marks the mesh `rtc_applied` (#5698).
    pub(crate) fn process_with_texture_rebased(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        map: &crate::processors::texture::ResolvedTextureMap,
        rtc_file_units: Option<(f64, f64, f64)>,
    ) -> Result<(Mesh, Vec<f32>)> {
        let (positions, indices, flipped, authored) =
            Self::parse_positions_and_orient(entity, decoder, rtc_file_units)?;
        let tex_coord_index = match &map.tex_coord_index {
            Some(authored) => {
                let mut idx = authored.clone();
                if flipped {
                    for tri in idx.iter_mut() {
                        tri.swap(1, 2);
                    }
                }
                idx
            }
            // TexCoordIndex omitted (`$`): the CoordIndex IS the UV index
            // (#1781), as authored, so under `PnIndex` texture vertex `n`
            // pairs with CoordIndex value `n`, not with the remapped point.
            // Derived from the POST-orientation corners (0-based → 1-based),
            // so the whole-shell winding flip is already reflected — no swap.
            // An invalid corner stays out of range (its triangle is dropped).
            None => authored
                .as_deref()
                .unwrap_or(&indices)
                .chunks_exact(3)
                .map(|t| [t[0], t[1], t[2]].map(|i| i.saturating_add(1)))
                .collect(),
        };
        let (mut mesh, uvs) = PolygonalFaceSetProcessor::build_flat_shaded_mesh_with_uvs(
            &positions,
            &indices,
            &map.tex_coords,
            &tex_coord_index,
        );
        mesh.validate_indices();
        mesh.rtc_applied = rtc_file_units.is_some();
        Ok((mesh, uvs))
    }

    /// Mesh the face set; `rtc_file_units` rebases before f32 narrowing.
    fn process_rebased(
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        rtc_file_units: Option<(f64, f64, f64)>,
    ) -> Result<Mesh> {
        let (positions, indices, _flipped, _authored) =
            Self::parse_positions_and_orient(entity, decoder, rtc_file_units)?;

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
        mesh.rtc_applied = rtc_file_units.is_some();
        Ok(mesh)
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
        Self::process_rebased(entity, decoder, None)
    }

    fn process_in_rtc_frame(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        _quality: TessellationQuality,
        rtc_file_units: (f64, f64, f64),
    ) -> Option<Result<Mesh>> {
        Some(Self::process_rebased(entity, decoder, Some(rtc_file_units)))
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
