// SPDX-License-Identifier: MPL-2.0
//! The resumable mode of the same protocol: one owner epoch per ticket, with
//! the product dormant (planned, owner-free) between them. It runs the same
//! slices and the same `Protocol` as the synchronous driver, which keeps its
//! epoch open for the whole product; tests drive it to interleave independent
//! products, hand a dormant product to another worker, and return a refused
//! reply intact. A resumable executor (retained execution) builds on it.
use super::owned_session::OwnedProductExecution;
use super::session::ProductState;
use super::session_owner::{OwnerStamp, ProductOwner};
use super::session_protocol::{RejectedReply, WorkError, WorkPayload, WorkReply, WorkRequest};
use super::session_state::{ActiveScopes, Scopes, Stage};
use super::*;
use ifc_lite_geometry::resource;

/// How a new resumable product obtains its owner, and the snapshot its tickets carry.
pub(super) struct Admission {
    /// A lexical child's leases inherited from a live ancestor's work.
    pub inherited: Option<ProductOwner>,
    pub context: Option<ProductionContextId>,
}

impl<'j> ProductState<'j> {
    /// Strict admission: the decoder and router must be free.
    pub fn new(
        job: &'j ElementMeshJob<'j>,
        ctx: &MeshProductionContext<'_>,
        opts: &MeshProductionOptions,
        decoder: &mut EntityDecoder,
        router: &GeometryRouter,
    ) -> Result<Self, WorkError> {
        Self::plan(job, ctx, opts, decoder, router, Admission { inherited: None, context: None })
    }

    pub(super) fn plan(
        job: &'j ElementMeshJob<'j>,
        ctx: &MeshProductionContext<'_>,
        opts: &MeshProductionOptions,
        decoder: &mut EntityDecoder,
        router: &GeometryRouter,
        admission: Admission,
    ) -> Result<Self, WorkError> {
        let preplanning_stop = resource::check_current().err();
        let inherited_child = admission.inherited.is_some();
        let mut planning_owner = match admission.inherited {
            Some(owner) => owner,
            None => ProductOwner::admit(decoder, router)?,
        };
        let mut scopes = ActiveScopes::new(Scopes::new());
        let ((planned, terminal), _) = planning_owner.work(decoder, router, |decoder, router| {
            scopes.with_scope(|| match preplanning_stop {
                Some(stop) => (None, Some(stop)),
                None => super::session::plan_in_scope(job, ctx, opts, decoder, router),
            })
        })?;
        let mut state = Self::planned(job, planned, terminal, admission.context, None);
        state.scopes = Some(scopes.complete());
        // A dormant product holds no owner until its first numerical admission,
        // unless it is a lexical child, which keeps its inherited leases.
        state.owner = Some(planning_owner).filter(|_| inherited_child);
        Ok(state)
    }

    fn admit_owner(&mut self, decoder: &EntityDecoder, router: &GeometryRouter) -> Result<OwnerStamp, WorkError> {
        match &self.owner {
            Some(owner) => owner.validate(decoder, router),
            None => {
                let owner = ProductOwner::admit(decoder, router)?;
                let stamp = owner.validate(decoder, router)?;
                self.owner = Some(owner);
                Ok(stamp)
            }
        }
    }

    pub fn execute(
        &mut self,
        request: WorkRequest,
        ctx: &MeshProductionContext<'_>,
        decoder: &mut EntityDecoder,
        router: &GeometryRouter,
    ) -> Result<WorkReply, WorkError> {
        if self.scopes.is_none() {
            return Err(WorkError::Aborted);
        }
        self.protocol.before_execute(request)?;
        self.admit_owner(decoder, router)?;
        let (Some(mut owner), Some(scopes)) = (self.owner.take(), self.scopes.take()) else {
            return Err(WorkError::Aborted);
        };
        let mut scopes = ActiveScopes::new(scopes);
        let execution = owner.work(decoder, router, |decoder, router| {
            scopes.with_scope(|| self.execute_slice(request, ctx, decoder, router))
        });
        // On a failed owner commit the active scopes drop and poison the
        // product; never permit re-admission against this outstanding ticket.
        self.owner = Some(owner);
        let (payload, owner) = execution?;
        self.scopes = Some(scopes.complete());
        if let WorkPayload::Stopped(stop) = &payload {
            self.remember_stop(*stop);
        }
        self.protocol.executed(request);
        Ok(WorkReply { request, context: request.context, owner, emitter: request.kind.emitter(), payload })
    }

    /// Every check precedes any presentation, hash or callback.
    pub(super) fn validate_reply(
        &self,
        reply: &WorkReply,
        decoder: &EntityDecoder,
        router: &GeometryRouter,
    ) -> Result<(), WorkError> {
        if self.scopes.is_none() {
            return Err(WorkError::Aborted);
        }
        self.protocol.before_accept(reply)?;
        let owner = self.owner.as_ref().ok_or(WorkError::WrongOwner)?.validate(decoder, router)?;
        if owner != reply.owner {
            return Err(WorkError::WrongOwner);
        }
        Ok(())
    }

    /// Validate, then present. A refused reply comes back intact so its
    /// actual owner can still accept it.
    pub fn accept(
        &mut self,
        reply: WorkReply,
        ctx: &MeshProductionContext<'_>,
        decoder: &mut EntityDecoder,
        router: &GeometryRouter,
    ) -> Result<(), Box<RejectedReply>> {
        if let Err(error) = self.validate_reply(&reply, decoder, router) {
            return Err(Box::new(RejectedReply { error, reply }));
        }
        if let WorkPayload::Stopped(stop) = &reply.payload {
            self.remember_stop(*stop);
        }
        if self.capture_stop() {
            self.protocol.accepted();
            return Ok(());
        }
        let Some(scopes) = self.scopes.take() else {
            return Err(Box::new(RejectedReply { error: WorkError::Aborted, reply }));
        };
        // Presentation runs under the product's scopes and the owner validated
        // above, without a work epoch of its own.
        let mut scopes = ActiveScopes::new(scopes);
        scopes.with_scope(|| self.accept_slice(reply, ctx, decoder, router));
        self.scopes = Some(scopes.complete());
        Ok(())
    }

    /// Run one ticket through request, execute and accept.
    pub fn advance(
        &mut self,
        ctx: &MeshProductionContext<'_>,
        decoder: &mut EntityDecoder,
        router: &GeometryRouter,
    ) -> Result<bool, WorkError> {
        let Some(request) = self.request()? else { return Ok(false) };
        let reply = self.execute(request, ctx, decoder, router)?;
        self.accept(reply, ctx, decoder, router).map_err(|rejected| rejected.error)?;
        Ok(true)
    }

    pub fn finish(mut self, decoder: &EntityDecoder, router: &GeometryRouter) -> Result<ProducedElementMeshes, WorkError> {
        if self.capture_stop() {
            return self.finish_stopped();
        }
        if self.scopes.is_none() {
            return Err(WorkError::Aborted);
        }
        if !matches!(self.stage, Stage::Complete) {
            return Err(WorkError::Unfinished);
        }
        self.protocol.idle()?;
        self.admit_owner(decoder, router)?;
        self.apply_fixed_color();
        let (Some(mut owner), Some(scopes)) = (self.owner.take(), self.scopes.take()) else {
            return Err(WorkError::Aborted);
        };
        let mut active = ActiveScopes::new(scopes);
        // Final hooks see the restored caller triangle order. Grant trusted
        // lexical ownership without installing the product's mode.
        let (drained, _) = owner.read_work(decoder, router, || active.with_scope(|| router.take_csg_failures_checked()))?;
        let mut scopes = active.complete();
        scopes.pending.publish_pending();
        match drained {
            Ok(failures) => Ok(self.publish(failures, scopes.degenerate.dropped())),
            Err(stop) => {
                self.remember_stop(stop);
                Ok(session_canonical::stopped_output())
            }
        }
    }

    /// Publish only the source evidence already accepted into this product's
    /// scopes; a stopped product runs no final hook and adopts nothing ambient.
    fn finish_stopped(mut self) -> Result<ProducedElementMeshes, WorkError> {
        self.protocol.idle()?;
        let Some(scopes) = &mut self.scopes else { return Err(WorkError::Aborted) };
        scopes.pending.publish_pending();
        Ok(session_canonical::stopped_output())
    }
}

impl<'j> OwnedProductExecution<'j> {
    /// Independent resumable products always use strict owner admission.
    pub fn new(
        job: &'j ElementMeshJob<'j>,
        context: &'j OwnedMeshProductionContext,
        opts: &MeshProductionOptions,
        decoder: &mut EntityDecoder,
        router: &GeometryRouter,
    ) -> Result<Self, WorkError> {
        context.validate_source().map_err(|_| WorkError::StaleSource)?;
        let admission = Admission { inherited: None, context: Some(context.id()) };
        let state = ProductState::plan(job, &context.borrowed(), opts, decoder, router, admission)?;
        Ok(Self { state, context })
    }

    pub fn request(&mut self) -> Result<Option<WorkRequest>, WorkError> {
        self.validate()?;
        self.state.request()
    }

    pub fn execute(
        &mut self,
        request: WorkRequest,
        decoder: &mut EntityDecoder,
        router: &GeometryRouter,
    ) -> Result<WorkReply, WorkError> {
        self.validate()?;
        self.state.execute(request, &self.context.borrowed(), decoder, router)
    }

    pub fn accept(
        &mut self,
        reply: WorkReply,
        decoder: &mut EntityDecoder,
        router: &GeometryRouter,
    ) -> Result<(), Box<RejectedReply>> {
        if let Err(error) = self.validate() {
            return Err(Box::new(RejectedReply { error, reply }));
        }
        self.state.accept(reply, &self.context.borrowed(), decoder, router)
    }

    pub fn advance(&mut self, decoder: &mut EntityDecoder, router: &GeometryRouter) -> Result<bool, WorkError> {
        let Some(request) = self.request()? else { return Ok(false) };
        let reply = self.execute(request, decoder, router)?;
        self.accept(reply, decoder, router).map_err(|rejected| rejected.error)?;
        Ok(true)
    }

    pub fn finish(self, decoder: &EntityDecoder, router: &GeometryRouter) -> Result<ProducedElementMeshes, WorkError> {
        self.validate()?;
        let context = self.context;
        let result = self.state.finish(decoder, router)?;
        // A final diagnostic callback may explicitly invalidate the model.
        context.validate_source().map_err(|_| WorkError::StaleSource)?;
        Ok(result)
    }
}
