// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Standalone `IfcFaceSurface` processing for structural surface topology.

use crate::router::GeometryProcessor;
use crate::{Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

use super::advanced_face::process_advanced_face;

pub struct IfcFaceSurfaceProcessor;

impl IfcFaceSurfaceProcessor {
    pub fn new() -> Self {
        Self
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
        let (positions, indices) = process_advanced_face(entity, decoder, quality)?;
        Ok(Mesh {
            positions,
            normals: Vec::new(),
            indices,
            rtc_applied: false,
            welded_in_object_frame: false,
            plane_tags: None,
            origin: [0.0; 3],
            instance_meta: None,
            local_bounds: None,
            local_to_world: None,
        })
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcFaceSurface]
    }
}
