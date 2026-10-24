// SPDX-License-Identifier: MPL-2.0
//! Only admitted, once-executed real work may mutate canonical product
//! presentation and hashing: foreign, out-of-order and duplicate packets are
//! refused before any callback, hash or cache access.
use super::session::ProductState;
use super::session_protocol::{WorkEmitter, WorkError, WorkKind, WorkPayload, WorkReply, WorkRequest};
use super::session_tests::{assert_same, canonical, complete, leaked_job, router, Context, SOURCE};
use super::*;
use ifc_lite_core::IfcSchema;
use ifc_lite_geometry::ExtrudedAreaSolidProcessor;
use ifc_lite_geometry::{GeometryProcessor, TessellationQuality};
use std::{cell::Cell, rc::Rc};

struct CountingExtrusion(Rc<Cell<usize>>);
impl GeometryProcessor for CountingExtrusion {
    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcExtrudedAreaSolid]
    }
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> ifc_lite_geometry::Result<Mesh> {
        self.0.set(self.0.get() + 1);
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity, decoder, schema, quality)
    }
}
struct Harness {
    decoder: EntityDecoder<'static>,
    router: GeometryRouter,
    context: Context,
    calls: Rc<Cell<usize>>,
}
impl Harness {
    fn new() -> Self {
        let mut decoder = EntityDecoder::new(SOURCE);
        let mut router = router(&mut decoder);
        let calls = Rc::new(Cell::new(0));
        router.register(Box::new(CountingExtrusion(calls.clone())));
        Self { decoder, router, context: Context::default(), calls }
    }
    fn session(&mut self, id: u32) -> ProductState<'static> {
        let job = leaked_job(&mut self.decoder, id);
        ProductState::new(job, &self.context.borrowed(), &super::session_tests::options(), &mut self.decoder, &self.router)
            .unwrap()
    }
    fn complete(&mut self, session: ProductState<'_>, id: u32) {
        let actual = complete(session, &self.context.borrowed(), &mut self.decoder, &self.router);
        assert_same(&actual, &canonical(id, false));
        assert!((actual.geometry_volume.unwrap() - if id == 10 { 24. } else { 4. }).abs() < 1e-5);
    }
}
fn unassembled(session: &ProductState<'_>) {
    assert!(session.meshes.is_empty());
    assert!(session.occurrences.is_empty());
    assert!(session.hasher.as_ref().unwrap().is_empty());
}

#[test]
fn forged_and_duplicate_execution_never_reenter_registered_geometry() {
    let mut h = Harness::new();
    let mut session = h.session(10);
    let request = session.request().unwrap().unwrap();
    assert_eq!(session.request().unwrap_err(), WorkError::Outstanding);
    let mut forged = request;
    forged.sequence += 1;
    assert_eq!(
        session.execute(forged, &h.context.borrowed(), &mut h.decoder, &h.router).err(),
        Some(WorkError::StaleTicket)
    );
    forged = request;
    forged.kind = WorkKind::PlainParts;
    assert_eq!(
        session.execute(forged, &h.context.borrowed(), &mut h.decoder, &h.router).err(),
        Some(WorkError::StaleTicket)
    );
    assert_eq!(h.calls.get(), 0);
    unassembled(&session);
    let reply = session.execute(request, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap();
    assert_eq!(h.calls.get(), 1, "one admitted real extrusion");
    assert_eq!(
        session.execute(request, &h.context.borrowed(), &mut h.decoder, &h.router).err(),
        Some(WorkError::AlreadyExecuted)
    );
    assert_eq!(h.calls.get(), 1, "duplicate execution cannot warm a cache or call the extension");
    session.accept(reply, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap();
    h.complete(session, 10);
}

#[test]
fn rejected_emitter_and_payload_return_the_original_real_packet_for_retry() {
    let mut h = Harness::new();
    let mut session = h.session(10);
    let request = session.request().unwrap().unwrap();
    let mut reply = session.execute(request, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap();
    let emitter = reply.emitter;
    assert_eq!(emitter, WorkEmitter::TexturedProduct, "the actual contextual dispatch site");
    reply.emitter = WorkEmitter::PlainParts;
    let rejected = session.accept(reply, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap_err();
    assert_eq!(rejected.error, WorkError::WrongEmitter);
    unassembled(&session);
    let mut reply = rejected.reply;
    reply.emitter = emitter;
    let payload = std::mem::replace(&mut reply.payload, WorkPayload::PlainParts(Vec::new()));
    let rejected = session.accept(reply, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap_err();
    assert_eq!(rejected.error, WorkError::WrongPayload);
    unassembled(&session);
    let mut reply = rejected.reply;
    reply.payload = payload;
    session.accept(reply, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap();
    assert_eq!(h.calls.get(), 1);
    h.complete(session, 10);
}

#[test]
fn accepting_before_execution_is_refused_without_presentation() {
    let mut h = Harness::new();
    let mut session = h.session(10);
    let request = session.request().unwrap().unwrap();
    let mut other = h.session(20);
    let other_request = other.request().unwrap().unwrap();
    let mut reply = other.execute(other_request, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap();
    let calls = h.calls.get();
    // A genuine packet relabelled with this session's unexecuted ticket.
    reply.request = request;
    let rejected = session.accept(reply, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap_err();
    assert_eq!(rejected.error, WorkError::NotExecuted);
    unassembled(&session);
    assert_eq!(h.calls.get(), calls);
    let mut reply = rejected.reply;
    reply.request = other_request;
    other.accept(reply, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap();
    h.complete(other, 20);
    let reply = session.execute(request, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap();
    session.accept(reply, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap();
    h.complete(session, 10);
}

#[test]
fn wrong_decoder_and_router_cannot_assemble_but_legitimate_owner_can_retry() {
    let mut h = Harness::new();
    let mut wrong = Harness::new();
    let mut session = h.session(10);
    let request = session.request().unwrap().unwrap();
    let reply = session.execute(request, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap();
    let rejected = session.accept(reply, &h.context.borrowed(), &mut wrong.decoder, &h.router).unwrap_err();
    assert_eq!(rejected.error, WorkError::WrongOwner);
    unassembled(&session);
    let rejected = session.accept(rejected.reply, &h.context.borrowed(), &mut h.decoder, &wrong.router).unwrap_err();
    assert_eq!(rejected.error, WorkError::WrongOwner);
    unassembled(&session);
    session.accept(rejected.reply, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap();
    assert_eq!(h.calls.get(), 1);
    h.complete(session, 10);
}

#[test]
fn changed_quality_invalidates_packet_before_hashing_and_drop_releases_owners() {
    let mut h = Harness::new();
    let mut session = h.session(10);
    let request = session.request().unwrap().unwrap();
    let reply = session.execute(request, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap();
    h.router.set_tessellation_quality(TessellationQuality::Low);
    let rejected = session.accept(reply, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap_err();
    assert_eq!(rejected.error, WorkError::WrongOwner);
    unassembled(&session);
    assert_eq!(h.calls.get(), 1);
    drop(rejected);
    drop(session);
    // This rectangular extrusion has no quality-dependent curves. A new
    // generation must still publish the same canonical volume and hash.
    let session = h.session(10);
    h.complete(session, 10);
}

#[test]
fn competing_live_product_is_rejected_before_callback_and_can_resume_after_drop() {
    let mut h = Harness::new();
    let mut first = h.session(10);
    let mut second = h.session(20);
    let first_request = first.request().unwrap().unwrap();
    let second_request = second.request().unwrap().unwrap();
    let reply = first.execute(first_request, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap();
    let calls = h.calls.get();
    assert_eq!(
        second.execute(second_request, &h.context.borrowed(), &mut h.decoder, &h.router).err(),
        Some(WorkError::OwnerBusy)
    );
    assert_eq!(h.calls.get(), calls);
    unassembled(&second);
    drop(reply);
    drop(first);
    let reply = second.execute(second_request, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap();
    second.accept(reply, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap();
    h.complete(second, 20);
}

#[test]
fn partial_router_admission_error_releases_decoder_and_shared_decoder_reserves_no_other_router() {
    let mut h = Harness::new();
    let mut other = Harness::new();
    let mut first = h.session(10);
    let mut second = other.session(20);
    let request = first.request().unwrap().unwrap();
    let reply = first.execute(request, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap();
    let request = second.request().unwrap().unwrap();
    assert_eq!(
        second.execute(request, &other.context.borrowed(), &mut other.decoder, &h.router).err(),
        Some(WorkError::OwnerBusy)
    );
    // Failed acquisition of the occupied router must release the independently
    // acquired decoder; retry on its free router executes real slab geometry.
    let packet = second.execute(request, &other.context.borrowed(), &mut other.decoder, &other.router).unwrap();
    let mut third_decoder = EntityDecoder::new(SOURCE);
    let third_router = router(&mut third_decoder);
    let mut spare = Harness::new();
    let mut dormant = spare.session(20);
    let third = dormant.request().unwrap().unwrap();
    assert_eq!(
        dormant.execute(third, &h.context.borrowed(), &mut h.decoder, &third_router).err(),
        Some(WorkError::OwnerBusy)
    );
    // Decoder rejection precedes reserving the otherwise free router.
    let third_packet = dormant.execute(third, &h.context.borrowed(), &mut third_decoder, &third_router).unwrap();
    dormant.accept(third_packet, &h.context.borrowed(), &mut third_decoder, &third_router).unwrap();
    let produced = complete(dormant, &h.context.borrowed(), &mut third_decoder, &third_router);
    assert_same(&produced, &canonical(20, false));
    second.accept(packet, &other.context.borrowed(), &mut other.decoder, &other.router).unwrap();
    other.complete(second, 20);
    first.accept(reply, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap();
    h.complete(first, 10);
}

#[test]
fn stale_session_packet_and_previously_accepted_ticket_cannot_append_again() {
    let mut h = Harness::new();
    let mut other = Harness::new();
    let mut first = h.session(10);
    let mut second = other.session(20);
    let first_request = first.request().unwrap().unwrap();
    let second_request = second.request().unwrap().unwrap();
    assert_eq!(
        second.execute(first_request, &other.context.borrowed(), &mut other.decoder, &other.router).err(),
        Some(WorkError::StaleTicket)
    );
    assert_eq!(other.calls.get(), 0);
    let reply = first.execute(first_request, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap();
    let rejected = second.accept(reply, &other.context.borrowed(), &mut other.decoder, &other.router).unwrap_err();
    assert_eq!(rejected.error, WorkError::StaleTicket);
    unassembled(&second);
    first.accept(rejected.reply, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap();
    let positions = first.meshes[0].positions.clone();
    let count = first.meshes.len();
    let mut reply = second.execute(second_request, &other.context.borrowed(), &mut other.decoder, &other.router).unwrap();
    // Reusing an accepted ticket with another genuine packet must not append
    // anything. Restore its ticket afterwards and complete its rightful owner.
    reply.request = first_request;
    let rejected = first.accept(reply, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap_err();
    assert_eq!(rejected.error, WorkError::StaleTicket);
    assert_eq!(first.meshes.len(), count);
    assert_eq!(first.meshes[0].positions, positions);
    let mut reply = rejected.reply;
    reply.request = second_request;
    second.accept(reply, &other.context.borrowed(), &mut other.decoder, &other.router).unwrap();
    h.complete(first, 10);
    other.complete(second, 20);
}

#[test]
fn publication_before_the_plan_completes_is_refused() {
    let mut h = Harness::new();
    let session = h.session(10);
    assert_eq!(session.finish(&h.decoder, &h.router).err(), Some(WorkError::Unfinished));
    let mut session = h.session(10);
    let request = session.request().unwrap().unwrap();
    let reply = session.execute(request, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap();
    drop(reply);
    assert_eq!(session.finish(&h.decoder, &h.router).err(), Some(WorkError::Unfinished));
    h.decoder.try_execution_lease().expect("refused publication releases the decoder");
    h.router.try_execution_lease().expect("refused publication releases the router");
}

/// The synchronous driver's own `execute_live` / `accept_live` refuse every
/// foreign, stale, duplicate, wrong-snapshot and wrong-owner packet before
/// any callback or stop, and the legitimate ticket still publishes canonically.
#[test]
fn live_epoch_refuses_forged_packets_through_the_shipped_checks() {
    use ifc_lite_geometry::resource::ProgramStop;
    let mut h = Harness::new();
    let job = leaked_job(&mut h.decoder, 10);
    let context = Context::default();
    let calls = h.calls.clone();
    let (decoder, router) = (&mut h.decoder, &h.router);
    // A stamp from an earlier, finished epoch on the same decoder and router.
    let mut foreign = None;
    session_run::run_epoch(decoder, router, None, |_, _, live| {
        foreign = Some(live.stamp);
        Ok(None)
    })
    .unwrap();
    let foreign = foreign.unwrap();
    let snapshot = ProductionModel::new().snapshot(OwnedMeshProductionData::default());
    let mut output = None;
    session_run::run_epoch(decoder, router, None, |decoder, router, live| {
        let ctx = context.borrowed();
        let mut state = ProductState::plan_live(job, &ctx, &super::session_tests::options(), decoder, router, live);
        let request = state.next_ticket().unwrap().unwrap();
        // One outstanding ticket at a time.
        assert_eq!(state.next_ticket().unwrap_err(), WorkError::Outstanding);
        assert_eq!(state.step_live(&ctx, decoder, router).unwrap_err(), WorkError::Outstanding);
        let refused = |forged: WorkRequest, state: &mut ProductState<'_>, decoder: &mut EntityDecoder| {
            state.execute_live(forged, &ctx, decoder, router).err()
        };
        let mut forged = request;
        forged.sequence += 1;
        assert_eq!(refused(forged, &mut state, decoder), Some(WorkError::StaleTicket));
        forged = request;
        forged.session += 1;
        assert_eq!(refused(forged, &mut state, decoder), Some(WorkError::StaleTicket), "another product's ticket");
        forged = request;
        forged.kind = WorkKind::PlainParts;
        assert_eq!(refused(forged, &mut state, decoder), Some(WorkError::StaleTicket));
        forged = request;
        forged.context = Some(snapshot.id());
        assert_eq!(refused(forged, &mut state, decoder), Some(WorkError::WrongContext));
        assert_eq!(calls.get(), 0, "no refused ticket reached the registered extrusion");
        unassembled(&state);
        // A forged stop reply is refused before its stop can poison the product.
        let stopped = |request: WorkRequest, owner| WorkReply {
            request,
            context: request.context,
            owner,
            emitter: request.kind.emitter(),
            payload: WorkPayload::Stopped(ProgramStop::Cancelled),
        };
        let accept = |reply, state: &mut ProductState<'_>, decoder: &mut EntityDecoder| {
            state.accept_live(reply, &ctx, decoder, router).err()
        };
        assert_eq!(accept(stopped(request, live.stamp), &mut state, decoder), Some(WorkError::NotExecuted));
        let reply = state.execute_live(request, &ctx, decoder, router).unwrap();
        assert_eq!(calls.get(), 1);
        assert_eq!(refused(request, &mut state, decoder), Some(WorkError::AlreadyExecuted));
        assert_eq!(calls.get(), 1, "a copied ticket cannot execute again");
        forged = request;
        forged.sequence += 1;
        assert_eq!(accept(stopped(forged, live.stamp), &mut state, decoder), Some(WorkError::StaleTicket));
        assert_eq!(accept(stopped(request, foreign), &mut state, decoder), Some(WorkError::WrongOwner));
        let mut wrong = stopped(request, live.stamp);
        wrong.context = Some(snapshot.id());
        assert_eq!(accept(wrong, &mut state, decoder), Some(WorkError::WrongContext));
        let mut wrong = stopped(request, live.stamp);
        wrong.emitter = WorkEmitter::PlainParts;
        assert_eq!(accept(wrong, &mut state, decoder), Some(WorkError::WrongEmitter));
        let mut wrong = stopped(request, live.stamp);
        wrong.payload = WorkPayload::PlainParts(Vec::new());
        assert_eq!(accept(wrong, &mut state, decoder), Some(WorkError::WrongPayload));
        assert_eq!(state.terminal(), None, "no refused stop reply reached the product");
        unassembled(&state);
        // The legitimate reply is still accepted, and the product completes.
        state.accept_live(reply, &ctx, decoder, router).unwrap();
        while state.step_live(&ctx, decoder, router)? {}
        state.finish_live(router, &mut output)
    })
    .unwrap();
    assert_eq!(h.calls.get(), 1);
    assert_same(&output.unwrap(), &canonical(10, false));
    assert!(h.decoder.try_execution_lease().is_ok() && h.router.try_execution_lease().is_ok());
}
