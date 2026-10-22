// SPDX-License-Identifier: MPL-2.0
//! The styled product entries: a material-layer attempt first, then the
//! per-item walk, or the voided host's cut sub-meshes.
//!
//! The voided entry keeps the original order of attempts: the layers sliced
//! from the opening-cut host; with no openings, nothing; then the layers
//! sliced from the uncut host, each cut by the openings; and only then the
//! per-item walk, cut. Each attempt is the same canonical layer control, so
//! each records its own diagnostics, in that order.
use super::inner::{ProgramError, ProgramStage};
use super::layers::{LayerControl, LayerReply};
use super::product::{ProductControl, ProductOutput, ProductReply};
use super::voids::{VoidControl, VoidReply};
use crate::processors::texture::ResolvedTextureMap;
use crate::router::processing::SourceHygiene;
use crate::{Error, GeometryRouter, Result, SubMeshCollection};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use rustc_hash::FxHashMap;

/// What a declined layer attempt continues with.
#[derive(Clone, Copy)]
enum Next<'a> {
    /// The per-item walk.
    Walk { allow_instancing: bool, textures: Option<&'a FxHashMap<u32, ResolvedTextureMap>>, hygiene: SourceHygiene },
    /// The cut-host attempt declined: try the uncut host.
    Uncut,
    /// The uncut-host attempt declined: walk and cut the host.
    Cut,
}

enum Phase<'a> {
    Layers(LayerControl<'a>, Next<'a>),
    Walk(ProductControl<'a>),
    Voids(VoidControl<'a>),
    Complete(Result<SubMeshCollection>),
    Taken,
}

pub(super) enum StyledReply {
    Layers(LayerReply),
    Walk(ProductReply),
    Voids(VoidReply),
}

impl StyledReply {
    pub(super) fn tag(&self) -> u16 {
        match self {
            Self::Layers(reply) => u16::from(reply.tag()),
            Self::Walk(reply) => 256 + u16::from(reply.tag()),
            Self::Voids(reply) => 512 + u16::from(reply.tag()),
        }
    }
}

pub(super) struct StyledControl<'a> {
    element: &'a DecodedEntity,
    ids: &'a [u32],
    phase: Phase<'a>,
}

impl<'a> StyledControl<'a> {
    /// The layered slices, or one sub-mesh per item; `allow_instancing`
    /// gates the #1623 don't-bake decision, `textures` keeps UVs (#1781).
    pub(super) fn product(element: &'a DecodedEntity, allow_instancing: bool,
        textures: Option<&'a FxHashMap<u32, ResolvedTextureMap>>, hygiene: SourceHygiene) -> Self {
        let next = Next::Walk { allow_instancing, textures, hygiene };
        Self { element, ids: &[], phase: Phase::Layers(LayerControl::index(element, &[]), next) }
    }

    /// The voided host's layered slices or cut sub-meshes; `ids` are its
    /// openings, empty when it has none.
    pub(super) fn voided(element: &'a DecodedEntity, ids: &'a [u32]) -> Self {
        Self { element, ids, phase: Phase::Layers(LayerControl::index(element, ids), Next::Uncut) }
    }

    pub(super) fn stage(&self) -> std::result::Result<Option<ProgramStage>, ProgramError> {
        match &self.phase {
            Phase::Layers(control, _) => control.stage(),
            Phase::Walk(control) => control.stage(),
            Phase::Voids(control) => control.stage(),
            Phase::Complete(_) => Ok(None),
            Phase::Taken => Err(ProgramError::Outstanding),
        }
    }

    pub(super) fn execute(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder)
        -> std::result::Result<StyledReply, ProgramError> {
        match &mut self.phase {
            Phase::Layers(control, _) => control.execute(router, decoder).map(StyledReply::Layers),
            Phase::Walk(control) => control.execute(router, decoder).map(StyledReply::Walk),
            Phase::Voids(control) => control.execute(router, decoder).map(StyledReply::Voids),
            Phase::Complete(_) | Phase::Taken => Err(ProgramError::StaleRequest),
        }
    }

    pub(super) fn accept(&mut self, reply: StyledReply, router: &GeometryRouter) {
        self.phase = match (std::mem::replace(&mut self.phase, Phase::Taken), reply) {
            (Phase::Layers(mut control, next), StyledReply::Layers(reply)) => {
                control.accept(reply, router);
                match control.take_result() {
                    None => Phase::Layers(control, next),
                    Some(result) => self.declined(result, next),
                }
            }
            (Phase::Walk(mut control), StyledReply::Walk(reply)) => {
                control.accept(reply, router);
                match control.take_result() {
                    None => Phase::Walk(control),
                    Some(result) => Phase::Complete(styled(result)),
                }
            }
            (Phase::Voids(mut control), StyledReply::Voids(reply)) => {
                control.accept(reply, router);
                match control.take_result() {
                    None => Phase::Voids(control),
                    Some(result) => Phase::Complete(styled(result)),
                }
            }
            // Payload validation precedes acceptance; a mismatch cannot reach here.
            (phase, _) => phase,
        };
    }

    /// Run the entry to completion against one router and decoder: the
    /// synchronous driver. Each attempt and walk runs its own in-place
    /// driver, so no phase or reply is moved per step.
    pub(super) fn run(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder)
        -> std::result::Result<(), ProgramError> {
        loop {
            match &mut self.phase {
                Phase::Layers(control, next) => {
                    let next = *next;
                    control.run(router, decoder)?;
                    let result = control.take_result().ok_or(ProgramError::Outstanding)?;
                    self.phase = self.declined(result, next);
                }
                Phase::Walk(control) => {
                    control.run(router, decoder)?;
                    let result = control.take_result().ok_or(ProgramError::Outstanding)?;
                    self.phase = Phase::Complete(styled(result));
                }
                Phase::Voids(control) => {
                    control.run(router, decoder)?;
                    let result = control.take_result().ok_or(ProgramError::Outstanding)?;
                    self.phase = Phase::Complete(styled(result));
                }
                Phase::Complete(_) => return Ok(()),
                Phase::Taken => return Err(ProgramError::Outstanding),
            }
        }
    }

    pub(super) fn take_result(&mut self) -> Option<Result<SubMeshCollection>> {
        match std::mem::replace(&mut self.phase, Phase::Taken) {
            Phase::Complete(result) => Some(result),
            other => {
                self.phase = other;
                None
            }
        }
    }

    /// A layer attempt completed: its slices, or what follows a decline.
    fn declined(&self, result: Result<Option<SubMeshCollection>>, next: Next<'a>) -> Phase<'a> {
        let (element, ids) = (self.element, self.ids);
        match (result, next) {
            (Err(error), _) => Phase::Complete(Err(error)),
            // The cut host already carries its openings.
            (Ok(Some(layered)), Next::Walk { .. } | Next::Uncut) => Phase::Complete(Ok(layered)),
            // Each uncut slice is cut by the openings.
            (Ok(Some(layered)), Next::Cut) => Phase::Voids(VoidControl::styled(element, ids, Some(layered))),
            (Ok(None), Next::Walk { allow_instancing, textures, hygiene }) => {
                Phase::Walk(ProductControl::styled(element, allow_instancing, textures, hygiene))
            }
            (Ok(None), Next::Uncut) if ids.is_empty() => Phase::Complete(Ok(SubMeshCollection::new())),
            (Ok(None), Next::Uncut) => Phase::Layers(LayerControl::index(element, &[]), Next::Cut),
            (Ok(None), Next::Cut) => Phase::Voids(VoidControl::styled(element, ids, None)),
        }
    }
}

fn styled(result: Result<ProductOutput>) -> Result<SubMeshCollection> {
    match result? {
        ProductOutput::Styled(meshes) => Ok(meshes),
        ProductOutput::Parts(_) => Err(Error::geometry("styled entry completed as frame parts")),
    }
}
