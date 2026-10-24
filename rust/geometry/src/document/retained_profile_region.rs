// SPDX-License-Identifier: MPL-2.0
//! Retained-only bridge from an authenticated authored walk to a proved region.
use super::{GeometryDocument, RetainedDefinitionHandle, RetainedExtrusion, RetainedRecipe, RetainedRefusal, SweepPayload};
use crate::analytic::{self, AnalyticStatus, RetainedProfileRegion};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq)]
pub struct RetainedRegionExtrusion {
    pub region: Arc<RetainedProfileRegion>,
    pub length_unit_scale: f64,
}
impl RetainedRegionExtrusion {
    pub(super) fn lower(&self) -> Result<SweepPayload, RetainedRefusal> {
        super::retained_sweep::lower(&RetainedExtrusion {
            source: self.region.encoding_view().map_err(RetainedRefusal::UnsupportedSource)?, length_unit_scale: self.length_unit_scale,
        })
    }
}

/// Shared retained source decision, before native/browser dispatch. Exact
/// extraction itself remains conservative. A refused regularization is terminal.
pub fn capture_retained_extrusion(
    solid: &DecodedEntity, decoder: &mut EntityDecoder, length_unit_scale: f64,
) -> Result<RetainedRecipe, RetainedRefusal> {
    analytic::with_source_capture(|| {
        let source = analytic::extract_analytic_extrusion(solid, decoder);
        if source.status == AnalyticStatus::Complete {
            return Ok(RetainedRecipe::Extrusion(RetainedExtrusion { source, length_unit_scale }));
        }
        let region = RetainedProfileRegion::capture(solid, decoder)
            .map_err(RetainedRefusal::UnsupportedSource)?;
        Ok(RetainedRecipe::RegularizedExtrusion(RetainedRegionExtrusion {
            region: Arc::new(region), length_unit_scale,
        }))
    })
}
impl GeometryDocument {
    pub fn add_retained_region_extrusion(&mut self, recipe: RetainedRegionExtrusion)
        -> Result<RetainedDefinitionHandle, RetainedRefusal> {
        let payload = recipe.lower()?;
        self.retain(RetainedRecipe::RegularizedExtrusion(recipe), payload)
    }
}
