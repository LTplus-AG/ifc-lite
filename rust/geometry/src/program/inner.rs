// SPDX-License-Identifier: MPL-2.0
//! Linear request/execute/accept protocol for one reached geometry occurrence.
//! Recipes live in the program, never in tickets: a copied request cannot
//! replay work, and a foreign router or decoder is refused before any recipe
//! is moved. Item, Cache, Mapping, Product, Void, Layer and Styled-entry
//! controllers exist so far.
use super::inner_cache::{CacheControl, CacheReply};
use super::item::{ItemControl, ItemStep};
use super::layers::{LayerControl, LayerReply};
use super::mapping::{MappingControl, MappingOutput, MappingReply};
use super::product::{ProductControl, ProductOutput, ProductReply};
use super::styled::{StyledControl, StyledReply};
use super::voids::{VoidControl, VoidReply};
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
    /// A bare item program: production items run inside the cache or mapping
    /// controller, so only the item-protocol tests construct one.
    #[cfg_attr(not(test), allow(dead_code))]
    Item(&'a DecodedEntity, ItemControl),
    Cache(&'a DecodedEntity, CacheControl),
    Mapping(MappingControl<'a>),
    Product(ProductControl<'a>),
    Voids(VoidControl<'a>),
    Layers(LayerControl<'a>),
    Styled(StyledControl<'a>),
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
    UnsupportedRetained,
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
    Cache(u8),
    Mapping(u8),
    Product(u8),
    Voids(u8),
    Layers(u8),
    Styled(u16),
}

pub(crate) struct ProgramReply {
    request: ProgramRequest,
    value: ReplyValue,
}
enum ReplyValue {
    Item(ItemStep),
    Cache(CacheReply),
    Mapping(MappingReply),
    Product(ProductReply),
    Voids(VoidReply),
    Layers(LayerReply),
    Styled(StyledReply),
}
impl ReplyValue {
    fn tag(&self) -> Payload {
        match self {
            Self::Item(_) => Payload::Item,
            Self::Cache(reply) => Payload::Cache(reply.tag()),
            Self::Mapping(reply) => Payload::Mapping(reply.tag()),
            Self::Product(reply) => Payload::Product(reply.tag()),
            Self::Voids(reply) => Payload::Voids(reply.tag()),
            Self::Layers(reply) => Payload::Layers(reply.tag()),
            Self::Styled(reply) => Payload::Styled(reply.tag()),
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
            Control::Item(_, control) => control.stage()?,
            Control::Cache(_, control) => control.stage()?,
            Control::Mapping(control) => control.stage()?,
            Control::Product(control) => control.stage()?,
            Control::Voids(control) => control.stage()?,
            Control::Layers(control) => control.stage()?,
            Control::Styled(control) => control.stage()?,
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
        if matches!(&self.control, Control::Product(c) if c.retained_ready()) {
            return Err(ProgramError::UnsupportedRetained);
        }
        if matches!(&self.control, Control::Mapping(c) if c.retained_ready()) { return Err(ProgramError::UnsupportedRetained); }
        self.expected_router = Some(router.execution_identity());
        self.expected_decoder = Some(decoder.execution_identity());
        let decoder_before = decoder.execution_identity();
        // Consume admission before any callback can unwind. A copied ticket
        // cannot replay work after its recipe was moved into a lexical call.
        self.pending = Some((request, true));
        let value = match &mut self.control {
            Control::Item(item, control) => ReplyValue::Item(control.execute(item, router, decoder)?),
            Control::Cache(item, control) => ReplyValue::Cache(control.execute(item, router, decoder)?),
            Control::Mapping(control) => ReplyValue::Mapping(control.execute(router, decoder)?),
            Control::Product(control) => ReplyValue::Product(control.execute(router, decoder)?),
            Control::Voids(control) => ReplyValue::Voids(control.execute(router, decoder)?),
            Control::Layers(control) => ReplyValue::Layers(control.execute(router, decoder)?),
            Control::Styled(control) => ReplyValue::Styled(control.execute(router, decoder)?),
        };
        // Maintenance may change the generation, but replacing the decoder
        // changes the source owner and must refuse before accepting any output.
        if !decoder_before.same_instance(&decoder.execution_identity()) {
            return Err(ProgramError::WrongOwner);
        }
        // Acknowledge configuration or cache maintenance on the same instance.
        self.expected_router = Some(router.execution_identity());
        self.expected_decoder = Some(decoder.execution_identity());
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
            (Control::Item(_, control), ReplyValue::Item(step)) => control.accept(step, router),
            (Control::Cache(item, control), ReplyValue::Cache(reply)) => control.accept(item, reply, router),
            (Control::Mapping(control), ReplyValue::Mapping(reply)) => control.accept(reply, router),
            (Control::Product(control), ReplyValue::Product(reply)) => control.accept(reply, router),
            (Control::Voids(control), ReplyValue::Voids(reply)) => control.accept(reply, router),
            (Control::Layers(control), ReplyValue::Layers(reply)) => control.accept(reply, router),
            (Control::Styled(control), ReplyValue::Styled(reply)) => control.accept(reply, router),
            (_, value) => {
                let reply = ProgramReply { request, value };
                return Err(Box::new(RejectedProgramReply { error: ProgramError::WrongPayload, reply }));
            }
        }
        self.pending = None;
        self.expected_payload = None;
        Ok(())
    }

    /// The completed program's output. An incomplete program is an error.
    fn finish_output(mut self) -> Result<Output> {
        let result = match &mut self.control {
            _ if self.pending.is_some() => None,
            Control::Item(_, control) => control.take_result().map(|result| result.map(Output::Mesh)),
            Control::Cache(_, control) => control.take_result().map(|result| result.map(Output::Mesh)),
            Control::Mapping(control) => control.take_result().map(|result| result.map(Output::Mapping)),
            Control::Product(control) => control.take_result().map(|result| result.map(Output::Product)),
            Control::Voids(control) => control.take_result().map(|result| result.map(Output::Product)),
            Control::Layers(control) => control.take_result().map(|result| result.map(Output::Layers)),
            Control::Styled(control) => {
                control.take_result().map(|result| result.map(|meshes| Output::Product(ProductOutput::Styled(meshes))))
            }
        };
        result.unwrap_or_else(|| Err(Error::geometry("geometry program finished before completion")))
    }

    /// The completed occurrence's mesh.
    pub(crate) fn finish(self) -> Result<Mesh> {
        match self.finish_output()? {
            Output::Mesh(mesh) => Ok(mesh),
            _ => Err(Error::geometry("this program does not complete as one mesh")),
        }
    }

    /// The completed program's frame parts (#6349, #6446).
    pub(crate) fn finish_parts(self) -> Result<Vec<Mesh>> {
        match self.finish_output()? {
            Output::Mapping(MappingOutput::Parts(parts)) | Output::Product(ProductOutput::Parts(parts)) => Ok(parts),
            _ => Err(Error::geometry("this program does not complete as frame parts")),
        }
    }

    /// Run every request synchronously against one router and decoder.
    pub(crate) fn drain(mut self, router: &GeometryRouter, decoder: &mut EntityDecoder) -> Result<Mesh> {
        self.run(router, decoder)?;
        self.finish()
    }

    /// [`Self::drain`] for a mapping, product or void program.
    pub(crate) fn drain_parts(mut self, router: &GeometryRouter, decoder: &mut EntityDecoder)
        -> Result<Vec<Mesh>> {
        self.run(router, decoder)?;
        self.finish_parts()
    }

    /// [`Self::drain`] for a styled program: its sub-meshes.
    pub(crate) fn drain_styled(mut self, router: &GeometryRouter, decoder: &mut EntityDecoder)
        -> Result<crate::SubMeshCollection> {
        self.run(router, decoder)?;
        match self.finish_output()? {
            Output::Mapping(MappingOutput::Styled(meshes)) | Output::Product(ProductOutput::Styled(meshes)) => Ok(meshes),
            _ => Err(Error::geometry("this program does not complete as sub-meshes")),
        }
    }

    /// [`Self::drain`] for a type-map program: its render parts.
    pub(crate) fn drain_type_parts(mut self, router: &GeometryRouter, decoder: &mut EntityDecoder)
        -> Result<crate::router::textured::TypeParts> {
        self.run(router, decoder)?;
        match self.finish_output()? {
            Output::Mapping(MappingOutput::Type(parts)) => Ok(parts),
            _ => Err(Error::geometry("this program does not complete as type parts")),
        }
    }

    /// [`Self::drain`] for a material-layer attempt: its slices, if any.
    pub(crate) fn drain_layers(mut self, router: &GeometryRouter, decoder: &mut EntityDecoder)
        -> Result<Option<crate::SubMeshCollection>> {
        self.run(router, decoder)?;
        match self.finish_output()? {
            Output::Layers(layered) => Ok(layered),
            _ => Err(Error::geometry("this program does not complete as layer slices")),
        }
    }

    fn run(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder) -> Result<()> {
        // A walk no request was issued for runs in place, moving no ticket or reply per step.
        if self.pending.is_none() && self.sequence == 0 {
            let decoder_before = decoder.execution_identity();
            let direct = match &mut self.control {
                Control::Product(c) => Some(c.run(router, decoder)),
                Control::Voids(c) => Some(c.run(router, decoder)),
                Control::Layers(c) => Some(c.run(router, decoder)),
                Control::Styled(c) => Some(c.run(router, decoder)),
                _ => None,
            };
            if let Some(result) = direct {
                result.map_err(program_error)?;
                if !decoder_before.same_instance(&decoder.execution_identity()) {
                    return Err(program_error(ProgramError::WrongOwner));
                }
                return Ok(());
            }
        }
        while let Some(request) = self.request().map_err(program_error)? {
            let reply = self.execute(request, router, decoder).map_err(program_error)?;
            self.accept(reply, router).map_err(|rejected| program_error(rejected.error))?;
        }
        Ok(())
    }
}

/// A completed program's output, by controller.
enum Output {
    Mesh(Mesh),
    Mapping(MappingOutput),
    Product(ProductOutput),
    Layers(Option<crate::SubMeshCollection>),
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

#[path = "retained/program.rs"]
pub(super) mod retained_program;

#[path = "inner_entries.rs"]
mod entries;

#[cfg(test)]
#[path = "inner_tests.rs"]
mod tests;
