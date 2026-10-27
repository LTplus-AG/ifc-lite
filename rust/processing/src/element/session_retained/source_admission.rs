// SPDX-License-Identifier: MPL-2.0
//! Advance the actual common controller before acquiring a numerical worker.
//! A reached source refusal requires no SDK process and grants no receipt.
use super::*;
pub(super) struct SourceAdmission {
    pub(super) outer: WorkRequest,
    pub(super) ticket: RetainedTicket,
    pub(super) stamp: OwnerStamp,
    pub(super) reply: RetainedReply,
    pub(super) operations: Vec<RetainedPlanOperation>,
    pub(super) _storage: Reservation,
}
impl<R: NumericalReceipt> RuntimeProductExecution<'_, R> {
    pub(super) fn advance_source(&mut self, decoder: &mut EntityDecoder, router: &GeometryRouter)
        -> Result<bool, RetainedExecutionError> {
        let result = self.advance_source_checked(decoder, router);
        let result = check_resources(&self.resources).and(result);
        if result.as_ref().is_err_and(|error| error.terminal()) { self.cancel(); }
        result
    }
    fn advance_source_checked(&mut self, decoder: &mut EntityDecoder, router: &GeometryRouter)
        -> Result<bool, RetainedExecutionError> {
        self.validate(decoder, router)?;
        if self.pending.is_some() { return Err(protocol(ReceiptFailure::OutstandingConstruction)); }
        if self.prepared.is_some() { return Ok(true); }
        loop {
            if self.plan.is_some() {
                return Ok(false);
            }
            let outer = self.outer.ok_or_else(|| protocol(ReceiptFailure::MissingOuterRequest))?;
            self.state
                .protocol
                .before_execute(outer)
                .map_err(protocol)?;
            let resources = self.resources.clone();
            let program = self
                .program
                .as_mut()
                .ok_or_else(|| protocol(ReceiptFailure::MissingProgram))?;
            let ((ticket, admission), stamp) = resources
                .with_scope(|| {
                    self.owner.work(decoder, router, |d, r| {
                        self.scopes.with_scope(|| {
                            let ticket = program.request().map_err(common)?;
                            let admission = ticket
                                .map(|ticket| program.admit(ticket, r, d).map_err(common))
                                .transpose()?;
                            Ok::<_, RetainedExecutionError>((ticket, admission))
                        })
                    })
                })
                .map_err(protocol)
                .and_then(|(result, stamp)| {
                    result.map(|(ticket, admission)| ((ticket, admission), stamp))
                })?;
            check_resources(&resources)?;
            self.context.validate_decoder(decoder).map_err(RetainedExecutionError::Source)?;
            let Some(ticket) = ticket else {
                self.finish_current_program(outer)?;
                if self.plan.is_none() { self.start_next_program(decoder,router)?; }
                continue;
            };
            let (reply, operations, _admission_storage) = admission.ok_or_else(|| protocol(ReceiptFailure::MissingAdmission))?;
            if operations.is_empty() {
                resources
                    .with_scope(|| {
                        self.owner.work(decoder, router, |_, r| {
                            self.scopes.with_scope(|| {
                                program.accept(reply, r).map_err(|e| common(e.error))
                            })
                        })
                    })
                    .map_err(protocol)?
                    .0?;
                check_resources(&resources)?;
                self.context.validate_decoder(decoder).map_err(RetainedExecutionError::Source)?;
                continue;
            }
            self.prepared = Some(SourceAdmission { outer, ticket, stamp, reply, operations,
                _storage: _admission_storage });
            return Ok(true);
        }
    }
}
