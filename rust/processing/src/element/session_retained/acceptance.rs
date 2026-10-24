// SPDX-License-Identifier: MPL-2.0
use super::*;
impl<R: NumericalReceipt> RuntimeProductExecution<'_, R> {
    fn validate_completion(
        &self,
        work: &RuntimeCompleted<R>,
        decoder: &EntityDecoder,
        router: &GeometryRouter,
    ) -> Result<(), RetainedExecutionError> {
        self.resources
            .check()
            .map_err(RetainedExecutionError::Stopped)?;
        let pending = self
            .pending
            .as_ref()
            .ok_or_else(|| protocol("no pending admission"))?;
        if !Arc::ptr_eq(&pending.cancellation.stage, &work.cancellation.stage) {
            return Err(protocol("foreign construction receipt"));
        }
        if self.context.validate_source().is_err() {
            pending.cancellation.cancel();
            return Err(RetainedExecutionError::Source);
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
            return Err(protocol("foreign construction ticket/stage/owner"));
        }
        let program = self
            .program
            .as_ref()
            .ok_or_else(|| protocol("missing program"))?;
        program.validate_ticket(pending.common).map_err(common)?;
        program
            .validate_reply(&pending.reply, router)
            .map_err(common)?;
        if pending.operations.len() != work.realizations.len() {
            return Err(protocol("retained batch length mismatch"));
        }
        for (index, (operation, receipt)) in pending.operations.iter().zip(&work.realizations).enumerate() {
            if pending.operations[..index].iter().any(|other|
                other.expected().value().slot() == operation.expected().value().slot()) {
                return Err(protocol("duplicate retained output slot"));
            }
            self.validate_operation(operation, receipt, &pending.cancellation.owner)?;
        }
        Ok(())
    }
    pub fn accept(
        &mut self,
        work: RuntimeCompleted<R>,
        decoder: &mut EntityDecoder,
        router: &GeometryRouter,
    ) -> Result<(), Box<RuntimeRejectedCompletion<R>>> {
        let validation = self
            .resources
            .with_scope(|| self.validate_completion(&work, decoder, router))
            .and_then(|()| {
                let ledger_permit = self
                    .resources
                    .reserve_headers(&mut self.ledger, work.realizations.len())
                    .map_err(RetainedExecutionError::Stopped)?;
                self.resources
                    .reserve_headers(&mut self.permits, 1)
                    .map_err(RetainedExecutionError::Stopped)?
                    .retain();
                Ok(ledger_permit)
            });
        let permit = match validation {
            Ok(permit) => permit,
            Err(reason) => return Err(Box::new(RuntimeRejectedCompletion { reason, work })),
        };
        let values = self.resources.with_scope(|| {
            let mut values = Vec::new();
            self.resources.reserve_headers(&mut values, work.realizations.len()).map_err(RetainedExecutionError::Stopped)?.retain();
            let pending = self.pending.as_ref().ok_or_else(|| protocol("missing admission"))?;
            for operation in &pending.operations { values.push(operation.expected().value().try_copy().map_err(geometry)?); }
            Ok::<_, RetainedExecutionError>(values)
        });
        let values = match values { Ok(values) => values,
            Err(reason) => return Err(Box::new(RuntimeRejectedCompletion { reason, work })) };
        if work
            .cancellation
            .stage
            .compare_exchange(DELIVERED, ACCEPTED, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(Box::new(RuntimeRejectedCompletion {
                reason: protocol("cancelled delivery"),
                work,
            }));
        }
        let Some(pending) = self.pending.take() else {
            return Err(Box::new(RuntimeRejectedCompletion {
                reason: protocol("missing admission"),
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
                            .ok_or_else(|| protocol("missing program"))?
                            .accept(pending.reply, r)
                            .map_err(|e| common(e.error))
                    })
                })
            })
            .map_err(protocol)
            .and_then(|(result, _)| result)
            .and_then(|()| self.resources.check().map_err(RetainedExecutionError::Stopped));
        if let Err(reason) = result {
            self.failed = true;
            pending.cancellation.cancel();
            return Err(Box::new(RuntimeRejectedCompletion { reason, work }));
        }
        pending
            .cancellation
            .stage
            .store(ACCEPTED, Ordering::Release);
        self.permits.push(permit);
        self.ledger.extend(values.into_iter().zip(work.realizations));
        Ok(())
    }
}
