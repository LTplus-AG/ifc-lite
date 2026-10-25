// SPDX-License-Identifier: MPL-2.0
//! Detached numerical batches use only captured ownership and sealed inputs.
use super::*;
use super::runtime::{NumericalLimits, RetainedExecutor};
impl IssuedCommonConstruction {
    pub(super) fn execute(mut self, worker: &mut SmlibWorker, chord: f64, angle: f64, limits: MeshLimits)
        -> Result<CompletedCommonConstruction, Box<RejectedCommonExecution>> {
        self.validate_predispatch_state().map_err(RejectedCommonExecution::terminal)?;
        if let Err(reason) = Self::validate_numerical_limits(chord, angle, limits.max_bytes) {
            return Err(RejectedCommonExecution::predispatch(reason, self));
        }
        if !self.cancellation.owner.same_domain(&worker.retained_owner()) {
            return Err(RejectedCommonExecution::predispatch(protocol(ReceiptFailure::ForeignWorker), self));
        }
        let completed = self.execute_started(worker, chord, angle, limits).map_err(RejectedCommonExecution::terminal)?;
        self.armed = false;
        Ok(completed)
    }
    fn execute_started(&self, worker: &mut SmlibWorker, chord: f64, angle: f64, limits: MeshLimits)
        -> Result<CompletedCommonConstruction, RetainedExecutionError> {
        self.start()?;
        let (mut realizations, storage) = self.reserve_realizations()?;
        for operation in &self.operations {
            self.checkpoint()?;
            let permit = self.reserve_receipt()?;
            let result = self.resources.with_scope(|| worker.invoke(operation.invocation(), NumericalLimits { chord_metres: chord, angle_degrees: angle, max_bytes: limits.max_bytes }));
            self.checkpoint()?;
            realizations.push(operation.seal(result?, permit, &self.resources)?);
        }
        self.finish(realizations, storage)
    }
}
