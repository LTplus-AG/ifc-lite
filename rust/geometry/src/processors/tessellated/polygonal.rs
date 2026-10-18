// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use super::polygonal_plan;

use crate::router::GeometryProcessor;

/// Handles IfcPolygonalFaceSet - explicit polygon meshes that need triangulation
/// Unlike IfcTriangulatedFaceSet, faces can be arbitrary polygons (not just triangles)
pub struct PolygonalFaceSetProcessor;

impl PolygonalFaceSetProcessor {
    pub fn new() -> Self {
        Self
    }

    /// Lower source polygons before evaluating them with the existing builders.
    fn process_rebased(entity: &DecodedEntity, decoder: &mut EntityDecoder,
        rtc_file_units: Option<(f64, f64, f64)>) -> Result<Mesh> {
        Ok(polygonal_plan::lower(entity, decoder, rtc_file_units)?.evaluate())
    }
}

impl GeometryProcessor for PolygonalFaceSetProcessor {
    fn lower_owned(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        _quality: TessellationQuality, rtc_file_units: Option<(f64, f64, f64)>)
        -> Option<Result<crate::program::OwnedConstructor>> {
        use crate::program::constructor::Constructor;
        Some(polygonal_plan::lower(entity, decoder, rtc_file_units).map(|plan| crate::program::OwnedConstructor::new(Constructor::Polygons(plan))))
    }

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
        vec![IfcType::IfcPolygonalFaceSet]
    }
}

impl Default for PolygonalFaceSetProcessor {
    fn default() -> Self {
        Self::new()
    }
}
