// SPDX-License-Identifier: MPL-2.0
//! Distinct derived construction, never an authored IfcExtrudedAreaSolid.
use super::*;
use crate::analytic::DerivedLayerRegions;
#[derive(Debug, Clone, PartialEq)]
pub struct DerivedLayerRegion {
    proof: Arc<DerivedLayerRegions>,
    ordinal: usize,
}
impl DerivedLayerRegion {
    pub fn new(proof: Arc<DerivedLayerRegions>, ordinal: usize) -> Result<Self, RetainedRefusal> {
        if ordinal >= proof.len() { return Err(RetainedRefusal::InvalidSource("derived band ordinal")); }
        Ok(Self { proof, ordinal })
    }
    pub fn source_solid(&self) -> u32 { self.proof.solid_id() }
    pub(super) fn lower(&self) -> Result<SweepPayload, RetainedRefusal> {
        retained_sweep::lower_derived_encoding(&self.proof.encoding(self.ordinal)?)
    }
}
impl GeometryDocument {
    pub fn add_derived_layer_region(&mut self, region: DerivedLayerRegion)
        -> Result<RetainedDefinitionHandle, RetainedRefusal> {
        let payload = region.lower()?;
        self.retain(RetainedRecipe::DerivedLayer(region),payload)
    }
}
