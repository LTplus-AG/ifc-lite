// SPDX-License-Identifier: MPL-2.0
//! One voided host: its product walk under boolean-operand hygiene, its void
//! context captured once by the owned host-opening control, then each host
//! part (or sub-mesh) cut by an owned numerical execution whose diagnostics
//! publish at accept, in part order.
//!
//! Opening and clip geometry are resolved in world coordinates, the frame
//! every part is in once placement has been applied. Classifying once per
//! host (not per sub-mesh) keeps a multi-layer wall with windows from
//! re-running every opening's product pipeline per layer.
use super::inner::{ProgramError, ProgramStage};
use super::product::{ProductControl, ProductOutput, ProductReply};
use crate::mesh::SubMesh;
use crate::program::openings::execute::{execute, NumericalOutcome};
use crate::program::openings::requests::OpeningReply;
use crate::program::openings::{protocol, OpeningControl, OpeningOutput, OpeningPoll};
use crate::router::processing::SourceHygiene;
use crate::router::voids::hygiene::clean_void_output;
use crate::router::voids::VoidContext;
use crate::{GeometryRouter, Mesh, Result, SubMeshCollection};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

/// The cut host geometry: merged frame parts are cut in place; voided
/// sub-meshes are collected anew, keeping only non-empty ones.
enum Parts {
    Merged { parts: Vec<Mesh>, next: usize },
    Styled { rest: std::vec::IntoIter<SubMesh>, done: SubMeshCollection },
}

enum Cutting {
    /// Cut the current part by the context.
    Cut(Mesh),
    /// Clean the slivers the cut can introduce at opening seams.
    Clean(Mesh),
    Taken,
}

enum Phase<'a> {
    Host(ProductControl<'a>, &'a [u32]),
    /// The host-opening control is boxed: at ~4.5 KiB inline it alone would
    /// exceed the program's 4 KiB ceiling and grow every item program. It
    /// is one allocation per voided host, after its walk completed.
    Openings { control: Box<OpeningControl<'a>>, poll: Option<OpeningPoll>, hosts: ProductOutput },
    /// `id` is the current part's geometry id (styled only).
    /// The context is boxed with the control: it would otherwise size every program.
    Cuts { context: Box<VoidContext>, parts: Parts, id: u32, step: Cutting },
    Complete(Result<ProductOutput>),
    Taken,
}

pub(super) enum VoidReply {
    Host(ProductReply),
    Opening(OpeningReply),
    Cut(NumericalOutcome),
    Cleaned(Mesh),
}

impl VoidReply {
    pub(super) fn tag(&self) -> u8 {
        match self {
            Self::Host(reply) => reply.tag(),
            Self::Opening(_) => 64,
            Self::Cut(_) => 65,
            Self::Cleaned(_) => 66,
        }
    }
}

pub(super) struct VoidControl<'a> {
    host: &'a DecodedEntity,
    styled: bool,
    phase: Phase<'a>,
}

impl<'a> VoidControl<'a> {
    /// `host`'s frame parts cut by the openings `ids`. With no openings it
    /// is the host's plain product walk, under output hygiene.
    pub(super) fn merged(host: &'a DecodedEntity, ids: &'a [u32]) -> Self {
        let hygiene = if ids.is_empty() { SourceHygiene::Watertight } else { SourceHygiene::BooleanOperand };
        let product = ProductControl::merged(host, hygiene);
        Self { host, styled: false, phase: Phase::Host(product, ids) }
    }

    /// `host`'s per-item sub-meshes cut by the openings `ids`, or its uncut
    /// `layered` slices when the uncut layer attempt sliced it. A voided
    /// occurrence materializes its cut geometry (#1623 don't-bake off) with
    /// no texture index (#1781: a cut rebuilds vertices, orphaning UVs).
    pub(super) fn styled(host: &'a DecodedEntity, ids: &'a [u32], layered: Option<SubMeshCollection>) -> Self {
        let phase = match layered {
            Some(sub_meshes) => hosts_complete(host, ids, Ok(ProductOutput::Styled(sub_meshes))),
            None => Phase::Host(ProductControl::styled(host, false, None, SourceHygiene::BooleanOperand), ids),
        };
        Self { host, styled: true, phase }
    }

    pub(super) fn stage(&self) -> std::result::Result<Option<ProgramStage>, ProgramError> {
        Ok(match &self.phase {
            Phase::Host(product, _) => return product.stage(),
            Phase::Openings { poll: Some(OpeningPoll::Ready(_)), .. } => Some(ProgramStage::Numerical),
            // A source admission, or a reached item's canonical child run.
            Phase::Openings { poll: Some(_), .. } => Some(ProgramStage::Source),
            Phase::Cuts { step: Cutting::Cut(_) | Cutting::Clean(_), .. } => Some(ProgramStage::Numerical),
            Phase::Complete(_) => None,
            Phase::Openings { poll: None, .. } | Phase::Cuts { .. } | Phase::Taken => {
                return Err(ProgramError::Outstanding)
            }
        })
    }

    pub(super) fn execute(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder)
        -> std::result::Result<VoidReply, ProgramError> {
        let id = self.host.id;
        let styled = self.styled;
        match &mut self.phase {
            Phase::Host(product, _) => product.execute(router, decoder).map(VoidReply::Host),
            Phase::Openings { control, poll, .. } => Ok(VoidReply::Opening(match poll.take() {
                Some(OpeningPoll::Source(source)) => control.source(source, router, decoder),
                Some(OpeningPoll::Ready(ready)) => ready.execute(),
                Some(OpeningPoll::Geometry) => {
                    OpeningReply::Parts(control.child(router).and_then(|child| child.run(router, decoder)))
                }
                _ => return Err(ProgramError::StaleRequest),
            })),
            Phase::Cuts { context, step, .. } => match std::mem::replace(step, Cutting::Taken) {
                Cutting::Cut(mesh) => Ok(VoidReply::Cut(execute(mesh, context, id, router.tessellation_quality()))),
                Cutting::Clean(mut mesh) => {
                    clean_cut(&mut mesh, styled);
                    Ok(VoidReply::Cleaned(mesh))
                }
                Cutting::Taken => Err(ProgramError::StaleRequest),
            },
            Phase::Complete(_) | Phase::Taken => Err(ProgramError::StaleRequest),
        }
    }

    pub(super) fn accept(&mut self, reply: VoidReply, router: &GeometryRouter) {
        let phase = std::mem::replace(&mut self.phase, Phase::Taken);
        self.phase = match (phase, reply) {
            (Phase::Host(mut product, ids), VoidReply::Host(reply)) => {
                product.accept(reply, router);
                match product.take_result() {
                    None => Phase::Host(product, ids),
                    Some(result) => hosts_complete(self.host, ids, result),
                }
            }
            (Phase::Openings { mut control, hosts, .. }, VoidReply::Opening(reply)) => {
                control.resume(reply, router);
                poll_openings(control, hosts)
            }
            // Accept the geometry and publish its diagnostics once; a stop
            // keeps only the reached kernel failures, an unwind resumes.
            (Phase::Cuts { context, parts, id, .. }, VoidReply::Cut(outcome)) => match outcome.publish(router) {
                Ok(mesh) => Phase::Cuts { context, parts, id, step: Cutting::Clean(mesh) },
                Err(error) => Phase::Complete(Err(error)),
            },
            (Phase::Cuts { context, parts, id, .. }, VoidReply::Cleaned(mesh)) => {
                next_cut(context, parts, id, mesh)
            }
            // Payload validation precedes acceptance; a mismatch cannot reach here.
            (phase, _) => phase,
        };
    }

    /// Run the voided host to completion against one router and decoder: the
    /// synchronous driver. The host walk runs in place, the void context is
    /// captured by the opening control's own polled loop, and each part is
    /// cut and cleaned in turn, with no phase or reply moved per step.
    pub(super) fn run(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder)
        -> std::result::Result<(), ProgramError> {
        let (id, styled) = (self.host.id, self.styled);
        if let Phase::Host(product, _) = &mut self.phase {
            product.run(router, decoder)?;
            let result = product.take_result().ok_or(ProgramError::Outstanding)?;
            let Phase::Host(_, ids) = std::mem::replace(&mut self.phase, Phase::Taken) else {
                return Err(ProgramError::StaleRequest);
            };
            self.phase = hosts_complete(self.host, ids, result);
        }
        if matches!(self.phase, Phase::Openings { .. }) {
            let Phase::Openings { mut control, mut poll, hosts } = std::mem::replace(&mut self.phase, Phase::Taken)
            else {
                return Err(ProgramError::StaleRequest);
            };
            self.phase = loop {
                let reply = match poll.take() {
                    Some(OpeningPoll::Source(source)) => control.source(source, router, decoder),
                    Some(OpeningPoll::Ready(ready)) => ready.execute(),
                    Some(OpeningPoll::Geometry) => {
                        OpeningReply::Parts(control.child(router).and_then(|child| child.run(router, decoder)))
                    }
                    _ => return Err(ProgramError::StaleRequest),
                };
                control.resume(reply, router);
                if let Err(stop) = crate::resource::check_current() {
                    break Phase::Complete(Err(stop.into()));
                }
                match control.poll() {
                    OpeningPoll::Complete(output) => break context_ready(output, hosts),
                    next => poll = Some(next),
                }
            };
        }
        if matches!(self.phase, Phase::Cuts { .. }) {
            let Phase::Cuts { context, mut parts, id: mut part_id, step } =
                std::mem::replace(&mut self.phase, Phase::Taken)
            else {
                return Err(ProgramError::StaleRequest);
            };
            let Cutting::Cut(mut mesh) = step else { return Err(ProgramError::StaleRequest) };
            self.phase = loop {
                // Accept the geometry and publish its diagnostics once; a stop
                // keeps only the reached kernel failures, an unwind resumes.
                let outcome = execute(mesh, &context, id, router.tessellation_quality());
                let mut cut = match outcome.publish(router) {
                    Ok(cut) => cut,
                    Err(error) => break Phase::Complete(Err(error)),
                };
                clean_cut(&mut cut, styled);
                keep_cut(&mut parts, part_id, cut);
                match take_part(&mut parts) {
                    Some((next_id, next)) => (part_id, mesh) = (next_id, next),
                    None => break Phase::Complete(Ok(parts_output(parts))),
                }
            };
        }
        match &self.phase {
            Phase::Complete(_) => Ok(()),
            _ => Err(ProgramError::Outstanding),
        }
    }

    pub(super) fn take_result(&mut self) -> Option<Result<ProductOutput>> {
        match std::mem::replace(&mut self.phase, Phase::Taken) {
            Phase::Complete(result) => Some(result),
            other => {
                self.phase = other;
                None
            }
        }
    }
}

/// The host geometry is complete: capture its void context, unless there is
/// no sub-mesh to cut or no opening to cut it by.
fn hosts_complete<'a>(host: &'a DecodedEntity, ids: &'a [u32], hosts: Result<ProductOutput>) -> Phase<'a> {
    match hosts {
        Ok(ProductOutput::Styled(sub_meshes)) if sub_meshes.is_empty() => {
            Phase::Complete(Ok(ProductOutput::Styled(SubMeshCollection::new())))
        }
        Ok(hosts) if ids.is_empty() => Phase::Complete(Ok(hosts)),
        Ok(hosts) => poll_openings(Box::new(OpeningControl::host(host, ids)), hosts),
        Err(error) => Phase::Complete(Err(error)),
    }
}

/// Poll the host-opening control for its next request. A stop reached by
/// any stage ends the control before its next request, and the completed
/// context is checked once more before any part is cut.
fn poll_openings(mut control: Box<OpeningControl<'_>>, hosts: ProductOutput) -> Phase<'_> {
    if let Err(stop) = crate::resource::check_current() {
        return Phase::Complete(Err(stop.into()));
    }
    match control.poll() {
        OpeningPoll::Complete(output) => context_ready(output, hosts),
        poll => Phase::Openings { control, poll: Some(poll), hosts },
    }
}

/// The captured void context is checked once more, then cuts the first host
/// part.
fn context_ready<'a>(output: Result<OpeningOutput>, hosts: ProductOutput) -> Phase<'a> {
    let context = match output.and_then(|output| {
        crate::resource::check_current()?;
        Ok(output)
    }) {
        Ok(OpeningOutput::Context(context)) => Box::new(context),
        Ok(_) => return Phase::Complete(Err(protocol("host openings output"))),
        Err(error) => return Phase::Complete(Err(error)),
    };
    let parts = match hosts {
        ProductOutput::Parts(parts) => Parts::Merged { parts, next: 0 },
        // INHERIT the discriminator rather than assuming rep-item ids: a
        // layered producer must never relabel material ids as items (#3199).
        ProductOutput::Styled(sub_meshes) => Parts::Styled {
            done: SubMeshCollection { sub_meshes: Vec::new(), ids_are_materials: sub_meshes.ids_are_materials },
            rest: sub_meshes.sub_meshes.into_iter(),
        },
    };
    advance(context, parts)
}

/// Clean the slivers the cut can introduce at opening seams.
fn clean_cut(mesh: &mut Mesh, styled: bool) {
    // Same closure-preserving hygiene as the untextured source chokepoints
    // (#7292).
    clean_void_output(mesh);
    // Instancing: a void-cut mesh no longer reproduces its representation's
    // canonical geometry, so it can never be shared. Drop any metadata that
    // rode along from the (pre-cut) mapped item.
    if !styled {
        mesh.instance_meta = None;
    }
}

/// Keep a cleaned part.
fn keep_cut(parts: &mut Parts, id: u32, mesh: Mesh) {
    match parts {
        Parts::Merged { parts, next } => {
            if let Some(slot) = parts.get_mut(*next) {
                *slot = mesh;
            }
            *next += 1;
        }
        Parts::Styled { done, .. } => {
            if !mesh.is_empty() {
                done.sub_meshes.push(SubMesh::new(id, mesh));
            }
        }
    }
}

/// The next part to cut, and its geometry id.
fn take_part(parts: &mut Parts) -> Option<(u32, Mesh)> {
    match parts {
        Parts::Merged { parts, next } => parts.get_mut(*next).map(|part| (0, std::mem::take(part))),
        Parts::Styled { rest, .. } => rest.next().map(|sub| (sub.geometry_id, sub.mesh)),
    }
}

fn parts_output(parts: Parts) -> ProductOutput {
    match parts {
        Parts::Merged { parts, .. } => ProductOutput::Parts(parts),
        Parts::Styled { done, .. } => ProductOutput::Styled(done),
    }
}

/// Keep a cleaned part, then cut the next one or complete.
fn next_cut<'a>(context: Box<VoidContext>, mut parts: Parts, id: u32, mesh: Mesh) -> Phase<'a> {
    keep_cut(&mut parts, id, mesh);
    advance(context, parts)
}

fn advance<'a>(context: Box<VoidContext>, mut parts: Parts) -> Phase<'a> {
    match take_part(&mut parts) {
        Some((id, mesh)) => Phase::Cuts { context, parts, id, step: Cutting::Cut(mesh) },
        None => Phase::Complete(Ok(parts_output(parts))),
    }
}
