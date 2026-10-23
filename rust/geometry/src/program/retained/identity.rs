// SPDX-License-Identifier: MPL-2.0
//! Logical provenance checks do not grant numerical or publication authority.
use super::*;
impl LogicalRetainedValue {
    pub(super) fn validate_identity(&self) -> crate::Result<()> {
        let valid = match self.definition {
            LogicalRetainedDefinition::Source { slot, source_epoch, source_revision, source_id } =>
                slot.program == self.slot.program && source_id != 0
                    && source_epoch == self.contract.source_epoch
                    && source_revision == self.contract.source_revision,
            LogicalRetainedDefinition::Operation(slot) => slot.program == self.slot.program,
        };
        if !valid || !self.length_unit_scale.is_finite() || self.length_unit_scale <= 0. {
            return Err(crate::Error::geometry("invalid retained source identity or unit domain"));
        }
        validate_affine(&self.world_from_evaluation())
    }
}
