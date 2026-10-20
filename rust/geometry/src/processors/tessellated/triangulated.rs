// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

use crate::router::GeometryProcessor;

use super::triangulated_plan;

/// TriangulatedFaceSet processor (P0)
/// Handles IfcTriangulatedFaceSet - explicit triangle meshes
pub struct TriangulatedFaceSetProcessor;

impl TriangulatedFaceSetProcessor {
    pub fn new() -> Self {
        Self
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
        Ok(triangulated_plan::lower(entity, decoder, rtc_file_units)?.evaluate_with_texture(map))
    }

    /// Mesh the face set; `rtc_file_units` rebases before f32 narrowing.
    fn process_rebased(
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        rtc_file_units: Option<(f64, f64, f64)>,
    ) -> Result<Mesh> {
        Ok(triangulated_plan::lower(entity, decoder, rtc_file_units)?.evaluate())
    }
}

impl GeometryProcessor for TriangulatedFaceSetProcessor {
    fn lower_owned(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        _quality: crate::TessellationQuality, rtc_file_units: Option<(f64, f64, f64)>)
        -> Option<crate::Result<crate::program::OwnedConstructor>> {
        use crate::program::constructor::Constructor;
        Some(triangulated_plan::lower(entity, decoder, rtc_file_units).map(|plan| crate::program::OwnedConstructor::new(Constructor::Triangles(plan))))
    }

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
