// SPDX-License-Identifier: MPL-2.0
//! Orphan type geometry uses its authenticated MappingOrigin, never ObjectPlacement.
use super::{logical, Plan, TransactionError};

impl Plan {
    /// Every final value must belong to this orphan type and end at a planned map.
    /// Empty or mixed-authority plans cannot acquire placement authority.
    pub fn type_origin_placed(&self, type_product: u32, maps: &[u32]) -> bool {
        !self.inner.values.is_empty() && self.inner.values.iter().all(|value| {
            !value.is_product_placed()
                && value.placements().last().is_some_and(|placement| {
                    matches!(placement.stage, logical::RetainedPlacementStage::TypeMap { representation_map }
                        if maps.contains(&representation_map))
                })
                && value.presentation().last().is_some_and(|binding|
                    binding.type_product == Some((type_product, 1)))
        })
    }

    /// Discharge both obligations only after the whole plan proves type placement.
    /// An IfcTypeProduct cannot be RelatingBuildingElement of IfcRelVoidsElement.
    pub fn discharge_type_origin(mut self, type_product: u32, maps: &[u32]) -> Result<Self, TransactionError> {
        crate::resource::charge(crate::resource::Cost {
            work: self.inner.values.len() as u64, ..Default::default()
        }).map_err(TransactionError::stopped)?.retain();
        if self.type_origin_placed(type_product, maps) {
            self.inner.remaining.retain(|requirement| !matches!(requirement,
                logical::RetainedRequirement::ProductPlacement | logical::RetainedRequirement::OpeningClosure));
        }
        Ok(self)
    }
}
