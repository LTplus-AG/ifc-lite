// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Standalone planar `IfcFaceSurface` processing for structural surface topology.

use crate::router::GeometryProcessor;
use crate::{Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

pub struct IfcFaceSurfaceProcessor;

impl IfcFaceSurfaceProcessor {
    pub fn new() -> Self {
        Self
    }

    fn process_planar(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
        rtc_file_units: Option<(f64, f64, f64)>,
    ) -> Result<Mesh> {
        super::structural_face_plan::lower(entity, decoder, quality, rtc_file_units)?.evaluate()
    }
}

impl Default for IfcFaceSurfaceProcessor {
    fn default() -> Self {
        Self::new()
    }
}

impl GeometryProcessor for IfcFaceSurfaceProcessor {
    fn lower_owned(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        quality: crate::TessellationQuality, rtc_file_units: Option<(f64, f64, f64)>)
        -> Option<crate::Result<crate::program::OwnedConstructor>> {
        use crate::program::constructor::Constructor;
        Some(super::structural_face_plan::lower(entity, decoder, quality, rtc_file_units).map(|plan| crate::program::OwnedConstructor::new(Constructor::FaceSurface(plan))))
    }

    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        // Non-planar direct faces remain intentionally empty until their
        // arbitrary bounds can clip the analytic surface safely.
        self.process_planar(entity, decoder, quality, None)
    }

    fn process_in_rtc_frame(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        quality: TessellationQuality,
        rtc_file_units: (f64, f64, f64),
    ) -> Option<Result<Mesh>> {
        Some(self.process_planar(entity, decoder, quality, Some(rtc_file_units)))
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcFaceSurface, IfcType::IfcAdvancedFace]
    }
}
