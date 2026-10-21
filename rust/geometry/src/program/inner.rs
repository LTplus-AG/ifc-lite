// SPDX-License-Identifier: MPL-2.0
//! Linear request/execute/accept protocol for one reached geometry occurrence.
//! Recipes live in the program, never in tickets: a copied request cannot
//! replay work, and a foreign router or decoder is refused before any recipe
//! is moved. Only the Item and Cache controllers exist so far.
use super::inner_cache::{CacheControl, CacheReply};
use super::item::{ItemControl, ItemStep};
use crate::{Error, GeometryRouter, Mesh, Result};
use ifc_lite_core::execution_owner::ExecutionIdentity;
use ifc_lite_core::{DecodedEntity, EntityDecoder};

/// Opaque continuation for a reached item occurrence. It borrows its source
/// occurrence and owns only the selected controller's state, inline.
pub(crate) struct GeometryProgram<'a> {
    id: u64,
    sequence: u64,
    /// The outstanding request and whether it has been executed.
    pending: Option<(ProgramRequest, bool)>,
    expected_router: Option<ExecutionIdentity>,
    expected_decoder: Option<ExecutionIdentity>,
    expected_payload: Option<Payload>,
    control: Control<'a>,
}

enum Control<'a> {
    Item(ItemControl<'a>),
    Cache(CacheControl<'a>),
}

/// Identity only. Copying this value cannot copy or replay its recipe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ProgramRequest {
    program: u64,
    sequence: u64,
    stage: ProgramStage,
}
impl ProgramRequest {
    #[cfg(test)]
    pub(crate) fn stage(self) -> ProgramStage {
        self.stage
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProgramStage {
    /// Source admission through the router's selected processor.
    Source,
    /// A selected processor's own mutable-decoder callback.
    Extension,
    /// Owned arithmetic that reads no source.
    Numerical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProgramError {
    WrongPayload,
    WrongOwner,
    Outstanding,
    StaleRequest,
    AlreadyExecuted,
    NotExecuted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Payload {
    Item,
    CacheBegin,
    CacheItem,
    CacheHash,
}

pub(crate) struct ProgramReply {
    request: ProgramRequest,
    value: ReplyValue,
}
enum ReplyValue {
    Item(ItemStep),
    Cache(CacheReply),
}
impl ReplyValue {
    fn tag(&self) -> Payload {
        match self {
            Self::Item(_) => Payload::Item,
            Self::Cache(CacheReply::Begin(_)) => Payload::CacheBegin,
            Self::Cache(CacheReply::Item(_)) => Payload::CacheItem,
            Self::Cache(CacheReply::Hash(..)) => Payload::CacheHash,
        }
    }
}

/// A reply refused by validation, handed back intact to its caller.
pub(crate) struct RejectedProgramReply {
    pub(crate) error: ProgramError,
    // The synchronous drain stops on any rejection; a caller interleaving
    // programs re-offers this reply to its actual owner.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) reply: ProgramReply,
}

impl<'a> GeometryProgram<'a> {
    /// The selected processor work for one item, without content-dedup.
    pub(crate) fn item(item: &'a DecodedEntity, offset_meters: (f64, f64, f64)) -> Self {
        Self::with_control(Control::Item(ItemControl::new(item, offset_meters)))
    }

    /// One representation item wrapped by the content-dedup and hash caches.
    pub(crate) fn representation_item(item: &'a DecodedEntity, offset_meters: (f64, f64, f64)) -> Self {
        Self::with_control(Control::Cache(CacheControl::new(item, offset_meters)))
    }

    fn with_control(control: Control<'a>) -> Self {
        Self {
            id: next_program_id(),
            sequence: 0,
            pending: None,
            expected_router: None,
            expected_decoder: None,
            expected_payload: None,
            control,
        }
    }

    /// Reduce owned control without borrowing source or router callbacks.
    pub(crate) fn request(&mut self) -> std::result::Result<Option<ProgramRequest>, ProgramError> {
        if self.pending.is_some() {
            return Err(ProgramError::Outstanding);
        }
        let stage = match &self.control {
            Control::Item(control) => control.stage()?,
            Control::Cache(control) => control.stage()?,
        };
        let Some(stage) = stage else { return Ok(None) };
        self.sequence = self.sequence.wrapping_add(1);
        let request = ProgramRequest { program: self.id, sequence: self.sequence, stage };
        self.pending = Some((request, false));
        Ok(Some(request))
    }

    fn validate_owner(&self, router: &GeometryRouter, decoder: Option<&EntityDecoder>)
        -> std::result::Result<(), ProgramError> {
        let foreign_decoder = decoder.is_some_and(|decoder| {
            self.expected_decoder.is_some_and(|owner| owner != decoder.execution_identity())
        });
        if foreign_decoder || self.expected_router.is_some_and(|owner| owner != router.execution_identity()) {
            return Err(ProgramError::WrongOwner);
        }
        Ok(())
    }

    pub(crate) fn execute(&mut self, request: ProgramRequest, router: &GeometryRouter,
        decoder: &mut EntityDecoder) -> std::result::Result<ProgramReply, ProgramError> {
        match self.pending {
            Some((pending, false)) if pending == request => {}
            Some((pending, true)) if pending == request => return Err(ProgramError::AlreadyExecuted),
            _ => return Err(ProgramError::StaleRequest),
        }
        // Owners are validated before the recipe is taken: a refused call
        // leaves the request executable by its actual router and decoder.
        self.validate_owner(router, Some(decoder))?;
        self.expected_router = Some(router.execution_identity());
        self.expected_decoder = Some(decoder.execution_identity());
        // Consume admission before any callback can unwind. A copied ticket
        // cannot replay work after its recipe was moved into a lexical call.
        self.pending = Some((request, true));
        let value = match &mut self.control {
            Control::Item(control) => ReplyValue::Item(control.execute(router, decoder)?),
            Control::Cache(control) => ReplyValue::Cache(control.execute(router, decoder)?),
        };
        self.expected_payload = Some(value.tag());
        Ok(ProgramReply { request, value })
    }

    fn validate_reply(&self, reply: &ProgramReply, router: &GeometryRouter)
        -> std::result::Result<(), ProgramError> {
        self.validate_owner(router, None)?;
        match self.pending {
            Some((pending, true)) if pending == reply.request => {
                if self.expected_payload == Some(reply.value.tag()) { Ok(()) } else { Err(ProgramError::WrongPayload) }
            }
            Some((pending, false)) if pending == reply.request => Err(ProgramError::NotExecuted),
            _ => Err(ProgramError::StaleRequest),
        }
    }

    /// Accept an executed reply. Validation precedes every effect, and a
    /// refused reply is returned so its actual owner can still accept it.
    pub(crate) fn accept(&mut self, reply: ProgramReply, router: &GeometryRouter)
        -> std::result::Result<(), Box<RejectedProgramReply>> {
        if let Err(error) = self.validate_reply(&reply, router) {
            return Err(Box::new(RejectedProgramReply { error, reply }));
        }
        let request = reply.request;
        match (&mut self.control, reply.value) {
            (Control::Item(control), ReplyValue::Item(step)) => control.accept(step, router),
            (Control::Cache(control), ReplyValue::Cache(reply)) => control.accept(reply, router),
            (_, value) => {
                let reply = ProgramReply { request, value };
                return Err(Box::new(RejectedProgramReply { error: ProgramError::WrongPayload, reply }));
            }
        }
        self.pending = None;
        self.expected_payload = None;
        Ok(())
    }

    /// The completed occurrence's mesh. An incomplete program is an error.
    pub(crate) fn finish(mut self) -> Result<Mesh> {
        let result = match &mut self.control {
            _ if self.pending.is_some() => None,
            Control::Item(control) => control.take_result(),
            Control::Cache(control) => control.take_result(),
        };
        result.unwrap_or_else(|| Err(Error::geometry("geometry program finished before completion")))
    }

    /// Run every request synchronously against one router and decoder.
    pub(crate) fn drain(mut self, router: &GeometryRouter, decoder: &mut EntityDecoder) -> Result<Mesh> {
        while let Some(request) = self.request().map_err(program_error)? {
            let reply = self.execute(request, router, decoder).map_err(program_error)?;
            self.accept(reply, router).map_err(|rejected| program_error(rejected.error))?;
        }
        self.finish()
    }
}

fn program_error(error: ProgramError) -> Error {
    Error::geometry(format!("geometry program protocol: {error:?}"))
}

/// Process-unique program identity without a shared atomic per item: each
/// thread reserves a block of identities and hands them out locally.
fn next_program_id() -> u64 {
    use std::cell::Cell;
    use std::sync::atomic::{AtomicU64, Ordering};
    const BLOCK: u64 = 1 << 20;
    static NEXT_BLOCK: AtomicU64 = AtomicU64::new(1);
    thread_local! {
        static RANGE: Cell<(u64, u64)> = const { Cell::new((0, 0)) };
    }
    RANGE
        .try_with(|range| {
            let (mut next, mut end) = range.get();
            if next == end {
                next = NEXT_BLOCK.fetch_add(BLOCK, Ordering::Relaxed);
                end = next.wrapping_add(BLOCK);
            }
            range.set((next.wrapping_add(1), end));
            next
        })
        // Thread teardown: fall back to one identity from a fresh shared block.
        .unwrap_or_else(|_| NEXT_BLOCK.fetch_add(BLOCK, Ordering::Relaxed))
}

#[cfg(test)]
#[path = "inner_tests.rs"]
mod tests;
