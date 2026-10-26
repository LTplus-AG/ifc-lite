// SPDX-License-Identifier: MPL-2.0
//! Logical provenance checks do not grant numerical or publication authority.
use super::*;
use super::value_error::ValueReason;
impl LogicalRetainedValue {
    pub(super) fn validate_identity(&self) -> Result<(), ValueReason> {
        match self.definition {
            LogicalRetainedDefinition::Source { slot, source_epoch, source_revision, source_id } => {
                if slot.program != self.slot.program { return Err(ValueReason::SourceProgram); }
                if source_id == 0 { return Err(ValueReason::MissingSourceId); }
                if source_epoch != self.contract.source_epoch { return Err(ValueReason::SourceEpoch); }
                if source_revision != self.contract.source_revision { return Err(ValueReason::SourceRevision); }
            }
            LogicalRetainedDefinition::Operation(slot) => {
                if slot.program != self.slot.program { return Err(ValueReason::OperationProgram); }
            }
        }
        if !self.length_unit_scale.is_finite() || self.length_unit_scale <= 0. {
            return Err(ValueReason::UnitDomain);
        }
        validate_affine(&self.world_from_evaluation())
    }
}

#[cfg(all(test, any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
#[path = "identity_tests.rs"]
mod tests;
