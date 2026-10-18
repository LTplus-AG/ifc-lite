// SPDX-License-Identifier: MPL-2.0
//! Platform extraction invariants: only admitted, once-executed real work may
//! mutate canonical product presentation and hashing.
use super::*;
use super::session::ProductState;
use super::session_protocol::{WorkEmitter, WorkError, WorkKind, WorkPayload};
use super::session_tests::{Context, SOURCE, assert_same, canonical, job, metadata, options, router};
use ifc_lite_core::IfcSchema;
use ifc_lite_geometry::{GeometryProcessor, ProcessorEmitterOrigin, TessellationQuality};
use ifc_lite_geometry::ExtrudedAreaSolidProcessor;
use std::{cell::Cell, rc::Rc};

struct CountingExtrusion(Rc<Cell<usize>>);
impl GeometryProcessor for CountingExtrusion {
    fn supported_types(&self)->Vec<IfcType> { vec![IfcType::IfcExtrudedAreaSolid] }
    fn process(&self, entity:&DecodedEntity, decoder:&mut EntityDecoder,
        schema:&IfcSchema, quality:TessellationQuality)->ifc_lite_geometry::Result<Mesh> {
        self.0.set(self.0.get()+1);
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity,decoder,schema,quality)
    }
}
struct Harness {
    decoder:EntityDecoder<'static>, router:GeometryRouter, context:Context, calls:Rc<Cell<usize>>,
}
impl Harness {
    fn new()->Self {
        let mut decoder=EntityDecoder::new(SOURCE);
        let mut router=router(&mut decoder);
        let calls=Rc::new(Cell::new(0));
        router.register(Box::new(CountingExtrusion(calls.clone())));
        Self { decoder,router,context:Context::default(),calls }
    }
    fn session(&mut self,id:u32)->ProductState {
        let entity=self.decoder.decode_by_id(id).unwrap();
        let metadata=metadata(id);
        ProductState::new(&job(&entity,&metadata),&self.context.borrowed(),&options(),
            &mut self.decoder,&self.router)
    }
    fn complete(&mut self,mut session:ProductState,id:u32) {
        while session.advance(&self.context.borrowed(),&mut self.decoder,&self.router) {}
        let actual=session.finish(&self.decoder,&self.router);
        assert_same(&actual,&canonical(id,false));
        assert!((actual.geometry_volume.unwrap()-if id==10 {24.}else{4.}).abs()<1e-5);
    }
}
fn unassembled(session:&ProductState) {
    assert!(session.meshes.is_empty());
    assert!(session.occurrences.is_empty());
    assert!(session.hasher.as_ref().unwrap().is_empty());
}

#[test]
fn forged_and_duplicate_execution_never_reenter_registered_geometry() {
    let mut h=Harness::new();
    let mut session=h.session(10);
    let request=session.request().unwrap().unwrap();
    assert_eq!(session.request().unwrap_err(),WorkError::Outstanding);
    let mut forged=request;
    forged.sequence+=1;
    assert_eq!(session.execute(forged,&h.context.borrowed(),&mut h.decoder,&h.router).err(),Some(WorkError::StaleTicket));
    forged=request; forged.kind=WorkKind::PlainParts;
    assert_eq!(session.execute(forged,&h.context.borrowed(),&mut h.decoder,&h.router).err(),Some(WorkError::StaleTicket));
    assert_eq!(h.calls.get(),0);
    unassembled(&session);
    let reply=session.execute(request,&h.context.borrowed(),&mut h.decoder,&h.router).unwrap();
    assert_eq!(h.calls.get(),1,"one admitted real extrusion");
    assert_eq!(session.execute(request,&h.context.borrowed(),&mut h.decoder,&h.router).err(),Some(WorkError::AlreadyExecuted));
    assert_eq!(h.calls.get(),1,"duplicate execution cannot warm a cache or call the extension");
    session.accept(reply,&h.context.borrowed(),&mut h.decoder,&h.router).unwrap();
    h.complete(session,10);
}

#[test]
fn rejected_emitter_trace_and_payload_return_the_original_real_packet_for_retry() {
    let mut h=Harness::new();
    let mut session=h.session(10);
    let request=session.request().unwrap().unwrap();
    let mut reply=session.execute(request,&h.context.borrowed(),&mut h.decoder,&h.router).unwrap();
    assert!(!reply.registry_emitters.is_empty(),"capture must witness the actual delegate");
    assert!(reply.registry_emitters.iter().any(|e|e.origin()==ProcessorEmitterOrigin::Custom&&e.family().is_none()));
    let emitter=reply.emitter;
    reply.emitter=WorkEmitter::PlainParts;
    let rejected=session.accept(reply,&h.context.borrowed(),&mut h.decoder,&h.router).unwrap_err();
    assert_eq!(rejected.error,WorkError::WrongEmitter);
    unassembled(&session);
    let mut reply=rejected.reply;
    reply.emitter=emitter;
    let trace=std::mem::take(&mut reply.registry_emitters);
    let rejected=session.accept(reply,&h.context.borrowed(),&mut h.decoder,&h.router).unwrap_err();
    assert_eq!(rejected.error,WorkError::WrongEmitter);
    unassembled(&session);
    let mut reply=rejected.reply;
    reply.registry_emitters=trace;
    let payload=std::mem::replace(&mut reply.payload,WorkPayload::PlainParts(Vec::new()));
    let rejected=session.accept(reply,&h.context.borrowed(),&mut h.decoder,&h.router).unwrap_err();
    assert_eq!(rejected.error,WorkError::WrongPayload);
    unassembled(&session);
    let mut reply=rejected.reply;
    reply.payload=payload;
    session.accept(reply,&h.context.borrowed(),&mut h.decoder,&h.router).unwrap();
    assert_eq!(h.calls.get(),1);
    h.complete(session,10);
}

#[test]
fn wrong_decoder_and_router_cannot_assemble_but_legitimate_owner_can_retry() {
    let mut h=Harness::new();
    let mut wrong=Harness::new();
    let mut session=h.session(10);
    let request=session.request().unwrap().unwrap();
    let reply=session.execute(request,&h.context.borrowed(),&mut h.decoder,&h.router).unwrap();
    let rejected=session.accept(reply,&h.context.borrowed(),&mut wrong.decoder,&h.router).unwrap_err();
    assert_eq!(rejected.error,WorkError::WrongOwner);
    unassembled(&session);
    let rejected=session.accept(rejected.reply,&h.context.borrowed(),&mut h.decoder,&wrong.router).unwrap_err();
    assert_eq!(rejected.error,WorkError::WrongOwner);
    unassembled(&session);
    session.accept(rejected.reply,&h.context.borrowed(),&mut h.decoder,&h.router).unwrap();
    assert_eq!(h.calls.get(),1);
    h.complete(session,10);
}

#[test]
fn changed_quality_invalidates_packet_before_hashing_and_drop_releases_owners() {
    let mut h=Harness::new();
    let mut session=h.session(10);
    let request=session.request().unwrap().unwrap();
    let reply=session.execute(request,&h.context.borrowed(),&mut h.decoder,&h.router).unwrap();
    h.router.set_tessellation_quality(TessellationQuality::Low);
    let rejected=session.accept(reply,&h.context.borrowed(),&mut h.decoder,&h.router).unwrap_err();
    assert_eq!(rejected.error,WorkError::WrongOwner);
    unassembled(&session);
    assert_eq!(h.calls.get(),1);
    drop(rejected);
    drop(session);
    // This rectangular extrusion has no quality-dependent curves. A new
    // generation must still publish the same canonical volume and hash.
    let session=h.session(10);
    h.complete(session,10);
}

#[test]
fn competing_live_product_is_rejected_before_callback_and_can_resume_after_drop() {
    let mut h=Harness::new();
    let mut first=h.session(10);
    let mut second=h.session(20);
    let first_request=first.request().unwrap().unwrap();
    let second_request=second.request().unwrap().unwrap();
    let reply=first.execute(first_request,&h.context.borrowed(),&mut h.decoder,&h.router).unwrap();
    let calls=h.calls.get();
    assert_eq!(second.execute(second_request,&h.context.borrowed(),&mut h.decoder,&h.router).err(),Some(WorkError::OwnerBusy));
    assert_eq!(h.calls.get(),calls);
    unassembled(&second);
    drop(reply); drop(first);
    let reply=second.execute(second_request,&h.context.borrowed(),&mut h.decoder,&h.router).unwrap();
    second.accept(reply,&h.context.borrowed(),&mut h.decoder,&h.router).unwrap();
    h.complete(second,20);
}

#[test]
fn partial_router_admission_error_releases_decoder_and_shared_decoder_reserves_no_other_router() {
    let mut h=Harness::new();
    let mut other=Harness::new();
    let mut first=h.session(10);
    let mut second=other.session(20);
    let request=first.request().unwrap().unwrap();
    let reply=first.execute(request,&h.context.borrowed(),&mut h.decoder,&h.router).unwrap();
    let request=second.request().unwrap().unwrap();
    assert_eq!(second.execute(request,&other.context.borrowed(),&mut other.decoder,&h.router).err(),Some(WorkError::OwnerBusy));
    // Failed acquisition of the occupied router must release the independently
    // acquired decoder; retry on its free router executes real slab geometry.
    let packet=second.execute(request,&other.context.borrowed(),&mut other.decoder,&other.router).unwrap();
    let mut third_decoder=EntityDecoder::new(SOURCE);
    let third_router=router(&mut third_decoder);
    let mut dormant={
        let mut spare=Harness::new();
        spare.session(20)
    };
    let third=dormant.request().unwrap().unwrap();
    assert_eq!(dormant.execute(third,&h.context.borrowed(),&mut h.decoder,&third_router).err(),Some(WorkError::OwnerBusy));
    // Decoder rejection precedes reserving the otherwise free router.
    let third_packet=dormant.execute(third,&h.context.borrowed(),&mut third_decoder,&third_router).unwrap();
    dormant.accept(third_packet,&h.context.borrowed(),&mut third_decoder,&third_router).unwrap();
    while dormant.advance(&h.context.borrowed(),&mut third_decoder,&third_router) {}
    assert_same(&dormant.finish(&third_decoder,&third_router),&canonical(20,false));
    second.accept(packet,&other.context.borrowed(),&mut other.decoder,&other.router).unwrap();
    other.complete(second,20);
    first.accept(reply,&h.context.borrowed(),&mut h.decoder,&h.router).unwrap();
    h.complete(first,10);
}

#[test]
fn stale_session_packet_and_previously_accepted_ticket_cannot_append_again() {
    let mut h=Harness::new();
    let mut other=Harness::new();
    let mut first=h.session(10);
    let mut second=other.session(20);
    let first_request=first.request().unwrap().unwrap();
    let second_request=second.request().unwrap().unwrap();
    assert_eq!(second.execute(first_request,&other.context.borrowed(),&mut other.decoder,&other.router).err(),Some(WorkError::StaleTicket));
    assert_eq!(other.calls.get(),0);
    let reply=first.execute(first_request,&h.context.borrowed(),&mut h.decoder,&h.router).unwrap();
    let rejected=second.accept(reply,&other.context.borrowed(),&mut other.decoder,&other.router).unwrap_err();
    assert_eq!(rejected.error,WorkError::StaleTicket);
    unassembled(&second);
    first.accept(rejected.reply,&h.context.borrowed(),&mut h.decoder,&h.router).unwrap();
    let positions=first.meshes[0].positions.clone();
    let count=first.meshes.len();
    let mut reply=second.execute(second_request,&other.context.borrowed(),&mut other.decoder,&other.router).unwrap();
    // Reusing an accepted ticket with another genuine packet must not append
    // anything. Restore its ticket afterwards and complete its rightful owner.
    reply.request=first_request;
    let rejected=first.accept(reply,&h.context.borrowed(),&mut h.decoder,&h.router).unwrap_err();
    assert_eq!(rejected.error,WorkError::StaleTicket);
    assert_eq!(first.meshes.len(),count);
    assert_eq!(first.meshes[0].positions,positions);
    let mut reply=rejected.reply; reply.request=second_request;
    second.accept(reply,&other.context.borrowed(),&mut other.decoder,&other.router).unwrap();
    h.complete(first,10);
    other.complete(second,20);
}
