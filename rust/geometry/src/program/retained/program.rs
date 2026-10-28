// SPDX-License-Identifier: MPL-2.0
// With retained execution off, the sum types deliberately contain only Geometry.
#![cfg_attr(not(any(test, feature = "retained-runtime")), allow(irrefutable_let_patterns, unreachable_patterns))]
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
    inner: RetainedInner<'a>,
    cancelled: bool,
    unsupported: bool,
}
enum RetainedInner<'a> {
    Geometry(GeometryProgram<'a>),
    // Default unit tests exercise geometry programs; cuts enter only through
    // the retained-runtime facade and its feature-gated integration witnesses.
    #[cfg_attr(not(feature = "retained-runtime"), allow(dead_code))]
    #[cfg(any(test, feature = "retained-runtime"))]
    Cuts(Box<openings::OpeningCuts>),
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RetainedTicket {
    Geometry(ProgramRequest),
    #[cfg(any(test, feature = "retained-runtime"))]
    Cut { program: u64, seq: u64 },
}
pub(crate) enum RetainedReply {
    Geometry(ProgramReply),
    #[cfg(any(test, feature = "retained-runtime"))]
    Cut { program: u64, seq: u64 },
}
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
    #[cfg(any(test, feature = "retained-runtime"))]
    OpeningConsumed { opening: u32 },
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
    #[cfg(any(test, feature = "retained-runtime"))]
    fn selection(&self) -> Option<&RetainedSelection> {
        let RetainedInner::Geometry(inner) = &self.inner else {
            let RetainedInner::Cuts(cuts) = &self.inner else { return None; };
            return Some(&cuts.selection);
        };
        match &inner.control {
            Control::Product(control) => control.retained_selection(),
            Control::Mapping(control) => control.retained_selection(),
            _ => None,
        }
    }
    #[cfg(not(any(test, feature = "retained-runtime")))]
    fn selection(&self) -> Option<&RetainedSelection> {
        let RetainedInner::Geometry(inner) = &self.inner;
        match &inner.control {
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
        match &mut self.inner {
            RetainedInner::Geometry(inner) => inner.request().map(|r| r.map(RetainedTicket::Geometry)).map_err(Into::into),
            #[cfg(any(test, feature = "retained-runtime"))]
            RetainedInner::Cuts(cuts) => cuts.request().map(|r| r.map(|seq| RetainedTicket::Cut { program: cuts.id, seq })),
        }
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
        #[cfg(any(test, feature = "retained-runtime"))]
        if let RetainedInner::Cuts(cuts) = &mut self.inner {
            let RetainedTicket::Cut { program, seq } = ticket else { return Err(RetainedProgramError::StaleRequest); };
            let operations = cuts.admit(program, seq, router, decoder)?;
            return Ok((RetainedReply::Cut { program, seq }, operations));
        }
        if let RetainedInner::Geometry(inner) = &self.inner {
            let RetainedTicket::Geometry(ticket) = ticket else { return Err(RetainedProgramError::StaleRequest); };
            inner.validate_owner(router, Some(decoder))?;
            match inner.pending {
                Some((request, false)) if request == ticket => {},
                Some((request, true)) if request == ticket => return Err(RetainedProgramError::AlreadyExecuted),
                _ => return Err(RetainedProgramError::StaleRequest),
            }
        }
        if let Some(selection) = self.selection() {
            selection.validate_owner(decoder,router).map_err(|error| match error {
                Error::ProgramStopped(stop) => RetainedProgramError::Stopped(stop),
                _ => RetainedProgramError::WrongOwner,
            })?;
            selection.charge().map_err(RetainedProgramError::Stopped)?;
        }
        let RetainedInner::Geometry(inner) = &mut self.inner else { return Err(RetainedProgramError::WrongPayload); };
        let RetainedTicket::Geometry(ticket) = ticket else { return Err(RetainedProgramError::StaleRequest); };
        inner.validate_owner(router, Some(decoder))?;
        match inner.pending {
            Some((request, false)) if request == ticket => {}
            Some((request, true)) if request == ticket => return Err(RetainedProgramError::AlreadyExecuted),
            _ => return Err(RetainedProgramError::StaleRequest),
        }
        let retained = match &inner.control {
            Control::Product(control) => control.retained_ready(),
            Control::Mapping(control) => control.retained_ready(),
            _ => false,
        };
        if !retained {
            let reply = inner.execute(ticket, router, decoder)?;
            // Keep the reply even if source work stopped. accept rechecks the
            // stop and returns that reply intact; no executed step is lost.
            return Ok((RetainedReply::Geometry(reply), Vec::new()));
        }
        inner.validate_owner(router, Some(decoder))?;
        match inner.pending {
            Some((request, false)) if request == ticket => {}
            Some((request, true)) if request == ticket => {
                return Err(RetainedProgramError::AlreadyExecuted)
            }
            _ => return Err(RetainedProgramError::StaleRequest),
        }
        let (value, operations) = match &mut inner.control {
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
        inner.pending = Some((ticket, true));
        inner.expected_payload = Some(value.tag());
        Ok((
            RetainedReply::Geometry(ProgramReply {
                request: ticket,
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
        match (&self.inner, ticket) {
            (RetainedInner::Geometry(inner), RetainedTicket::Geometry(ticket))
                if inner.pending.is_some_and(|(pending, _)| pending == ticket) => Ok(()),
            #[cfg(any(test, feature = "retained-runtime"))]
            (RetainedInner::Cuts(cuts), RetainedTicket::Cut { program, seq }) => cuts.validate_ticket(program, seq),
            _ => Err(RetainedProgramError::StaleRequest),
        }
    }
    pub(crate) fn validate_reply(&self, reply: &RetainedReply, router: &GeometryRouter)
        -> std::result::Result<(), RetainedProgramError> {
        self.check()?;
        match (&self.inner, reply) {
            (RetainedInner::Geometry(inner), RetainedReply::Geometry(reply)) => inner.validate_reply(reply, router).map_err(Into::into),
            #[cfg(any(test, feature = "retained-runtime"))]
            (RetainedInner::Cuts(cuts), RetainedReply::Cut { program, seq }) => cuts.validate_reply(*program, *seq, router),
            _ => Err(RetainedProgramError::WrongPayload),
        }
    }
    pub(crate) fn accept(&mut self, reply: RetainedReply, router: &GeometryRouter)
        -> std::result::Result<(), Box<RejectedRetainedReply>> {
        if let Err(error) = self.validate_reply(&reply, router) {
            return Err(Box::new(RejectedRetainedReply { error, reply }));
        }
        match (&mut self.inner, reply) {
            (RetainedInner::Geometry(inner), RetainedReply::Geometry(reply)) => {
                inner.accept(reply, router).map_err(|r| Box::new(RejectedRetainedReply {
                    error: r.error.into(), reply: RetainedReply::Geometry(r.reply),
                }))?;
            }
            #[cfg(any(test, feature = "retained-runtime"))]
            (RetainedInner::Cuts(cuts), reply @ RetainedReply::Cut { .. }) => {
                if let Err(error) = cuts.accept() { return Err(Box::new(RejectedRetainedReply { error, reply })); }
            }
            (_, reply) => return Err(Box::new(RejectedRetainedReply { error: RetainedProgramError::WrongPayload, reply })),
        }
        if let Err(stop) = crate::resource::check_current() {
            if let Some(selection) = self.selection() { selection.remember_stop(stop); }
        }
        Ok(())
    }
    pub(crate) fn cancel(&mut self) {
        self.cancelled = true;
        #[cfg(any(test, feature = "retained-runtime"))]
        if let RetainedInner::Cuts(cuts) = &self.inner { cuts.selection.remember_stop(crate::resource::ProgramStop::Cancelled); }
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
    #[cfg(feature = "retained-runtime")]
    pub(crate) fn opening_cuts(&self, host: RetainedProductPlan, cutters: Vec<(u32, RetainedProductPlan)>)
        -> std::result::Result<RetainedProgram<'static>, RetainedFailure> {
        let selection = self.selection.as_ref().ok_or(RetainedProgramError::Unsupported)?.for_root();
        crate::resource::charge(crate::resource::Cost {
            live_bytes: std::mem::size_of::<openings::OpeningCuts>() as u64, ..Default::default()
        }).map_err(RetainedFailure::Stopped)?.retain();
        let cuts = openings::OpeningCuts::new(selection, next_program_id(), host, cutters)?;
        Ok(RetainedProgram { inner: RetainedInner::Cuts(Box::new(cuts)), cancelled: false, unsupported: false })
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
        RetainedProgram { inner: RetainedInner::Geometry(inner), cancelled: false, unsupported }
    }
    pub(crate) fn product_submeshes<'a>(&self, element: &'a DecodedEntity, allow_instancing: bool,
        textures: Option<&'a rustc_hash::FxHashMap<u32, crate::ResolvedTextureMap>>) -> RetainedProgram<'a> {
        let mut program = self.product_parts(element);
        if let RetainedInner::Geometry(inner) = &mut program.inner {
        if let Control::Product(control) = &mut inner.control {
            control.select_retained_styled(allow_instancing, textures);
        }
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
        RetainedProgram { inner: RetainedInner::Geometry(inner), cancelled: false, unsupported }
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
        assert!(matches!(&program.inner, RetainedInner::Geometry(inner) if inner.pending.is_none()));
    }
}

#[cfg(test)]
impl<'a> RetainedProgram<'a> {
    fn geometry_mut(&mut self) -> &mut GeometryProgram<'a> {
        match &mut self.inner { RetainedInner::Geometry(inner) => inner, _ => panic!("geometry test program") }
    }
    fn geometry_ref(&self) -> &GeometryProgram<'a> {
        match &self.inner { RetainedInner::Geometry(inner) => inner, _ => panic!("geometry test program") }
    }
    fn into_geometry(self) -> GeometryProgram<'a> {
        match self.inner { RetainedInner::Geometry(inner) => inner, _ => panic!("geometry test program") }
    }
}
#[cfg(test)]
impl RetainedTicket {
    fn geometry_request(self) -> ProgramRequest {
        match self { Self::Geometry(request) => request, _ => panic!("geometry test ticket") }
    }
}

#[cfg(test)]
impl RetainedReply {
    fn geometry_reply(&self) -> &ProgramReply {
        match self { Self::Geometry(reply) => reply, _ => panic!("geometry test reply") }
    }
}

#[cfg(all(test, feature = "retained-runtime"))]
#[path = "m3_exact_tests.rs"]
mod m3_exact_tests;
