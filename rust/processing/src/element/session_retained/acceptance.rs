// SPDX-License-Identifier: MPL-2.0
//! Intact original transaction/receipt validation before any linear take.
use super::*;
impl RetainedProductExecution {
    pub(super) fn validate_intact(
        &self,
        work: &CompletedCommonConstruction,
        decoder: &EntityDecoder<'_>,
        router: &GeometryRouter,
    ) -> Result<(), RetainedExecutionError> {
        let pending = self
            .pending
            .as_ref()
            .filter(|pending| Arc::ptr_eq(&pending.ticket, &work.ticket))
            .ok_or_else(|| protocol("foreign or duplicate retained receipt"))?;
        if !Arc::ptr_eq(&pending.stage, &work.stage)
            || pending.stage.load(Ordering::Acquire) != DELIVERED
        {
            return Err(protocol("retained delivery stage mismatch"));
        }
        if self.context.validate_source().is_err() {
            pending.cancellation.cancel();
            return Err(RetainedExecutionError::Source);
        }
        self.context
            .validate_decoder(decoder)
            .map_err(|_| RetainedExecutionError::Source)?;
        if pending.context != self.context.id() {
            return Err(protocol("retained context mismatch"));
        }
        let reply = pending
            .reply
            .as_ref()
            .ok_or_else(|| protocol("retained reply consumed"))?;
        if pending.outer != reply.request
            || pending.outer.inner != Some(pending.common)
            || pending.owner != reply.owner
        {
            return Err(protocol("retained original request/owner mismatch"));
        }
        self.state
            .validate_reply(reply, decoder, router)
            .map_err(protocol)?;
        let completion = work.realization.completion();
        if !pending.request.same_admission(completion.request()) {
            return Err(protocol("retained construction admission mismatch"));
        }
        work.realization
            .validate_live()
            .map_err(|error| RetainedExecutionError::Runtime(error.to_string()))?;
        let live = work.realization.owner().incarnation().unwrap_or(0);
        if live != pending.cancellation.owner.incarnation().unwrap_or(0) {
            return Err(protocol("retained runtime owner mismatch"));
        }
        pending
            .document
            .validate_retained_completion(completion, live)
            .map_err(protocol)?;
        if completion.source_from_evaluation != *pending.operation.value().source_from_evaluation()
            || completion.evaluation_from_source
                != *pending.operation.value().evaluation_from_source()
            || self
                .ledger
                .iter()
                .any(|entry| entry.slot == pending.operation.value().slot())
        {
            return Err(protocol("retained frame or slot mismatch"));
        }
        Ok(())
    }
}

impl RetainedProductExecution {
    pub(super) fn accept_checked(
        &mut self,
        work: CompletedCommonConstruction,
        decoder: &mut EntityDecoder<'_>,
        router: &GeometryRouter,
    ) -> Result<(), Box<RejectedCommonConstruction>> {
        if let Err(reason) = self.validate_intact(&work, decoder, router) {
            return Err(Box::new(RejectedCommonConstruction { reason, work }));
        }
        let permit = match self.resources.reserve_headers(&mut self.ledger, 1) {
            Ok(permit) => permit,
            Err(stop) => return Err(Box::new(RejectedCommonConstruction {
                reason: RetainedExecutionError::Stopped(stop), work,
            })),
        };
        // Backing already grew, even if a later gate rejects. Its account stays
        // owned beside the ledger; do not refund actual retained allocation.
        permit.retain();
        if let Err(reason) = self.state.validate_retained_resources(decoder, router) {
            return Err(Box::new(RejectedCommonConstruction {
                reason: self.resources.check().err().map(RetainedExecutionError::Stopped)
                    .unwrap_or_else(|| protocol(reason)),
                work,
            }));
        }
        if let Err(stop) = self.resources.check() {
            return Err(Box::new(RejectedCommonConstruction {
                reason: RetainedExecutionError::Stopped(stop), work,
            }));
        }
        if self
            .pending
            .as_ref()
            .expect("validated retained transaction")
            .stage
            .compare_exchange(DELIVERED, ACCEPTING, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(Box::new(RejectedCommonConstruction {
                reason: protocol("retained commit cancelled"),
                work,
            }));
        }
        // All checks precede the first take; capacity is already available.
        let pending = self
            .pending
            .as_mut()
            .expect("validated retained transaction");
        let reply = pending.reply.take().expect("unaccepted engine reply");
        if let Err(rejected) =
            self.state
                .accept_admission(reply, &self.context.borrowed(), decoder, router)
        {
            pending.reply = Some(rejected.reply);
            let _ = pending.stage.compare_exchange(
                ACCEPTING,
                DELIVERED,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
            return Err(Box::new(RejectedCommonConstruction {
                reason: protocol(rejected.error),
                work,
            }));
        }
        // A cancellation after commit admission still invalidates the entire
        // runtime/ledger; it must never be overwritten by an acceptance store.
        let _ = pending.stage.compare_exchange(
            ACCEPTING,
            ACCEPTED,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        self.ledger.push(DischargedValue {
            slot: pending.operation.value().slot(),
            receipt: work,
        });
        self.pending = None;
        Ok(())
    }
}
