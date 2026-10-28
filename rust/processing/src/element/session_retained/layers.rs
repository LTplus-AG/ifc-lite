// SPDX-License-Identifier: MPL-2.0
//! Layer work starts only once the host's clips and opening cuts are complete.
use super::*;
impl<R: NumericalReceipt> RuntimeProductExecution<'_, R> {
    pub(super) fn complete_layers(&mut self, plan: RetainedProductPlan) -> Result<(), RetainedExecutionError> {
        if let Some(spec) = self.layer_spec.take() {
            self.layer_start = Some(resource::BudgetStart::now());
            self.program = Some(self.resources.with_scope(|| self.traversal.layer_bands(plan, spec)).map_err(common)?);
            self.outer = Some(self.state.protocol.issue(WorkKind::PlainParts));
            self.layer_active = true;
        } else {
            self.plan = Some(plan.discharge_layers());
            self.state.stage = Stage::Complete;
        }
        Ok(())
    }
}
