// SPDX-License-Identifier: MPL-2.0
//! Crate-private construction facade over the same borrowed geometry program.
// Refs #7955: first cross-crate consumer.
// Keep this lint inside the module so oracle ownership follows the explicit path.
#![cfg_attr(any(not(test), not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))), allow(dead_code))]
use super::*;
use crate::program::retained::*;
use crate::program::retained::failure::{CompletionReason, FailureHandle, FailureSite, RetainedFailure};
#[path = "completion.rs"]
mod completion;

pub(crate) struct RetainedProgram<'a> {
    inner: GeometryProgram<'a>,
    cancelled: bool,
    unsupported: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RetainedTicket(ProgramRequest);
pub(crate) struct RetainedReply(ProgramReply);
pub(crate) struct RejectedRetainedReply {
    pub(crate) error: RetainedProgramError,
    pub(crate) reply: RetainedReply,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub(crate) enum RetainedProgramError {
    Stopped(crate::resource::ProgramStop),
    Unsupported,
    WrongPayload,
    WrongOwner,
    Outstanding,
    StaleRequest,
    AlreadyExecuted,
    NotExecuted,
    Cancelled,
}
impl From<ProgramError> for RetainedProgramError {
    fn from(error: ProgramError) -> Self {
        match error {
            ProgramError::UnsupportedRetained => Self::Unsupported,
            ProgramError::WrongPayload => Self::WrongPayload,
            ProgramError::WrongOwner => Self::WrongOwner,
            ProgramError::Outstanding => Self::Outstanding,
            ProgramError::StaleRequest => Self::StaleRequest,
            ProgramError::AlreadyExecuted => Self::AlreadyExecuted,
            ProgramError::NotExecuted => Self::NotExecuted,
        }
    }
}
impl<'a> RetainedProgram<'a> {
    pub(crate) fn product_parts(element: &'a DecodedEntity, contract: RetainedContract) -> Self {
        RetainedTraversal::new(contract).product_parts(element)
    }
    pub(crate) fn product_submeshes(element: &'a DecodedEntity, allow_instancing: bool,
        textures: Option<&'a rustc_hash::FxHashMap<u32, crate::ResolvedTextureMap>>, contract: RetainedContract) -> Self {
        RetainedTraversal::new(contract).product_submeshes(element,allow_instancing,textures)
    }
    pub(crate) fn type_map(rep_map: DecodedEntity,
        textures: Option<&'a rustc_hash::FxHashMap<u32, crate::ResolvedTextureMap>>, contract: RetainedContract) -> Self {
        RetainedTraversal::new(contract).type_map(rep_map,textures)
    }
    fn selection(&self) -> Option<&RetainedSelection> {
        match &self.inner.control {
            Control::Product(control) => control.retained_selection(),
            Control::Mapping(control) => control.retained_selection(),
            _ => None,
        }
    }
    fn check(&self) -> std::result::Result<(), RetainedProgramError> {
        crate::resource::check_current().map_err(|stop| RetainedProgramError::Stopped(
            self.selection().map_or(stop, |selection| selection.remember_stop(stop))))?;
        if let Some(selection) = self.selection() {
            selection.check().map_err(RetainedProgramError::Stopped)?;
        }
        if self.unsupported {
            return Err(RetainedProgramError::Unsupported);
        }
        if self.cancelled {
            return Err(RetainedProgramError::Cancelled);
        }
        Ok(())
    }
    pub(crate) fn request(&mut self) -> std::result::Result<Option<RetainedTicket>, RetainedProgramError> {
        self.check()?;
        self.inner
            .request()
            .map(|r| r.map(RetainedTicket))
            .map_err(Into::into)
    }
    pub(crate) fn admit(&mut self, ticket: RetainedTicket, router: &GeometryRouter, decoder: &mut EntityDecoder)
        -> std::result::Result<(RetainedReply, Vec<RetainedPlanOperation>), RetainedProgramError> {
        let result = self.admit_checked(ticket, router, decoder);
        if let Err(RetainedProgramError::Stopped(stop)) = &result {
            if let Some(selection) = self.selection() { selection.remember_stop(*stop); }
        }
        // Source/placement work can return an owned reply containing a stop.
        // Latch it before scope exit without discarding that reply or its ticket.
        if result.is_ok() {
            if let Err(stop) = crate::resource::check_current() {
                if let Some(selection) = self.selection() { selection.remember_stop(stop); }
            }
        }
        result
    }
    fn admit_checked(
        &mut self,
        ticket: RetainedTicket,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder,
    ) -> std::result::Result<(RetainedReply, Vec<RetainedPlanOperation>), RetainedProgramError>
    {
        self.check()?;
        self.inner.validate_owner(router, Some(decoder))?;
        match self.inner.pending {
            Some((request, false)) if request == ticket.0 => {}
            Some((request, true)) if request == ticket.0 => return Err(RetainedProgramError::AlreadyExecuted),
            _ => return Err(RetainedProgramError::StaleRequest),
        }
        if let Some(selection) = self.selection() {
            selection.validate_owner(decoder,router).map_err(|error| match error {
                Error::ProgramStopped(stop) => RetainedProgramError::Stopped(stop),
                _ => RetainedProgramError::WrongOwner,
            })?;
            selection.charge().map_err(RetainedProgramError::Stopped)?;
        }
        let retained = match &self.inner.control {
            Control::Product(control) => control.retained_ready(),
            Control::Mapping(control) => control.retained_ready(),
            _ => false,
        };
        if !retained {
            let reply = self.inner.execute(ticket.0, router, decoder)?;
            // Keep the reply even if source work stopped. accept rechecks the
            // stop and returns that reply intact; no executed step is lost.
            return Ok((RetainedReply(reply), Vec::new()));
        }
        self.inner.validate_owner(router, Some(decoder))?;
        match self.inner.pending {
            Some((request, false)) if request == ticket.0 => {}
            Some((request, true)) if request == ticket.0 => {
                return Err(RetainedProgramError::AlreadyExecuted)
            }
            _ => return Err(RetainedProgramError::StaleRequest),
        }
        let (value, operations) = match &mut self.inner.control {
            Control::Product(control) => {
                let (reply, operation) = control.admit_retained()?;
                (ReplyValue::Product(reply), operation)
            }
            Control::Mapping(control) => {
                let (reply, operation) = control.admit_retained()?;
                (ReplyValue::Mapping(reply), operation)
            }
            _ => return Err(RetainedProgramError::WrongPayload),
        };
        self.inner.pending = Some((ticket.0, true));
        self.inner.expected_payload = Some(value.tag());
        Ok((
            RetainedReply(ProgramReply {
                request: ticket.0,
                value,
            }),
            operations,
        ))
    }
    pub(crate) fn validate_ticket(
        &self,
        ticket: RetainedTicket,
    ) -> std::result::Result<(), RetainedProgramError> {
        self.check()?;
        if self
            .inner
            .pending
            .is_none_or(|(pending, _)| pending != ticket.0)
        {
            return Err(RetainedProgramError::StaleRequest);
        }
        Ok(())
    }
    pub(crate) fn validate_reply(
        &self,
        reply: &RetainedReply,
        router: &GeometryRouter,
    ) -> std::result::Result<(), RetainedProgramError> {
        self.check()?;
        self.inner
            .validate_reply(&reply.0, router)
            .map_err(Into::into)
    }
    pub(crate) fn accept(
        &mut self,
        reply: RetainedReply,
        router: &GeometryRouter,
    ) -> std::result::Result<(), Box<RejectedRetainedReply>> {
        if let Err(error) = self.validate_reply(&reply, router) {
            return Err(Box::new(RejectedRetainedReply { error, reply }));
        }
        self.inner.accept(reply.0, router).map_err(|r| {
            Box::new(RejectedRetainedReply {
                error: r.error.into(),
                reply: RetainedReply(r.reply),
            })
        })?;
        // Accept-side reduction can allocate after consuming the reply. Retain
        // its stop before the account scope ends, but never return that consumed
        // reply as reusable. Subsequent requests and finish report the stop.
        if let Err(stop) = crate::resource::check_current() {
            if let Some(selection) = self.selection() { selection.remember_stop(stop); }
        }
        Ok(())
    }
    pub(crate) fn cancel(&mut self) {
        self.cancelled = true;
    }
    /// Latch a stop the caller hit after a successful admit (its own
    /// allocation or check), so request and finish report it, not an
    /// unaccepted reply, after the account scope ends.
    #[cfg(feature = "retained-runtime")]
    pub(crate) fn remember_stop(&self, stop: crate::resource::ProgramStop) {
        if let Some(selection) = self.selection() { selection.remember_stop(stop); }
    }

}

#[cfg(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture", feature = "retained-runtime")))]
#[path = "tests.rs"]
mod tests;

/// One source/configuration domain and finite work allowance across all roots
/// of a product traversal. Clones share bounds and execution-owner checks;
/// completed definitions and presentation bindings are cached within each root.
/// This owns no numerical receipt or source decoder and grants no SDK authority.
#[derive(Clone)]
pub(crate) struct RetainedTraversal { selection: Option<RetainedSelection> }
impl RetainedTraversal {
    pub(crate) fn new(contract: RetainedContract) -> Self {
        Self { selection: RetainedSelection::new(contract,next_program_id()) }
    }
    pub(crate) fn product_parts<'a>(&self, element: &'a DecodedEntity) -> RetainedProgram<'a> {
        let id = next_program_id();
        let selection = self.selection.as_ref().map(RetainedSelection::for_root);
        let unsupported = selection.is_none();
        let control = match selection {
            Some(selection) => ProductControl::retained(element, selection),
            None => {
                ProductControl::merged(element, crate::router::processing::SourceHygiene::IndexOnly)
            }
        };
        let mut inner = GeometryProgram::with_control(Control::Product(control));
        inner.id = id;
        RetainedProgram { inner, cancelled: false, unsupported }
    }
    pub(crate) fn product_submeshes<'a>(&self, element: &'a DecodedEntity, allow_instancing: bool,
        textures: Option<&'a rustc_hash::FxHashMap<u32, crate::ResolvedTextureMap>>) -> RetainedProgram<'a> {
        let mut program = self.product_parts(element);
        if let Control::Product(control) = &mut program.inner.control {
            control.select_retained_styled(allow_instancing, textures);
        }
        program
    }
    pub(crate) fn type_map<'a>(&self, rep_map: DecodedEntity,
        textures: Option<&'a rustc_hash::FxHashMap<u32, crate::ResolvedTextureMap>>) -> RetainedProgram<'a> {
        let id = next_program_id();
        let selection = self.selection.as_ref().map(RetainedSelection::for_root);
        let unsupported = selection.is_none();
        let control = match selection {
            Some(selection) => crate::program::mapping::MappingControl::retained_type_map(rep_map,textures,selection),
            None => {
                // Default wasm has no retained selection. Keep this root inert
                // without borrowing a temporary or constructing numerical authority.
                crate::program::mapping::MappingControl::occurrence(
                    crate::program::mapping::Reached::Nested(rep_map))
            }
        };
        let mut inner = GeometryProgram::with_control(Control::Mapping(control));
        inner.id = id;
        RetainedProgram { inner, cancelled: false, unsupported }
    }
 }

#[cfg(all(test, target_arch = "wasm32", not(any(feature = "wasm_source_capture", feature = "retained-runtime"))))]
mod unavailable_tests {
    use super::*;

    #[test]
    fn absent_capture_capability_is_unsupported_not_cancelled() {
        // #7955 F6: no exact fallback can issue work in the default WASM facade.
        let mut decoder = EntityDecoder::new("#1=IFCWALL('w',$,$,$,$,$,$,$,$);");
        let entity = decoder.decode_by_id(1).unwrap();
        let mut program = RetainedProgram::product_parts(&entity, RetainedContract {
            source_epoch: 1, source_revision: 1,
        });
        assert_eq!(program.request().err(), Some(RetainedProgramError::Unsupported));
        assert!(program.inner.pending.is_none());
    }
}
