// SPDX-License-Identifier: MPL-2.0
//! Real orphan-map execution keeps the coarse attempt open across inner work.
use super::*;
use super::owned_session::OwnedProductExecution;
use super::session_protocol::WorkError;
use super::session_tests::{SOURCE,router,options,metadata,job};

#[test]
fn type_attempt_pauses_and_rejects_before_consuming_its_inner_reply() {
    let mut decoder=EntityDecoder::new(SOURCE);
    let router=router(&mut decoder);
    let entity=decoder.decode_by_id(60).unwrap();
    let metadata=metadata(60);
    let mut job=job(&entity,&metadata);
    job.kind=ElementJobKind::TypeProduct {rep_maps:vec![(61,1)]};
    let context=ProductionModel::new().snapshot(OwnedMeshProductionData::default());
    let foreign=ProductionModel::new().snapshot(OwnedMeshProductionData::default());
    let mut execution=OwnedProductExecution::new(&job,&context,&options(),&mut decoder,&router).unwrap();
    let first=execution.request().unwrap().unwrap();
    assert!(first.inner.is_some());
    let mut reply=execution.execute(first,&mut decoder,&router).unwrap();
    assert!(matches!(execution.execute(first,&mut decoder,&router),Err(WorkError::AlreadyExecuted)));
    let original=reply.context;
    reply.context=Some(foreign.id());
    let rejected=execution.accept(reply,&mut decoder,&router).unwrap_err();
    assert_eq!(rejected.error,WorkError::WrongContext);
    let mut reply=rejected.reply;
    reply.context=original;
    execution.accept(reply,&mut decoder,&router).unwrap();
    let mut inner=1;
    let mut completed=0;
    while let Some(request)=execution.request().unwrap() {
        if request.inner.is_some() {inner+=1} else {completed+=1}
        let reply=execution.execute(request,&mut decoder,&router).unwrap();
        execution.accept(reply,&mut decoder,&router).unwrap();
    }
    assert!(inner>5,"source, constructor, merge and late origin must remain separate operations");
    assert_eq!(completed,1,"only a complete inner attempt reaches presentation");
    let output=execution.finish(&decoder,&router).unwrap();
    assert!(!output.meshes.is_empty());
    assert!(output.meshes.iter().all(|mesh|mesh.express_id==60 && !mesh.indices.is_empty()));
}

#[test]
fn product_with_dormant_inner_continuation_remains_send() {
    fn require_send<T:Send>() {}
    require_send::<OwnedProductExecution>();
}
