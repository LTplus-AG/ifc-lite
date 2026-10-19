// SPDX-License-Identifier: MPL-2.0
//! Intact original transaction/receipt validation before any linear take.
use super::*;
use super::value::RealizationKind;
type InputBinding<'a> = (&'a ifc_lite_geometry::program::LogicalRetainedValue,&'a Arc<CommonRetainedRealization>);
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
        if pending.operations.len() != work.realizations.len() {
            return Err(protocol("retained operation result count mismatch"));
        }
        for (index, (operation, realization)) in pending.operations.iter().zip(&work.realizations).enumerate() {
            realization.validate_live().map_err(protocol)?;
            let live = realization.owner().incarnation().unwrap_or(0);
            if live == 0 || live != pending.cancellation.owner.incarnation().unwrap_or(0) {
                return Err(protocol("retained runtime owner mismatch"));
            }
            operation.validate(realization, live)?;
            for (value,input) in operation.inputs().into_iter().flatten() {
                self.resources.with_scope(|| ifc_lite_geometry::resource::charge(ifc_lite_geometry::resource::Cost {
                    work:self.ledger.len() as u64,..Default::default() }))
                    .map_err(RetainedExecutionError::Stopped)?.retain();
                if !self.ledger.iter().any(|entry| entry.operation.value().definition()==value.definition()
                    && Arc::ptr_eq(&entry.receipt,input)) {
                    return Err(protocol("retained logical input identity mismatch"));
                }
            }
            let definition = operation.expected().value().definition();
            if self.ledger.iter().any(|entry| entry.operation.value().definition() == definition)
                || pending.operations[..index].iter().any(|prior| prior.expected().value().definition() == definition) {
                return Err(protocol("retained duplicate output identity"));
            }
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
        let permit = match self.resources.reserve_headers(&mut self.ledger, work.realizations.len()) {
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
        // Actual semantic Empty classification resumes the original common step.
        // Validate every binding before taking the linear reply or publishing a value.
        let pending=self.pending.as_mut().expect("validated retained transaction");
        for (operation,realization) in pending.operations.iter().zip(&work.realizations) {
            let RealizationKind::Boolean(value)=realization.kind() else {continue};
            if let Err(error)=pending.reply.as_mut().expect("original common reply")
                .bind_retained_outcome(operation.expected().value().slot(),value.is_empty()) {
                let reason=match self.resources.check() {
                    Err(stop)=>RetainedExecutionError::Stopped(stop),
                    Ok(())=>match error {
                        ifc_lite_geometry::Error::ProgramStopped(stop)=>RetainedExecutionError::Stopped(stop),
                        other=>protocol(other),
                    },
                };
                return Err(Box::new(RejectedCommonConstruction {reason,work}));
            }
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
        let pending=self.pending.take().expect("accepted retained transaction");
        for (operation, receipt) in pending.operations.into_iter().zip(work.realizations) {
            self.ledger.push(DischargedValue {operation:operation.into_expected(),receipt});
        }
        Ok(())
    }
}

impl PendingRetainedOperation {
    fn inputs(&self) -> [Option<InputBinding<'_>>;2] {
        use ifc_lite_geometry::program::RetainedOperationKind;
        match self {
            Self::Construction {..}=>[None,None],
            Self::Affine {expected,input,..}=>match expected.kind() {
                RetainedOperationKind::Affine {input:value,..}=>[Some((value,input)),None],_=>[None,None],
            },
            Self::Boolean {expected,inputs}=>match expected.kind() {
                RetainedOperationKind::Boolean {inputs:values,..}=>[Some((&values[0],&inputs[0])),Some((&values[1],&inputs[1]))],_=>[None,None],
            },
        }
    }
    fn validate(&self, realization: &CommonRetainedRealization, live: u64)
        -> Result<(), RetainedExecutionError> {
        use ifc_lite_geometry::program::RetainedOperationKind;
        if !matches!(self,Self::Construction {..})
            && self.expected().value().definition() != &ifc_lite_geometry::program::LogicalRetainedDefinition::Operation(self.expected().value().slot()) {
            return Err(protocol("retained operation output identity mismatch"));
        }
        match (self, realization.kind()) {
            (Self::Construction {expected,request,document}, RealizationKind::Construction(value)) => {
                let completion = value.completion();
                if !request.same_admission(completion.request()) {
                    return Err(protocol("retained construction admission mismatch"));
                }
                document.validate_retained_completion(completion, live).map_err(protocol)?;
                if completion.source_from_evaluation != *expected.value().source_from_evaluation()
                    || completion.evaluation_from_source != *expected.value().evaluation_from_source() {
                    return Err(protocol("retained construction frame mismatch"));
                }
            }
            (Self::Affine {expected,input,matrix}, RealizationKind::Affine(value)) => {
                let RetainedOperationKind::Affine {input:logical,matrix:issued}=expected.kind() else {return Err(protocol("retained affine packet kind mismatch"))};
                if matrix != issued || matrix != logical.object_frame()
                    || expected.value().object_frame() != &ifc_lite_geometry::math::mat4::col_major_array(&nalgebra::Matrix4::identity()) {
                    return Err(protocol("retained affine logical frame mismatch"));
                }
                input.validate_live().map_err(protocol)?;
                if value.operation_identity().input != input.solid()
                    || value.operation_identity().column_major != *matrix {
                    return Err(protocol("retained affine input/matrix mismatch"));
                }
            }
            (Self::Boolean {expected,inputs}, RealizationKind::Boolean(value)) => {
                let RetainedOperationKind::Boolean {inputs:values,operation} = expected.kind() else {unreachable!()};
                for input in inputs {input.validate_live().map_err(protocol)?;}
                let identity = value.operation_identity();
                if identity.left != inputs[0].solid() || identity.right != inputs[1].solid()
                    || identity.operation != *operation
                    || identity.left_world_from_evaluation != *values[0].object_frame()
                    || identity.right_world_from_evaluation != *values[1].object_frame()
                    || value.world_from_evaluation() != expected.value().object_frame() {
                    return Err(protocol("retained Boolean ordered inputs/operation/frames mismatch"));
                }
            }
            _=>return Err(protocol("retained operation kind mismatch")),
        }
        Ok(())
    }
}
