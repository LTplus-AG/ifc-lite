// SPDX-License-Identifier: MPL-2.0
//! Canonical owned product continuation with synchronous typed work admission.
//! This private protocol does not authorize asynchronous or remote execution.
use super::plan::PlanKind;
use super::session_owner::{OwnerStamp, ProductOwner};
use super::session_protocol::{Protocol, RejectedReply, WorkError, WorkKind, WorkReply, WorkRequest};
use super::session_state::{OwnedJob, Scopes, Stage, TriangleOrderScope};
use super::*;

pub(super) struct ProductState {
    pub(super) job: OwnedJob,
    pub(super) stage: Stage,
    pub(super) element_color: [f32; 4],
    pub(super) keep_order: bool,
    pub(super) scopes: Option<Scopes>,
    pub(super) hasher: Option<GeometryHasher>,
    pub(super) meshes: Vec<MeshData>,
    pub(super) occurrences: Vec<RawInstanceOccurrence>,
    pub(super) presentation_context: Option<std::sync::Arc<OwnedMeshProductionContext>>,
    pub(super) pending_geometry:Option<super::session_inner::PendingGeometryAttempt>,
    pub(super) protocol: Protocol,
    pub(super) retained_contract: Option<ifc_lite_geometry::program::RetainedContract>,
    pub(super) owner: Option<ProductOwner>,
    pending_adopted: bool,
    terminal: Option<ifc_lite_geometry::resource::ProgramStop>,
}

impl ProductState {
    pub fn new(job: &ElementMeshJob<'_>, ctx: &MeshProductionContext<'_>,
        opts: &MeshProductionOptions, decoder: &mut EntityDecoder, router: &GeometryRouter) -> Self {
        Self::new_with_owner(job, ctx, opts, decoder, router, None)
    }

    pub(super) fn new_canonical(job: &ElementMeshJob<'_>, ctx: &MeshProductionContext<'_>,
        opts: &MeshProductionOptions, decoder: &mut EntityDecoder, router: &GeometryRouter) -> Self {
        let inherited = session_canonical::inherited_owner(decoder, router)
            .expect("canonical synchronous ancestor owner");
        match inherited {
            Some(owner) => Self::new_with_owner(job, ctx, opts, decoder, router, Some(owner)),
            None => Self::new(job, ctx, opts, decoder, router),
        }
    }

    pub(super) fn new_with_owner(job: &ElementMeshJob<'_>, ctx: &MeshProductionContext<'_>,
        opts: &MeshProductionOptions, decoder: &mut EntityDecoder, router: &GeometryRouter,
        inherited: Option<ProductOwner>) -> Self {
        let preplanning_stop = ifc_lite_geometry::resource::check_current().err();
        let is_child = inherited.is_some();
        let mut planning_owner = inherited.unwrap_or_else(||
            ProductOwner::admit(decoder, router).expect("canonical product planning owner"));
        let mut scopes = session_state::ActiveScopes::new(Scopes::new());
        let (((plan, hasher, keep_order), terminal), _) = planning_owner.work(decoder, router, |decoder, router| scopes.with_scope(|| {
            if let Some(stop) = preplanning_stop {
                return ((plan::ElementPlan { kind: PlanKind::NoRepresentation,
                    element_color: [0.; 4] }, None, false), Some(stop));
            }
            ifc_lite_geometry::progress::tick();
            if let Err(stop) = ifc_lite_geometry::resource::check_current() {
                return ((plan::ElementPlan { kind: PlanKind::NoRepresentation,
                    element_color: [0.; 4] }, None, false), Some(stop));
            }
            let hasher = match (&job.kind, opts.geometry_hash) {
                (ElementJobKind::Product, Some(cfg)) => Some(GeometryHasher::new(cfg.tolerance, cfg.world_rtc)),
                _ => None,
            };
            let keep_order = !ctx.indexed_colour_full.is_empty()
                && element_color::element_reaches_indexed_colour(job.entity, ctx.indexed_colour_full, decoder);
            let order = TriangleOrderScope::new(router, keep_order);
            let plan = plan::plan_element(job, ctx, decoder, router);
            ((plan, hasher, order.finish()), ifc_lite_geometry::resource::check_current().err())
        })).expect("stable product planning owner");
        let stage = match plan.kind {
            PlanKind::NoRepresentation => Stage::Complete,
            PlanKind::TypeMaps(maps) => Stage::TypeMaps(maps.into_iter()),
            PlanKind::Product { primary, layer_class } => Stage::Primary { strategy: primary, layer_class },
        };
        planning_owner.validate(decoder, router).expect("stable product planning owner");
        let owner = if is_child { Some(planning_owner) } else { None };
        let scopes = scopes.complete();
        let mut state = Self { job: OwnedJob::new(job), stage, element_color: plan.element_color,
            keep_order, scopes: Some(scopes), hasher, meshes: Vec::new(), occurrences: Vec::new(),
            presentation_context: None, pending_geometry:None, protocol: Protocol::new(), retained_contract: None, owner, pending_adopted: false, terminal };
        if let Some(stop) = terminal { state.remember_stop(stop); }
        state
    }

    pub(super) fn bind_context(&mut self,id:ProductionContextId) {self.protocol.bind_context(id)}

    pub fn request(&mut self) -> Result<Option<WorkRequest>, WorkError> {
        assert!(self.scopes.is_some(), "aborted product execution cannot resume");
        self.protocol.idle()?;
        if self.capture_stop() { return Ok(None); }
        if let Some(attempt)=&mut self.pending_geometry {
            let inner=attempt.request();
            return Ok(Some(self.protocol.issue_inner(attempt.kind,inner)));
        }
        let kind = match &mut self.stage {
            Stage::Complete => return Ok(None),
            Stage::Primary { strategy, layer_class } => WorkKind::Primary {
                strategy: *strategy, layer_class: *layer_class },
            Stage::VoidedParts => WorkKind::VoidedParts,
            Stage::PlainParts => WorkKind::PlainParts,
            Stage::TypeMaps(maps) => match maps.next() {
                Some((map_id, class)) => WorkKind::TypeMap { map_id, class },
                None => { self.stage = Stage::Complete; return Ok(None); }
            },
        };
        let mut attempt=match self.retained_contract {
            Some(contract) => super::session_inner::PendingGeometryAttempt::retained(kind, &self.job, contract)?,
            None => super::session_inner::PendingGeometryAttempt::new(kind,&self.job),
        };
        let inner=attempt.request();
        self.pending_geometry=Some(attempt);
        Ok(Some(self.protocol.issue_inner(kind,inner)))
    }

    fn admit_owner(&mut self, decoder: &EntityDecoder, router: &GeometryRouter) -> Result<OwnerStamp, WorkError> {
        if self.owner.is_none() {
            let owner = ProductOwner::admit(decoder, router)?;
            self.owner = Some(owner);
        }
        let stamp = self.owner.as_ref().expect("admitted owner").validate(decoder, router)?;
        if !self.pending_adopted {
            // Adopt at first numerical admission, including a lexical child,
            // without adopting ambient curve/face diagnostics during planning.
            self.scopes.as_mut().expect("live scopes").pending.adopt_current_mapped();
            self.pending_adopted = true;
        }
        Ok(stamp)
    }

    pub fn execute(&mut self, request: WorkRequest, ctx: &MeshProductionContext<'_>,
        decoder: &mut EntityDecoder, router: &GeometryRouter) -> Result<WorkReply, WorkError> {
        if self.retained_contract.is_some() { return Err(WorkError::RetainedContract) }
        self.execute_admission(request, ctx, decoder, router).map(|(reply, _)| reply)
    }

    pub(super) fn execute_admission(&mut self, request: WorkRequest, ctx: &MeshProductionContext<'_>,
        decoder: &mut EntityDecoder, router: &GeometryRouter)
        -> Result<(WorkReply, Vec<ifc_lite_geometry::program::RetainedPlanOperation>), WorkError> {
        let mut retained_operation = Vec::new();
        assert!(self.scopes.is_some(), "aborted product execution cannot execute");
        self.protocol.before_execute(request)?;
        self.admit_owner(decoder, router)?;
        let mut owner = self.owner.take().expect("admitted product owner");
        let mut scopes = session_state::ActiveScopes::new(self.scopes.take().expect("live scopes"));
        let execution = owner.work(decoder, router, |decoder, router| scopes.with_scope(|| {
            let order = TriangleOrderScope::new(router, self.keep_order);
            let result = ifc_lite_geometry::ProcessorDispatchCapture::capture(|| {
                let result=if let Some(inner)=request.inner {
                    // Admit reply backing before any reached source/numerical
                    // callback. Refusal retains the dormant engine for terminal
                    // diagnostic cancellation instead of producing/dropping a reply.
                    let reservation = match ifc_lite_geometry::resource::charge(ifc_lite_geometry::resource::Cost {
                        live_bytes: std::mem::size_of::<ifc_lite_geometry::program::ProgramReply>() as u64,
                        ..Default::default()
                    }) {
                        Ok(reservation) => reservation,
                        Err(stop) => return Ok((request.kind.emitter(),
                            super::session_protocol::WorkPayload::Stopped(stop))),
                    };
                    let program = &mut self.pending_geometry.as_mut().expect("open geometry attempt").program;
                    let reply = if self.retained_contract.is_some() {
                        let (reply, operation) = program.admit_retained_with_inputs(inner, router, decoder,
                            Some(ctx.texture_index), Some(ctx.void_index)).map_err(WorkError::Geometry)?;
                        retained_operation = operation;
                        reply
                    } else {
                        program.execute_with_inputs(inner,router,decoder,Some(ctx.texture_index),Some(ctx.void_index)).expect("validated inner request")
                    };
                    (request.kind.emitter(),super::session_protocol::WorkPayload::GeometryStep(
                        super::session_protocol::AdmittedProgramReply::new(reply,reservation),None))
                } else if let Some(attempt)=self.pending_geometry.take() {
                    (request.kind.emitter(),attempt.finish(&self.job,router))
                } else { unreachable!("request owns an open geometry attempt") };
                Ok::<_, WorkError>(match ifc_lite_geometry::resource::check_current() {
                    Ok(())=>result,
                    Err(stop)=>match result {
                        (emitter,super::session_protocol::WorkPayload::GeometryStep(reply,_))=>
                            (emitter,super::session_protocol::WorkPayload::GeometryStep(reply,Some(stop))),
                        (emitter,_) =>(emitter,super::session_protocol::WorkPayload::Stopped(stop)),
                    },
                })
            });
            self.keep_order = order.finish();
            result
        }));
        // On failed owner commit the active scopes drop and poison the session;
        // never permit re-admission against this outstanding request.
        self.owner = Some(owner);
        let ((result, registry_emitters), owner) = execution?;
        self.scopes = Some(scopes.complete());
        let (emitter, payload) = result?;
        if let super::session_protocol::WorkPayload::Stopped(stop) = &payload { self.remember_stop(*stop); }
        self.protocol.executed(request, &registry_emitters);
        Ok((WorkReply { request, context:request.context, owner, emitter, registry_emitters, payload }, retained_operation))
    }

    pub fn accept(&mut self, reply: WorkReply, ctx: &MeshProductionContext<'_>,
        decoder: &mut EntityDecoder, router: &GeometryRouter) -> Result<(), Box<RejectedReply>> {
        if self.retained_contract.is_some() {
            return Err(Box::new(RejectedReply { error: WorkError::RetainedContract, reply }));
        }
        self.accept_admission(reply, ctx, decoder, router)
    }
    pub(super) fn accept_admission(&mut self, reply: WorkReply, ctx: &MeshProductionContext<'_>,
        decoder: &mut EntityDecoder, router: &GeometryRouter) -> Result<(), Box<RejectedReply>> {
        assert!(self.scopes.is_some(), "aborted product execution cannot accept");
        if let Err(error) = self.validate_reply(&reply, decoder, router) {
            return Err(Box::new(RejectedReply { error, reply }));
        }
        if let super::session_protocol::WorkPayload::Stopped(stop) = &reply.payload { self.remember_stop(*stop); }
        // A fresh authenticated source scope replaces ambient terminal TLS.
        // Preserve a validated reply's entrance cancellation across that boundary.
        let entrance_stop = ifc_lite_geometry::resource::check_current().err();
        if !matches!(reply.payload,super::session_protocol::WorkPayload::GeometryStep(_,_)) && self.capture_stop() {
            self.protocol.accepted();
            return Ok(());
        }
        let mut owner = self.owner.take().expect("validated product owner");
        let mut scopes = session_state::ActiveScopes::new(self.scopes.take().expect("live scopes"));
        let (terminal, _) = owner.work(decoder, router, |decoder, router| scopes.with_scope(|| {
            let order = TriangleOrderScope::new(router, self.keep_order);
            match reply.payload {
                super::session_protocol::WorkPayload::GeometryStep(inner,stop)=> {
                    // Source ancestry and the reply's first fault take precedence;
                    // accept the real inner reply before cancellation drains reports.
                    let stop=stop.or(entrance_stop).map(ifc_lite_geometry::resource::stop);
                    let program=&mut self.pending_geometry.as_mut().expect("open geometry attempt").program;
                    program.accept(inner.into_reply(),router).expect("validated inner reply");
                    if stop.is_some() || ifc_lite_geometry::resource::check_current().is_err() {
                        program.cancel_with_reports(router).expect("validated cancellation router");
                    }
                    if let Some(stop)=stop {ifc_lite_geometry::resource::stop(stop);}
                }
                payload=>self.assemble_reply(WorkReply {payload,..reply},ctx,decoder,router),
            }
            self.keep_order = order.finish();
            ifc_lite_geometry::resource::check_current().err()
        })).expect("accepted product assembly owner");
        if let Some(stop) = terminal { self.remember_stop(stop); }
        self.owner = Some(owner);
        self.scopes = Some(scopes.complete());
        self.protocol.accepted();
        Ok(())
    }

    pub(super) fn validate_reply(&self, reply: &WorkReply, decoder: &EntityDecoder,
        router: &GeometryRouter) -> Result<(), WorkError> {
        self.protocol.before_accept(reply)?;
        let owner = self.owner.as_ref().ok_or(WorkError::WrongOwner)?.validate(decoder, router)?;
        if owner != reply.owner { return Err(WorkError::WrongOwner); }
        if let super::session_protocol::WorkPayload::GeometryStep(inner,_)=&reply.payload {
            self.pending_geometry.as_ref().ok_or(WorkError::WrongPayload)?.program
                .validate_reply(inner,router).map_err(WorkError::Geometry)?;
        }
        Ok(())
    }

    pub(super) fn validate_retained_resources(&mut self, decoder: &EntityDecoder, router: &GeometryRouter) -> Result<(), WorkError> {
        if self.terminal.is_some() { return Err(WorkError::RetainedContract) }
        let owner = self.owner.as_mut().ok_or(WorkError::WrongOwner)?;
        let mut scopes = session_state::ActiveScopes::new(self.scopes.take().expect("retained validation scopes"));
        let (result, _) = owner.read_work(decoder, router, || scopes.with_scope(ifc_lite_geometry::resource::check_current))?;
        self.scopes = Some(scopes.complete());
        result.map_err(|_| WorkError::RetainedContract)
    }

    pub fn advance(&mut self, ctx: &MeshProductionContext<'_>, decoder: &mut EntityDecoder,
        router: &GeometryRouter) -> bool {
        let Some(request) = self.request().expect("canonical product request") else { return false; };
        let reply = self.execute(request, ctx, decoder, router).expect("canonical product work owner");
        self.accept(reply, ctx, decoder, router).expect("canonical product reply");
        true
    }

    pub fn finish(mut self, decoder: &EntityDecoder, router: &GeometryRouter) -> ProducedElementMeshes {
        assert!(self.retained_contract.is_none(), "retained product cannot publish through mesh assembly");
        if self.capture_stop() { return self.finish_stopped(decoder, router); }
        assert!(matches!(self.stage, Stage::Complete), "product work must finish before publication");
        assert!(self.scopes.is_some(), "aborted product execution cannot publish");
        self.protocol.idle().expect("outstanding product work cannot publish");
        self.admit_owner(decoder, router).expect("canonical product publication owner");
        if let Some(fixed) = crate::style::fixed_display_color_for_type(&self.job.ifc_type) {
            let fixed = fixed.to_array();
            for mesh in &mut self.meshes { mesh.color = fixed; mesh.texture = None; mesh.uvs = None; }
            for occurrence in &mut self.occurrences { occurrence.color = fixed; }
        }
        let mut owner = self.owner.take().expect("publication owner");
        let mut active = session_state::ActiveScopes::new(self.scopes.take().expect("finished scopes"));
        // Final hooks historically see restored caller triangle order. Grant
        // trusted lexical ownership without installing the product's mode.
        let ((csg_failures, terminal), _) = owner.read_work(decoder, router,
            || active.with_scope(|| {
                match router.take_csg_failures_checked() {
                    Ok(failures) => (failures, None),
                    Err(stop) => (FxHashMap::default(), Some(stop)),
                }
            }))
            .expect("stable product publication owner");
        let mut scopes = active.complete();
        scopes.pending.publish_pending();
        if let Some(stop) = terminal {
            self.remember_stop(stop);
            return session_canonical::stopped_output();
        }
        let dropped = scopes.degenerate.dropped();
        let (geometry_hash, geometry_aabb, geometry_volume, geometry_closure) = match self.hasher {
            Some(mut h) if !h.is_empty() => {
                h.retract_closure_if_mesh_edited(dropped);
                (Some(h.finish()), h.world_aabb(), h.volume(), Some(h.closure()))
            }
            _ => (None, None, None, None),
        };
        ProducedElementMeshes { meshes: self.meshes, instance_occurrences: self.occurrences,
            geometry_hash, geometry_aabb, geometry_volume, geometry_closure,
            csg_failures, degenerate_triangles_dropped: dropped }
    }

    /// A terminal fault belongs to this product across lexical owner epochs.
    /// Earlier independent cache/source effects survive; partial output does not.
    pub(super) fn remember_stop(&mut self, stop: ifc_lite_geometry::resource::ProgramStop) {
        let first = *self.terminal.get_or_insert(stop);
        ifc_lite_geometry::resource::stop(first);
        self.stage = Stage::Complete;
        // Keep the dormant continuation until diagnostic-only cancellation
        // can reinstall its actual product scopes and validate its owner.
        self.meshes.clear();
        self.occurrences.clear();
        self.hasher = None;
    }
    fn capture_stop(&mut self) -> bool {
        if let Some(stop) = self.terminal {
            self.remember_stop(stop);
            return true;
        }
        if let Err(stop) = ifc_lite_geometry::resource::check_current() {
            self.remember_stop(stop);
            return true;
        }
        false
    }
    fn finish_stopped(mut self, decoder: &EntityDecoder, router: &GeometryRouter) -> ProducedElementMeshes {
        assert!(self.scopes.is_some(), "aborted product execution cannot publish");
        self.protocol.idle().expect("outstanding product work cannot publish");
        // Do not adopt ambient diagnostics here: this terminal continuation owns
        // only the source evidence already accepted in its captured scopes.
        let mut owner = self.owner.take().unwrap_or_else(||
            ProductOwner::admit(decoder, router).expect("terminal diagnostic owner"));
        let mut active = session_state::ActiveScopes::new(self.scopes.take().expect("terminal scopes"));
        let mut attempt = self.pending_geometry.take();
        let keep_order = self.keep_order;
        owner.read_work(decoder, router, || active.with_scope(|| {
            let order = TriangleOrderScope::new(router, keep_order);
            if let Some(attempt) = &mut attempt { attempt.program.cancel_with_reports(router).expect("validated cancellation router"); }
            let _ = order.finish();
        })).expect("stable terminal diagnostic owner");
        let mut scopes = active.complete();
        scopes.pending.publish_pending();
        session_canonical::stopped_output()
    }

}

#[cfg(test)]
#[path = "session_terminal_tests.rs"]
mod terminal_tests;
