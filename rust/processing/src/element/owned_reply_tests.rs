// SPDX-License-Identifier: MPL-2.0
//! Real packets cannot switch model snapshots or complete an expired source.
use super::*;
use super::owned_session::OwnedProductExecution;
use super::session_protocol::WorkError;
use super::session_tests::{SOURCE,assert_same,canonical,job,metadata,options,router};

#[test]
fn foreign_context_request_and_reply_are_rejected_intact_before_geometry_or_hash_mutation() {
    let model=ProductionModel::new();
    let a=model.snapshot(OwnedMeshProductionData::default());
    let b=model.snapshot(OwnedMeshProductionData::default());
    let mut decoder=EntityDecoder::new(SOURCE);let router=router(&mut decoder);
    let entity=decoder.decode_by_id(10).unwrap();
    let mut session=OwnedProductExecution::new(&job(&entity,&metadata(10)),&a,&options(),&mut decoder,&router).unwrap();
    let request=session.request().unwrap().unwrap();
    let mut foreign=request;foreign.context=Some(b.id());
    assert_eq!(session.execute(foreign,&mut decoder,&router).err(),Some(WorkError::WrongContext));
    assert!(decoder.try_execution_lease().is_ok(),"forged request never reached owner/cache admission");
    let admitted=session.execute(request,&mut decoder,&router).unwrap();
    session.accept(admitted,&mut decoder,&router).unwrap();
    let request=loop {
        let request=session.request().unwrap().unwrap();
        if request.inner.is_none() { break request }
        let reply=session.execute(request,&mut decoder,&router).unwrap();
        session.accept(reply,&mut decoder,&router).unwrap();
    };
    let mut reply=session.execute(request,&mut decoder,&router).unwrap();
    let positions=match &reply.payload {super::session_protocol::WorkPayload::Primary(super::session_work::PrimaryOutcome::Candidate(parts))=>{
        assert!(!parts.sub_meshes.is_empty());true},_=>false};
    assert!(positions,"fixture must deliver real geometry");
    reply.context=Some(b.id());
    let rejected=session.accept(reply,&mut decoder,&router).unwrap_err();
    assert_eq!(rejected.error,WorkError::WrongContext);
    assert!(session.state.meshes.is_empty());
    assert!(session.state.hasher.as_ref().unwrap().is_empty());
    assert_eq!(rejected.reply.context,Some(b.id()),"rejection returns the actual unconsumed packet");
    let mut reply=rejected.reply;reply.context=Some(a.id());
    session.accept(reply,&mut decoder,&router).unwrap();
    while session.advance(&mut decoder,&router).unwrap() {}
    assert_same(&session.finish(&decoder,&router).unwrap(),&canonical(10,false));
}

#[test]
fn source_expiry_returns_real_pending_packet_and_dropping_session_releases_runtime_owners() {
    let model=ProductionModel::new();let context=model.snapshot(OwnedMeshProductionData::default());
    let mut decoder=EntityDecoder::new(SOURCE);let router=router(&mut decoder);
    let entity=decoder.decode_by_id(10).unwrap();
    let mut session=OwnedProductExecution::new(&job(&entity,&metadata(10)),&context,&options(),&mut decoder,&router).unwrap();
    let request=session.request().unwrap().unwrap();
    let reply=session.execute(request,&mut decoder,&router).unwrap();
    model.invalidate_source();
    let rejected=session.accept(reply,&mut decoder,&router).unwrap_err();
    assert_eq!(rejected.error,WorkError::StaleSource);
    assert_eq!(rejected.reply.request,request);
    assert_eq!(rejected.reply.context,Some(context.id()));
    assert!(session.state.meshes.is_empty());assert!(session.state.hasher.as_ref().unwrap().is_empty());
    assert!(decoder.try_execution_lease().is_err(),"expired work still owns its reservation until dropped");
    drop(rejected);drop(session);
    let fresh=model.snapshot(OwnedMeshProductionData::default());
    let actual=produce_element_meshes_owned(&job(&entity,&metadata(10)),&fresh,&options(),&mut decoder,&router).unwrap();
    assert_same(&actual,&canonical(10,false));
}
