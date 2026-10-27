// SPDX-License-Identifier: MPL-2.0
use super::*;
impl<R: NumericalReceipt> RuntimeProductExecution<'_, R> {
    fn validate_completion(
        &self,
        work: &RuntimeCompleted<R>,
        decoder: &EntityDecoder,
        router: &GeometryRouter,
    ) -> Result<(), RetainedExecutionError> {
        check_resources(&self.resources)?;
        let pending = self
            .pending
            .as_ref()
            .ok_or_else(|| protocol(ReceiptFailure::NoPendingAdmission))?;
        if !Arc::ptr_eq(&pending.cancellation.stage, &work.cancellation.stage) {
            return Err(protocol(ReceiptFailure::ForeignConstructionReceipt));
        }
        if let Err(error) = self.context.lifecycle().validate() {
            pending.cancellation.cancel();
            return Err(RetainedExecutionError::Source(error));
        }
        let owner = self.validate(decoder, router)?;
        self.state
            .protocol
            .before_execute(pending.outer)
            .map_err(protocol)?;
        if Some(pending.outer) != self.outer
            || pending.owner != owner
            || !Arc::ptr_eq(&pending.cancellation.stage, &work.cancellation.stage)
            || pending.cancellation.stage.load(Ordering::Acquire) != DELIVERED
        {
            return Err(protocol(ReceiptFailure::ForeignConstructionTicketStageOwner));
        }
        let program = self
            .program
            .as_ref()
            .ok_or_else(|| protocol(ReceiptFailure::MissingProgram))?;
        program.validate_ticket(pending.common).map_err(common)?;
        program
            .validate_reply(&pending.reply, router)
            .map_err(common)?;
        if pending.operations.len() != work.realizations.len() {
            return Err(protocol(ReceiptFailure::RetainedBatchLengthMismatch));
        }
        for (index, (operation, receipt)) in pending.operations.iter().zip(&work.realizations).enumerate() {
            resource::charge(resource::Cost { work: index as u64 + 1, ..Default::default() })
                .map_err(RetainedExecutionError::Stopped)?.retain();
            if pending.operations[..index].iter().any(|other|
                other.expected().value().slot() == operation.expected().value().slot()) {
                return Err(protocol(ReceiptFailure::DuplicateRetainedOutputSlot));
            }
            self.validate_operation(operation, receipt, &pending.cancellation.owner)?;
        }
        Ok(())
    }
    // Refs #7955: D's whole-model driver consumes this executor entry.
    #[allow(dead_code)]
    pub(super) fn accept(
        &mut self,
        work: RuntimeCompleted<R>,
        decoder: &mut EntityDecoder,
        router: &GeometryRouter,
    ) -> Result<(), Box<RuntimeRejectedCompletion<R>>> {
        let validation = self.resources.with_scope(|| self.validate_completion(&work, decoder, router));
        let validation = check_resources(&self.resources).and(validation)
            .and_then(|()| self.permits.reserve(&self.resources, &mut self.ledger, work.realizations.len()))
            .and_then(|()| check_resources(&self.resources));
        if let Err(reason) = validation {
            // Retire only this controller's captured domain on its terminal
            // fault. Never cancel the supplied (possibly foreign) envelope.
            if reason.terminal() { self.cancel(); }
            return Err(Box::new(RuntimeRejectedCompletion { reason, work }));
        }
        if work
            .cancellation
            .stage
            .compare_exchange(DELIVERED, ACCEPTED, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(Box::new(RuntimeRejectedCompletion {
                reason: protocol(ReceiptFailure::CancelledDelivery),
                work,
            }));
        }
        let Some(pending) = self.pending.take() else {
            return Err(Box::new(RuntimeRejectedCompletion {
                reason: protocol(ReceiptFailure::MissingAdmission),
                work,
            }));
        };
        // Every receipt and the entire batch have validated before changing
        // any shared logical outcome. Publication still occurs only below.
        for (operation, receipt) in pending.operations.iter().zip(&work.realizations) {
            if let Err(error) = operation.expected().bind_numerical_outcome(receipt.is_empty()) {
                self.failed = true;
                pending.cancellation.cancel();
                return Err(Box::new(RuntimeRejectedCompletion { reason: geometry(error), work }));
            }
        }
        let result = self
            .resources
            .with_scope(|| {
                self.owner.work(decoder, router, |_, r| {
                    self.scopes.with_scope(|| {
                        self.program
                            .as_mut()
                            .ok_or_else(|| protocol(ReceiptFailure::MissingProgram))?
                            .accept(pending.reply, r)
                            .map_err(|e| common(e.error))
                    })
                })
            })
            .map_err(protocol)
            .and_then(|(result, _)| result);
        let result = check_resources(&self.resources).and(result)
            .and_then(|()| self.validate(decoder, router).map(|_| ()));
        if let Err(reason) = result {
            self.failed = true;
            pending.cancellation.cancel();
            return Err(Box::new(RuntimeRejectedCompletion { reason, work }));
        }
        // Never overwrite a cancellation which raced the synchronous consume.
        if pending.cancellation.stage.load(Ordering::Acquire) != ACCEPTED
            || pending.cancellation.owner.incarnation().is_none()
        {
            self.failed = true;
            pending.cancellation.cancel();
            return Err(Box::new(RuntimeRejectedCompletion {
                reason: protocol(ReceiptFailure::CancelledDelivery), work,
            }));
        }
        // Move the authenticated logical values; no clone/allocation after consumption.
        self.ledger.extend(pending.operations.into_iter()
            .map(|operation| operation.into_value()).zip(work.realizations));
        Ok(())
    }
}
