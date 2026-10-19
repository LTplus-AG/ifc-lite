// SPDX-License-Identifier: MPL-2.0
//! Live actual definition leases and logical output manifest validation.
use super::*;
impl RetainedProductExecution {
    pub(super) fn validate_definitions(
        &self,
        worker: &SelectedWorker,
    ) -> Result<(), RetainedExecutionError> {
        for entry in &self.ledger {
            ifc_lite_geometry::resource::charge(ifc_lite_geometry::resource::Cost {
                work: 1,
                ..Default::default()
            })
            .map_err(RetainedExecutionError::Stopped)?
            .retain();
            entry.receipt.validate_live().map_err(protocol)?;
            if !entry.receipt.belongs_to(&target::capture(worker)) {
                return Err(protocol(
                    "retained definition belongs to a different runtime generation",
                ));
            }
        }
        Ok(())
    }
    pub(super) fn validate_manifest(
        &self,
        plan: &RetainedProductPlan,
    ) -> Result<(), RetainedExecutionError> {
        let mut seen = Vec::new();
        self.resources
            .reserve_headers(&mut seen, plan.values.len())
            .map_err(RetainedExecutionError::Stopped)?
            .retain();
        for value in &plan.values {
            ifc_lite_geometry::resource::charge(ifc_lite_geometry::resource::Cost {
                work: (seen.len() + self.ledger.len()) as u64,
                ..Default::default()
            })
            .map_err(RetainedExecutionError::Stopped)?
            .retain();
            if seen.contains(&value.slot())
                || !self.ledger.iter().any(|entry| {
                    entry.operation.value().definition() == value.definition()
                        && entry.receipt.validate_live().is_ok()
                })
            {
                return Err(protocol(
                    "duplicate occurrence or undischarged retained definition",
                ));
            }
            seen.push(value.slot());
        }
        Ok(())
    }
}
