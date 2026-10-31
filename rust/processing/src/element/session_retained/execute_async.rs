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
        let completed = match self.execute_started_async(worker, limits).await {
            Ok(completed) => completed,
            Err(reason) => {
                // Every invocation has returned. Source/resource refusals can
                // release their receipts normally; no kernel work is in flight.
                self.armed = false;
                self.cancellation.stage.store(SETTLED_FAULT, Ordering::Release);
                let contract = matches!(&reason, RetainedExecutionError::Runtime(fault)
                    if fault.kind == RuntimeFaultKind::Contract);
                // #7955: a failed band is still atomic, but a synchronized
                // transactional refusal must not consume the host model's
                // restart budget. Native and browser executors preserve their
                // domain only for known pre-copy statuses 1..7. Unknown status,
                // transport loss, and other faults retain fault recovery. #8291: a
                // face-set operation gets the same treatment, because real coverings
                // refuse cuts routinely and each must not cost later products a restart.
                let synchronized_refusal = (self.layer_phase || self.touches_face_set())
                    && self.cancellation.owner.incarnation().is_some()
                    && matches!(&reason, RetainedExecutionError::Runtime(fault)
                        if matches!(fault.kind, RuntimeFaultKind::Kernel { status: 1..=7 }));
                if !reason.controller_cancelled() && !contract && !synchronized_refusal {
                    // Fault recovery, never a controller-owned cancellation.
                    self.cancellation.owner.retire();
                }
                return Err(RuntimeRejectedExecution::terminal(reason));
            }
        };
        self.armed = false;
        Ok(completed)
    }

    fn touches_face_set(&self) -> bool {
        self.operations.iter().any(|operation| match operation {
            IssuedRetainedOperation::Boolean { inputs, .. } => inputs.iter().any(|input| input.realization.has_face_set()),
            IssuedRetainedOperation::Affine { input, .. } => input.has_face_set(),
            IssuedRetainedOperation::Construction { .. } => false,
        })
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
            // A transport/kernel fault wins over a deadline that elapsed while
            // awaiting it. Do not relabel a dead worker as a cooperative stop.
            let result = result?;
            self.checkpoint()?;
            realizations.push(operation.seal(result, permit, &self.resources)?);
        }
        self.finish(realizations, storage)
    }
}
