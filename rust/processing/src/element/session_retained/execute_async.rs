// SPDX-License-Identifier: MPL-2.0
//! Async numerical transport over the same immutable packet and receipt ledger.
use super::runtime::{AsyncRetainedExecutor, NumericalLimits, RuntimeFaultKind};
use super::*;
use std::sync::atomic::Ordering;

impl<R: NumericalReceipt> RuntimeIssued<R> {
    // Refs #7955: D's whole-model driver consumes this executor entry.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) async fn execute_async(
        mut self,
        worker: &mut impl AsyncRetainedExecutor<Receipt = R>,
        limits: NumericalLimits,
    ) -> Result<RuntimeCompleted<R>, Box<RuntimeRejectedExecution<R>>> {
        self.validate_predispatch_state()
            .map_err(RuntimeRejectedExecution::terminal)?;
        if let Err(reason) = Self::validate_numerical_limits(
            limits.chord_metres,
            limits.angle_degrees,
            limits.max_bytes,
        ) {
            return Err(RuntimeRejectedExecution::predispatch(reason, self));
        }
        if !self.cancellation.owner.same_domain(&worker.domain()) {
            return Err(RuntimeRejectedExecution::predispatch(
                protocol(ReceiptFailure::ForeignWorker),
                self,
            ));
        }
        let completed = self
            .execute_started_async(worker, limits)
            .await
            .map_err(RuntimeRejectedExecution::terminal)?;
        self.armed = false;
        Ok(completed)
    }

    async fn execute_started_async(
        &mut self,
        worker: &mut impl AsyncRetainedExecutor<Receipt = R>,
        limits: NumericalLimits,
    ) -> Result<RuntimeCompleted<R>, RetainedExecutionError> {
        self.start()?;
        let (mut realizations, storage) = self.reserve_realizations()?;
        for operation in &self.operations {
            self.checkpoint()?;
            // The original reservation is retained, but its lexical scope ends
            // inside reserve_receipt. No resource or source-owner TLS crosses
            // the await. Dropping this future drops the armed packet and retires
            // its captured domain, including a still-running Worker operation.
            let permit = self.reserve_receipt()?;
            let result = worker.invoke(operation.invocation(), limits).await;
            self.checkpoint()?;
            let result = match result {
                Err(fault) if fault.kind == RuntimeFaultKind::Contract => {
                    // invoke settled without an outstanding numerical operation.
                    // A cancelled/checkpoint-failed invocation remains armed above.
                    self.armed = false;
                    self.cancellation.stage.store(SETTLED_FAULT, Ordering::Release);
                    return Err(fault.into());
                }
                result => result,
            };
            realizations.push(operation.seal(result?, permit, &self.resources)?);
        }
        self.finish(realizations, storage)
    }
}
