// SPDX-License-Identifier: MPL-2.0
//! Canonical product continuation with synchronous typed work admission.
//!
//! One product is planned once, then advanced one ticket at a time:
//! `next_ticket` issues the next ticket, `execute_live` runs its router work,
//! and `accept_live` validates the reply before presenting it. Foreign,
//! out-of-order and duplicate packets are refused before any callback, hash or
//! cache access; both halves take their packet as input, so these refusals are
//! the shipped checks, not a test-only replica. A synchronous driver holds ONE
//! owner epoch (`session_run`) open around planning, every ticket and
//! publication, so the product pays the lease, scope and capability setup
//! once. The same slices also run one epoch per ticket
//! (`session_resumable`), the seam a resumable executor builds on.
//! This private protocol does not authorize asynchronous or remote execution.
use super::plan::PlanKind;
use super::session_owner::OwnerStamp;
use super::session_protocol::{Protocol, WorkError, WorkPayload, WorkReply, WorkRequest};
use super::session_state::{Stage, TriangleOrderScope};
use super::*;
use ifc_lite_core::execution_owner::ExecutionIdentity;
use ifc_lite_geometry::resource::{self, ProgramStop};

/// What an open owner epoch hands its product: the owner stamp every reply
/// carries, the decoder instance a callback may not replace, the snapshot its
/// tickets carry, and a stop already pending when the epoch opened.
#[derive(Clone, Copy)]
pub(super) struct Live {
    pub stamp: OwnerStamp,
    pub decoder: ExecutionIdentity,
    pub context: Option<ProductionContextId>,
    pub preplanning_stop: Option<ProgramStop>,
}

pub(super) struct ProductState<'j> {
    pub(super) job: &'j ElementMeshJob<'j>,
    pub(super) stage: Stage<'j>,
    pub(super) element_color: [f32; 4],
    /// `MeshProductionOptions::presentation_provenance`, read at planning.
    pub(super) provenance: bool,
    pub(super) keep_order: bool,
    /// Resumable-only state (`session_resumable`); no shipped method reads it.
    /// `None` once an unwind or a failed owner commit poisoned a resumable product.
    #[cfg(test)]
    pub(super) scopes: Option<super::session_state::Scopes>,
    #[cfg(test)]
    pub(super) owner: Option<super::session_owner::ProductOwner>,
    pub(super) hasher: Option<GeometryHasher>,
    pub(super) meshes: Vec<MeshData>,
    pub(super) occurrences: Vec<RawInstanceOccurrence>,
    pub(super) protocol: Protocol,
    /// Set while a synchronous driver holds the epoch open around this product.
    pub(super) live: Option<Live>,
    terminal: Option<ProgramStop>,
}

/// (plan, element colour), hasher, keep triangle order, record presentation provenance.
pub(super) type Planned<'j> = ((PlanKind<'j>, [f32; 4]), Option<GeometryHasher>, bool, bool);

impl<'j> ProductState<'j> {
    /// Plan inside the driver's open epoch and scopes.
    pub(super) fn plan_live(
        job: &'j ElementMeshJob<'j>,
        ctx: &MeshProductionContext<'_>,
        opts: &MeshProductionOptions,
        decoder: &mut EntityDecoder,
        router: &GeometryRouter,
        live: Live,
    ) -> Self {
        let (planned, terminal) = match live.preplanning_stop {
            Some(stop) => (None, Some(stop)),
            None => plan_in_scope(job, ctx, opts, decoder, router),
        };
        Self::planned(job, planned, terminal, live.context, Some(live))
    }

    pub(super) fn planned(
        job: &'j ElementMeshJob<'j>,
        planned: Option<Planned<'j>>,
        terminal: Option<ProgramStop>,
        context: Option<ProductionContextId>,
        live: Option<Live>,
    ) -> Self {
        let ((kind, element_color), hasher, keep_order, provenance) =
            planned.unwrap_or(((PlanKind::NoRepresentation, [0.; 4]), None, false, false));
        let stage = match kind {
            PlanKind::NoRepresentation => Stage::Complete,
            PlanKind::TypeMaps(maps) => Stage::TypeMaps(maps.iter()),
            PlanKind::Product { primary, layer_class } => Stage::Primary { strategy: primary, layer_class },
        };
        let mut state = Self {
            job,
            stage,
            element_color,
            keep_order,
            provenance,
            #[cfg(test)]
            scopes: None,
            #[cfg(test)]
            owner: None,
            hasher,
            meshes: Vec::new(),
            occurrences: Vec::new(),
            protocol: Protocol::new(context),
            live,
            terminal: None,
        };
        if let Some(stop) = terminal {
            state.remember_stop(stop);
        }
        state
    }

    /// The next ticket, or `None` once the plan completed or stopped. Each
    /// driver first checks that its own owner state can still make progress.
    pub(super) fn next_ticket(&mut self) -> Result<Option<WorkRequest>, WorkError> {
        self.protocol.idle()?;
        if self.capture_stop() {
            return Ok(None);
        }
        let Some(kind) = self.stage.next_kind() else { return Ok(None); };
        Ok(Some(self.protocol.issue(kind)))
    }

    /// The router work of one ticket, with the product's triangle-order mode
    /// installed for exactly this slice. Runs inside an open owner epoch.
    pub(super) fn execute_slice(
        &mut self,
        request: WorkRequest,
        ctx: &MeshProductionContext<'_>,
        decoder: &mut EntityDecoder,
        router: &GeometryRouter,
    ) -> WorkPayload {
        let order = TriangleOrderScope::new(router, self.keep_order);
        let payload = session_work::execute(request.kind, self.job, ctx, decoder, router);
        self.keep_order = order.finish();
        payload
    }

    /// Present one validated reply under the product's triangle-order mode.
    /// Presentation reads source (styles, materials, palettes) but invokes no
    /// processor or drain hook and changes no owner configuration.
    pub(super) fn accept_slice(
        &mut self,
        reply: WorkReply,
        ctx: &MeshProductionContext<'_>,
        decoder: &mut EntityDecoder,
        router: &GeometryRouter,
    ) {
        let order = TriangleOrderScope::new(router, self.keep_order);
        self.assemble_reply(reply, ctx, decoder);
        self.keep_order = order.finish();
        self.protocol.accepted();
        if let Err(stop) = resource::check_current() {
            self.remember_stop(stop);
        }
    }

    /// One ticket inside the driver's open epoch: request, execute, accept.
    pub(super) fn step_live(
        &mut self,
        ctx: &MeshProductionContext<'_>,
        decoder: &mut EntityDecoder,
        router: &GeometryRouter,
    ) -> Result<bool, WorkError> {
        if self.live.is_none() {
            return Err(WorkError::Aborted);
        }
        let Some(request) = self.next_ticket()? else { return Ok(false) };
        let reply = self.execute_live(request, ctx, decoder, router)?;
        self.accept_live(reply, ctx, decoder, router)?;
        Ok(true)
    }

    /// Run one ticket's router work in the open epoch. A foreign, stale,
    /// duplicate or wrong-snapshot ticket is refused before any callback.
    pub(super) fn execute_live(
        &mut self,
        request: WorkRequest,
        ctx: &MeshProductionContext<'_>,
        decoder: &mut EntityDecoder,
        router: &GeometryRouter,
    ) -> Result<WorkReply, WorkError> {
        let Some(live) = self.live else { return Err(WorkError::Aborted) };
        self.protocol.before_execute(request)?;
        let payload = self.execute_slice(request, ctx, decoder, router);
        // A callback may maintain its own decoder, never replace it.
        if !decoder.execution_identity().same_instance(&live.decoder) {
            return Err(WorkError::WrongOwner);
        }
        if let WorkPayload::Stopped(stop) = &payload {
            self.remember_stop(*stop);
        }
        self.protocol.executed(request);
        Ok(WorkReply { request, context: request.context, owner: live.stamp, emitter: request.kind.emitter(), payload })
    }

    /// Validate one reply against this product's protocol and live owner,
    /// then present it. A refused reply reaches no hash, cache or callback;
    /// the live driver holds no reply across a refusal, so it is dropped.
    pub(super) fn accept_live(
        &mut self,
        reply: WorkReply,
        ctx: &MeshProductionContext<'_>,
        decoder: &mut EntityDecoder,
        router: &GeometryRouter,
    ) -> Result<(), WorkError> {
        let Some(live) = self.live else { return Err(WorkError::Aborted) };
        self.protocol.before_accept(&reply)?;
        if reply.owner != live.stamp {
            return Err(WorkError::WrongOwner);
        }
        if self.capture_stop() {
            self.protocol.accepted();
        } else {
            self.accept_slice(reply, ctx, decoder, router);
        }
        Ok(())
    }

    /// A terminal fault belongs to this product across lexical owner epochs.
    /// Earlier independent cache/source effects survive; partial output does not.
    #[cold]
    #[inline(never)]
    pub(super) fn remember_stop(&mut self, stop: ProgramStop) {
        let first = *self.terminal.get_or_insert(stop);
        resource::stop(first);
        self.stage = Stage::Complete;
        self.meshes.clear();
        self.occurrences.clear();
        self.hasher = None;
    }

    pub(super) fn capture_stop(&mut self) -> bool {
        let stop = match self.terminal {
            Some(stop) => stop,
            None => match resource::check_current() {
                Ok(()) => return false,
                Err(stop) => stop,
            },
        };
        self.remember_stop(stop);
        true
    }

    pub(super) fn terminal(&self) -> Option<ProgramStop> {
        self.terminal
    }
}

/// Planning under the product's scopes: hasher, triangle-order mode and plan.
pub(super) fn plan_in_scope<'j>(
    job: &'j ElementMeshJob<'j>,
    ctx: &MeshProductionContext<'_>,
    opts: &MeshProductionOptions,
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
) -> (Option<Planned<'j>>, Option<ProgramStop>) {
    ifc_lite_geometry::progress::tick();
    if let Err(stop) = resource::check_current() {
        return (None, Some(stop));
    }
    let hasher = match (&job.kind, opts.geometry_hash) {
        (ElementJobKind::Product, Some(cfg)) => Some(GeometryHasher::new(cfg.tolerance, cfg.world_rtc)),
        _ => None,
    };
    // #858 splits a colour-mapped face set by triangle index, so its triangles
    // must keep their order through source hygiene (#5313).
    let keep_order = !ctx.indexed_colour_full.is_empty()
        && element_color::element_reaches_indexed_colour(job.entity, ctx.indexed_colour_full, decoder);
    let order = TriangleOrderScope::new(router, keep_order);
    let plan = plan::plan_element(job, ctx, decoder, router);
    let keep_order = order.finish();
    let planned = ((plan.kind, plan.element_color), hasher, keep_order, opts.presentation_provenance);
    (Some(planned), resource::check_current().err())
}

#[cfg(test)]
#[path = "session_terminal_tests.rs"]
mod terminal_tests;

#[cfg(test)]
#[path = "session_opaque_reports_tests.rs"]
mod opaque_reports_tests;

#[cfg(test)]
#[path = "session_mixed_reports_tests.rs"]
mod mixed_reports_tests;
