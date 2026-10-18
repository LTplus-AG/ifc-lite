// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! ExtrudedAreaSolidTapered processor — lofted extrusion between two profiles.
//!
//! Adds support for `IfcExtrudedAreaSolidTapered`, a subtype of
//! `IfcExtrudedAreaSolid` with one extra attribute (`EndSweptArea`, attr 4).
//! The cross-section linearly transitions from `SweptArea` at the base to
//! `EndSweptArea` at `Depth` along `ExtrudedDirection`.

use crate::{
    profiles::ProfileProcessor,
    Mesh, Result, TessellationQuality,
};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

use crate::router::GeometryProcessor;

#[path = "extrusion_tapered_plan.rs"]
pub(crate) mod plan;

pub struct ExtrudedAreaSolidTaperedProcessor {
    profile_processor: ProfileProcessor,
}

impl ExtrudedAreaSolidTaperedProcessor {
    pub fn new(schema: IfcSchema) -> Self {
        Self {
            profile_processor: ProfileProcessor::new(schema),
        }
    }

    pub(crate) fn lower(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
    ) -> Result<plan::TaperedExtrusionPlan> {
        plan::lower(entity, decoder, quality, &self.profile_processor)
    }
}

impl GeometryProcessor for ExtrudedAreaSolidTaperedProcessor {
    fn lower_owned(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        quality: TessellationQuality, rtc_file_units: Option<(f64, f64, f64)>)
        -> Option<Result<crate::program::OwnedConstructor>> {
        use crate::program::constructor::Constructor;
        if rtc_file_units.is_some() { return None; }
        Some(self.lower(entity, decoder, quality).map(|plan| crate::program::OwnedConstructor::new(Constructor::TaperedExtrusion(plan))))
    }

    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        self.lower(entity, decoder, quality)?.evaluate()
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcExtrudedAreaSolidTapered]
    }
}
