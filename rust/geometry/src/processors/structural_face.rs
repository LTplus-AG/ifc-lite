// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Standalone planar `IfcFaceSurface` processing for structural surface topology.

use crate::router::GeometryProcessor;
use crate::{Error, Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

use super::advanced_face::process_advanced_face;

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
        let surface_attribute = entity
            .get(1)
            .ok_or_else(|| Error::geometry("FaceSurface missing FaceSurface"))?;
        let surface = decoder
            .resolve_ref(surface_attribute)?
            .ok_or_else(|| Error::geometry("Failed to resolve FaceSurface"))?;
        if surface.ifc_type != IfcType::IfcPlane {
            return Ok(Mesh::new());
        }
        let (positions, indices) =
            process_advanced_face(entity, decoder, quality, rtc_file_units)?;
        Ok(Mesh {
            positions,
            normals: Vec::new(),
            indices,
            rtc_applied: rtc_file_units.is_some(),
            welded_in_object_frame: false,
            plane_tags: None,
            origin: [0.0; 3],
            instance_meta: None,
            local_bounds: None,
            local_to_world: None,
        })
    }
}

impl Default for IfcFaceSurfaceProcessor {
    fn default() -> Self {
        Self::new()
    }
}

impl GeometryProcessor for IfcFaceSurfaceProcessor {
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
