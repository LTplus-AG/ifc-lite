// SPDX-License-Identifier: MPL-2.0
//! Ordered part × opening × cutter Differences. Never groups or skips a cut.
use super::*;
use super::failure::{CompletionReason, FailureSite, RetainedFailure};
use crate::program::inner::retained_program::RetainedProgramError as Protocol;
use ifc_lite_core::execution_owner::ExecutionIdentity;

pub(crate) struct OpeningCuts {
    pub(crate) selection: RetainedSelection,
    pub(crate) id: u64,
    host: RetainedProductPlan,
    cutters: Vec<(u32, Vec<LogicalRetainedValue>)>,
    cursor: (usize, usize, usize),
    pending: Option<(u64, bool, Option<LogicalRetainedValue>)>,
    seq: u64,
    router: Option<ExecutionIdentity>,
    consumed: Vec<bool>,
    cuts: u64,
    failure: Option<RetainedFailure>,
}
impl OpeningCuts {
    #[cfg(feature = "retained-runtime")]
    pub(crate) fn new(selection: RetainedSelection, id: u64, host: RetainedProductPlan,
        cutters: Vec<(u32, RetainedProductPlan)>) -> Result<Self, RetainedFailure> {
        let handle = selection.failure_handle();
        let build = || -> crate::Result<Self> {
            if host.values.is_empty() { return Err(crate::Error::geometry("empty opening host")); }
            let mut values = Vec::new();
            crate::resource::reserve_headers(&mut values, cutters.len())?.retain();
            for (opening, plan) in cutters {
                if plan.values.is_empty() { return Err(crate::Error::geometry("empty opening body")); }
                values.push((opening, plan.values));
            }
            // Plans from another traversal cannot become cut inputs, even if
            // their source bytes happen to match this product's source.
            for value in host.values.iter().chain(values.iter().flat_map(|(_, v)| v)) {
                if value.slot.program != selection.program() {
                    return Err(value_error::ValueReason::OperationProgram.into_common(
                        &handle, FailureSite::OpeningCut, None));
                }
            }
            let mut consumed = Vec::new();
            crate::resource::reserve_headers(&mut consumed, host.values.len())?.retain();
            consumed.resize(host.values.len(), false);
            Ok(Self { selection, id, host, cutters: values, cursor: (0, 0, 0), pending: None,
                seq: 0, router: None, consumed, cuts: 0, failure: None })
        };
        build().map_err(|e| handle.common(FailureSite::OpeningCut, e))
    }
    pub(crate) fn request(&mut self) -> Result<Option<u64>, Protocol> {
        if self.pending.is_some() { return Err(Protocol::Outstanding); }
        if self.failure.is_some() || self.cursor.0 == self.host.values.len() || self.cutters.is_empty() {
            return Ok(None);
        }
        self.seq = self.seq.checked_add(1).ok_or(Protocol::Unsupported)?;
        self.pending = Some((self.seq, false, None));
        Ok(Some(self.seq))
    }
    pub(crate) fn validate_ticket(&self, id: u64, seq: u64) -> Result<(), Protocol> {
        if id != self.id || self.pending.as_ref().is_none_or(|p| p.0 != seq) {
            return Err(Protocol::StaleRequest);
        }
        Ok(())
    }
    pub(crate) fn admit(&mut self, id: u64, seq: u64, router: &crate::GeometryRouter,
        decoder: &ifc_lite_core::EntityDecoder) -> Result<Vec<RetainedPlanOperation>, Protocol> {
        self.validate_ticket(id, seq)?;
        if self.pending.as_ref().is_some_and(|p| p.1) { return Err(Protocol::AlreadyExecuted); }
        self.selection.validate_owner(decoder, router).map_err(|e| match e {
            crate::Error::ProgramStopped(stop) => Protocol::Stopped(stop), _ => Protocol::WrongOwner,
        })?;
        self.router = Some(router.execution_identity());
        self.selection.charge().map_err(Protocol::Stopped)?;
        let mut operations = Vec::new();
        let result = self.next().and_then(|operation| {
            crate::resource::reserve_headers(&mut operations, 1)? .retain();
            let value = operation.value.try_copy()?;
            operations.push(operation);
            Ok(value)
        });
        let value = match result {
            Ok(value) => Some(value),
            Err(error) => {
                self.failure = Some(self.selection.failure_handle().common(FailureSite::OpeningCut, error));
                None
            }
        };
        self.pending = Some((seq, true, value));
        Ok(operations)
    }
    fn next(&self) -> crate::Result<RetainedPlanOperation> {
        let (part, opening, cutter) = self.cursor;
        let (id, cutters) = self.cutters.get(opening).ok_or_else(|| crate::Error::geometry("missing opening"))?;
        let host = self.host.values.get(part).ok_or_else(|| crate::Error::geometry("missing host part"))?;
        let cutter_value = cutters.get(cutter).ok_or_else(|| crate::Error::geometry("missing cutter"))?;
        let mut operation = boolean::opening_difference(host.try_copy()?, cutter_value.try_copy()?,
            &self.selection.failure_handle(), *id)?;
        operation.opening = Some((*id, opening, cutter));
        Ok(operation)
    }
    pub(crate) fn validate_reply(&self, id: u64, seq: u64, router: &crate::GeometryRouter)
        -> Result<(), Protocol> {
        self.validate_ticket(id, seq)?;
        if self.router != Some(router.execution_identity()) { return Err(Protocol::WrongOwner); }
        if self.pending.as_ref().is_none_or(|p| !p.1) { return Err(Protocol::NotExecuted); }
        Ok(())
    }
    pub(crate) fn accept(&mut self) -> Result<(), Protocol> {
        if self.pending.as_ref().and_then(|p| p.2.as_ref()).is_some_and(|v| v.evaluated_empty().is_none()) {
            return Err(Protocol::NotExecuted);
        }
        let Some((_, _, Some(value))) = self.pending.take() else { return Ok(()); };
        let (part, opening, cutter) = self.cursor;
        self.cuts += 1;
        if value.evaluated_empty() == Some(true) {
            self.consumed[part] = true;
            let opening = self.cutters[opening].0;
            self.failure = Some(RetainedFailure::Completion(CompletionReason::OpeningConsumed { opening }));
            return Err(Protocol::OpeningConsumed { opening });
        }
        self.host.values[part] = value;
        if cutter + 1 < self.cutters[opening].1.len() {
            self.cursor.2 += 1;
        } else if opening + 1 < self.cutters.len() {
            self.cursor = (part, opening + 1, 0);
        } else {
            self.cursor = (part + 1, 0, 0);
        }
        Ok(())
    }
    pub(crate) fn finish(mut self) -> Result<RetainedProductPlan, RetainedFailure> {
        if let Some(error) = self.failure.take() { return Err(error); }
        if let Some((_, executed, _)) = self.pending {
            return Err(RetainedFailure::Completion(if executed { CompletionReason::UnacceptedReply }
                else { CompletionReason::UnexecutedRequest }));
        }
        if self.cursor.0 < self.host.values.len() && !self.cutters.is_empty() {
            return Err(RetainedFailure::Completion(CompletionReason::Incomplete));
        }
        self.host.remaining.retain(|r| *r != RetainedRequirement::OpeningClosure);
        self.host.opening = Some(OpeningCompletion { related: self.cutters.len(), cuts: self.cuts,
            consumed: self.consumed.iter().filter(|&&v| v).count() });
        Ok(self.host)
    }
}
