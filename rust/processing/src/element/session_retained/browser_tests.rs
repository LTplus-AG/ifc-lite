// SPDX-License-Identifier: MPL-2.0
//! P3 actual-module Worker witnesses. No supplied qualification or numerical replies.
//! Requires staged canonical /smlib assets; absence fails rather than skips.
use super::*;
use super::value::RealizationKind;
use super::super::{ElementJobKind, OwnedMeshProductionData, ProductionModel};
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry_runtime::browser::BrowserWorker;
use std::{future::Future, task::{Context, Poll, Waker}};
use wasm_bindgen_futures::JsFuture;
use wasm_bindgen_test::*;
wasm_bindgen_test_configure!(run_in_browser);

const SOURCE: &str = super::super::session_tests::SOURCE;
fn model(root: u32, statements: &str) -> (ProductionModel, Arc<OwnedMeshProductionContext>) {
    let source=SOURCE.replace("'SweptSolid',(#13)",&format!("'CSG',(#{root})"))
        .replace("ENDSEC;END-ISO-10303-21;",&format!("
        #90=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#13));
        #91=IFCREPRESENTATIONMAP(#5,#90);
        #92=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,1.,$);
        #93=IFCMAPPEDITEM(#91,#92);{statements}ENDSEC;END-ISO-10303-21;"));
    let model=ProductionModel::from_source(SourceBundle::new(source.into_bytes()));
    let context=model.snapshot(OwnedMeshProductionData::default());
    (model,context)
}
fn execution(context: &Arc<OwnedMeshProductionContext>, decoder: &mut EntityDecoder<'_>, router: &GeometryRouter)
    -> RetainedProductExecution {
    let entity=decoder.decode_by_id(10).unwrap();
    RetainedProductExecution::new(&ElementMeshJob {id:10,ifc_type:entity.ifc_type.clone(),entity:&entity,
        kind:ElementJobKind::Product,element_color:None,metadata:None},context,&MeshProductionOptions::default(),decoder,router).unwrap()
}
fn router(decoder: &mut EntityDecoder<'_>) -> GeometryRouter {
    let scale=decoder.length_unit_scale();let angle=decoder.plane_angle_to_radians();
    decoder.seed_unit_scales(scale,angle); GeometryRouter::with_scale(scale)
}
async fn worker() -> BrowserWorker {
    let mut worker=BrowserWorker::new_retained_execution().unwrap();
    worker.qualify().await.expect("actual same-module SDK qualification must execute");worker
}
async fn complete(execution: &mut RetainedProductExecution, worker: &mut BrowserWorker,
    decoder: &mut EntityDecoder<'_>, router: &GeometryRouter) {
    while let Some(issued)=execution.issue_next(worker,decoder,router).unwrap() {
        let work=issued.execute_browser(worker,0.001,15.,8_388_608).await.unwrap();
        execution.accept(work,decoder,router).unwrap();
    }
    execution.validate_witness().unwrap();
    assert!(!execution.traversal_plan().unwrap().remaining.is_empty(),"P4 obligations must survive P3 execution");
}
async fn reach(execution: &mut RetainedProductExecution, worker: &mut BrowserWorker,
    decoder: &mut EntityDecoder<'_>, router: &GeometryRouter, kind: &str) -> IssuedCommonConstruction {
    loop {
        let issued=execution.issue_next(worker,decoder,router).unwrap().expect("requested actual operation reached");
        let pending=&execution.pending.as_ref().unwrap().operations[0];
        if matches!((kind,pending),("construction",PendingRetainedOperation::Construction {..}) |
            ("affine",PendingRetainedOperation::Affine {..}) | ("boolean",PendingRetainedOperation::Boolean {..})) {return issued;}
        let work=issued.execute_browser(worker,0.001,15.,8_388_608).await.unwrap();
        execution.accept(work,decoder,router).unwrap();
    }
}
fn volume(mesh: &ifc_lite_geometry::document::RetainedTessellation) -> f64 {
    let p=|i:u32| {let i=i as usize*3;[mesh.positions[i],mesh.positions[i+1],mesh.positions[i+2]]};
    mesh.indices.chunks_exact(3).map(|t| {
        let [a,b,c]=[p(t[0]),p(t[1]),p(t[2])];
        (a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6.
    }).sum::<f64>().abs()
}

#[wasm_bindgen_test(async)]
async fn p3_nested_shared_mapped_boolean_binds_actual_empty_to_original_common_reply() {
    let mut worker=worker().await;
    let (_,context)=model(102,"#100=IFCBOOLEANRESULT(.DIFFERENCE.,#93,#93);
        #101=IFCBOOLEANRESULT(.UNION.,#100,#93);#102=IFCBOOLEANRESULT(.UNION.,#101,#101);");
    let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
    let mut execution=execution(&context,&mut decoder,&router);
    complete(&mut execution,&mut worker,&mut decoder,&router).await;
    assert_eq!(execution.ledger.iter().filter(|entry|matches!(entry.receipt.kind(),RealizationKind::Construction(_))).count(),1,
        "one actual source definition is shared by the mapped uses");
    let results:Vec<_>=execution.ledger.iter().filter_map(|entry|match entry.receipt.kind() {
        RealizationKind::Boolean(value)=>Some(value),_=>None }).collect();
    assert!(results.len()>=3);assert!(results[0].is_empty());
    let result=results.last().unwrap();assert!(!result.is_empty());
    assert!((volume(result.mesh())-24.).abs()<1e-6);
    assert!(!execution.traversal_plan().unwrap().values[0].is_empty());
}

#[wasm_bindgen_test(async)]
async fn p3_millimetres_survey_frames_and_repeated_affine_copy_preserve_occurrences() {
    let mut worker=worker().await;
    let (_,base)=model(100,"#100=IFCBOOLEANRESULT(.UNION.,#93,#93);");
    let source=String::from_utf8(base.source().unwrap().bytes().to_vec()).unwrap()
        .replace("$,.METRE.",".MILLI.,.METRE.")
        .replace("2.,4.","2000.,4000.").replace("#15,3.","#15,3000.")
        .replace("(10.,20.,30.)","(500000000.,200000000.,30000.)")
        .replace("#4,1.,$)","#4,2.,$)");
    let model=ProductionModel::from_source(SourceBundle::new(source.into_bytes()));
    let context=model.snapshot(OwnedMeshProductionData::default());
    let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
    let mut execution=execution(&context,&mut decoder,&router);
    complete(&mut execution,&mut worker,&mut decoder,&router).await;
    assert!(execution.ledger.iter().any(|e|matches!(e.receipt.kind(),RealizationKind::Affine(_))));
    let result=execution.ledger.iter().find_map(|e|match e.receipt.kind() {RealizationKind::Boolean(v)=>Some(v),_=>None}).unwrap();
    assert!((volume(result.mesh())-192.).abs()<1e-5,"one mm conversion and physical scale cubed");
    let plan=execution.traversal_plan().unwrap();
    assert_eq!(plan.values.len(),1);
    assert!(plan.values[0].world_from_source().is_none(),"operation has numerical identity, no fake construction recipe");
    let placement=plan.values[0].placements().iter().find(|placement|matches!(placement.stage,
        ifc_lite_geometry::program::RetainedPlacementStage::Product {product_id:10})).unwrap();
    assert_eq!(&placement.matrix[12..15],&[500000.,200000.,30.],"survey placement remains f64 metres");
}

#[wasm_bindgen_test(async)]
async fn p3_swapped_foreign_stale_duplicate_receipts_preserve_all_or_nothing_pending() {
    let mut worker=worker().await;
    let (_,context)=model(100,"#100=IFCBOOLEANRESULT(.DIFFERENCE.,#93,#93);");
    let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
    let mut execution=execution(&context,&mut decoder,&router);
    let issued=reach(&mut execution,&mut worker,&mut decoder,&router,"boolean").await;
    let work=issued.execute_browser(&mut worker,0.001,15.,8_388_608).await.unwrap();
    let before=execution.discharged_count();
    let (_,foreign)=model(13,"");let mut foreign_decoder=foreign.source().unwrap().decoder();
    let foreign_router=self::router(&mut foreign_decoder);let mut foreign_execution=self::execution(&foreign,&mut foreign_decoder,&foreign_router);
    let rejected=foreign_execution.accept(work,&mut foreign_decoder,&foreign_router).unwrap_err();
    assert_ne!(worker.incarnation(),0);assert!(execution.pending.as_ref().unwrap().reply.is_some());
    let mut work=rejected.work;
    let ticket=work.ticket.clone();work.ticket=Arc::new(());
    let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
    assert_eq!(execution.discharged_count(),before);let mut work=rejected.work;work.ticket=ticket;
    let stage=work.stage.clone();work.stage=Arc::new(AtomicU8::new(DELIVERED));
    let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();let mut work=rejected.work;work.stage=stage;
    let missing=work.realizations.pop().unwrap();
    let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();let mut work=rejected.work;work.realizations.push(missing);
    // Private test receipt envelope reuses actual sealed leases, never caller numerics.
    let duplicate=CompletedCommonConstruction {ticket:work.ticket.clone(),stage:work.stage.clone(),realizations:work.realizations.clone()};
    execution.accept(work,&mut decoder,&router).unwrap();
    assert!(execution.accept(duplicate,&mut decoder,&router).is_err());
    assert_eq!(execution.discharged_count(),before+1);
}

#[wasm_bindgen_test(async)]
async fn p3_affine_batch_swapped_outputs_reject_before_any_ledger_append() {
    let mut worker=worker().await;
    let (_,base)=model(93,"");
    let source=String::from_utf8(base.source().unwrap().bytes().to_vec()).unwrap()
        .replace("'SweptSolid',(#13)","'SweptSolid',(#13,#13)").replace("#4,1.,$)","#4,2.,$)");
    let model=ProductionModel::from_source(SourceBundle::new(source.into_bytes()));let context=model.snapshot(OwnedMeshProductionData::default());
    let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);let mut execution=execution(&context,&mut decoder,&router);
    let issued=reach(&mut execution,&mut worker,&mut decoder,&router,"affine").await;
    let mut work=issued.execute_browser(&mut worker,0.001,15.,8_388_608).await.unwrap();
    assert_eq!(work.realizations.len(),2);let before=execution.discharged_count();work.realizations.swap(0,1);
    let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();assert_eq!(execution.discharged_count(),before);
    assert!(execution.pending.as_ref().unwrap().reply.is_some());let mut work=rejected.work;work.realizations.swap(0,1);
    execution.accept(work,&mut decoder,&router).unwrap();
    complete(&mut execution,&mut worker,&mut decoder,&router).await;
}

#[wasm_bindgen_test(async)]
async fn p3_abandoned_unpolled_batch_and_prestart_cancellation_retire_only_captured_domain() {
    for poll in [false,true] {
        let mut worker=BrowserWorker::new_retained_execution().unwrap();
        let replacement=BrowserWorker::new_retained_execution().unwrap();
        let (_,context)=model(13,"");let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
        let mut execution=execution(&context,&mut decoder,&router);
        let issued=execution.issue_next(&worker,&mut decoder,&router).unwrap().unwrap();let cancellation=issued.cancellation();
        let mut future=Box::pin(issued.execute_browser(&mut worker,0.001,15.,8_388_608));
        if poll { cancellation.cancel();assert!(future.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_ready()); }
        drop(future);assert_eq!(worker.incarnation(),0);assert_ne!(replacement.incarnation(),0);
        assert!(execution.traversal_plan().is_none());
    }
}

#[wasm_bindgen_test(async)]
async fn p3_external_cancellation_after_actual_dispatch_15_5_18_invalidates_captured_domain() {
    for (kind,opcode,root,statements) in [
        ("construction",15,13,""),
        ("boolean",5,100,"#100=IFCBOOLEANRESULT(.DIFFERENCE.,#93,#93);"),
        ("affine",18,93,""),
    ] {
        let mut worker=worker().await;let replacement=BrowserWorker::new_retained_execution().unwrap();
        let (_,base)=model(root,statements);
        let source=String::from_utf8(base.source().unwrap().bytes().to_vec()).unwrap().replace("#4,1.,$)",if kind=="affine" {"#4,2.,$)"}else {"#4,1.,$)"});
        let source=if kind=="affine" {source.replace("'SweptSolid',(#13)","'SweptSolid',(#13,#13)")}else {source};
        let model=ProductionModel::from_source(SourceBundle::new(source.into_bytes()));let context=model.snapshot(OwnedMeshProductionData::default());
        let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);let mut execution=execution(&context,&mut decoder,&router);
        let issued=reach(&mut execution,&mut worker,&mut decoder,&router,kind).await;
        if kind=="affine" {assert_eq!(issued.operations.len(),2,"ordered multi-operation batch is pending");}
        let cancellation=issued.cancellation();
        let domain=worker.cancellation();let observation=domain.observe_dispatch(opcode);
        let mut future=Box::pin(issued.execute_browser(&mut worker,0.001,15.,8_388_608));
        assert!(matches!(future.as_mut().poll(&mut Context::from_waker(Waker::noop())),Poll::Pending));
        assert!(decoder.try_execution_lease().is_err(),"dormant original decoder reservation remains held");
        assert!(router.try_execution_lease().is_err());
        assert_eq!(JsFuture::from(observation).await.unwrap().as_f64(),Some(opcode as f64));
        let next=if kind=="affine" {Some(domain.observe_dispatch(18))}else {None};
        cancellation.cancel();
        if let Some(next)=next {assert!(JsFuture::from(next).await.is_err(),"second numerical operation was never submitted");}
        assert!(future.await.is_err());assert_eq!(worker.incarnation(),0);assert_ne!(replacement.incarnation(),0);
        assert!(execution.traversal_plan().is_none());
    }
}

#[wasm_bindgen_test(async)]
async fn p3_expiry_external_cancellation_and_resource_first_fault_after_actual_delivery() {
    use ifc_lite_geometry::resource::{ExecutionAccount,ExecutionPolicy,ResourceLimits};
    for mode in ["source","cancel","resources"] {
        let mut worker=worker().await;let (model,context)=model(13,"");
        let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
        let account=ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
        let mut execution=account.scope(||execution(&context,&mut decoder,&router));
        let issued=execution.issue_next(&worker,&mut decoder,&router).unwrap().unwrap();let cancellation=issued.cancellation();
        let work=issued.execute_browser(&mut worker,0.001,15.,8_388_608).await.unwrap();
        match mode {"source"=>model.invalidate_source(),"cancel"=>cancellation.cancel(),_=>account.cancel()}
        let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
        if mode=="resources" {assert!(matches!(rejected.reason,RetainedExecutionError::Stopped(ProgramStop::Cancelled)));}
        assert_eq!(execution.discharged_count(),0);assert!(execution.pending.as_ref().unwrap().reply.is_some());
        assert!(execution.traversal_plan().is_none());
    }
}

#[wasm_bindgen_test(async)]
async fn p3_actual_foreign_worker_receipt_and_wrong_boolean_operation_are_intact_rejections() {
    let mut worker=worker().await;let mut foreign=self::worker().await;
    let (_,context)=model(100,"#100=IFCBOOLEANRESULT(.DIFFERENCE.,#93,#93);");
    let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);let mut execution=execution(&context,&mut decoder,&router);
    let issued=execution.issue_next(&worker,&mut decoder,&router).unwrap().unwrap();
    let mut work=issued.execute_browser(&mut worker,0.001,15.,8_388_608).await.unwrap();
    let (_,other)=model(13,"");let mut other_decoder=other.source().unwrap().decoder();let other_router=self::router(&mut other_decoder);
    let mut other_execution=self::execution(&other,&mut other_decoder,&other_router);
    let other_issued=other_execution.issue_next(&foreign,&mut other_decoder,&other_router).unwrap().unwrap();
    let other_work=other_issued.execute_browser(&mut foreign,0.001,15.,8_388_608).await.unwrap();
    let own=std::mem::replace(&mut work.realizations[0],other_work.realizations[0].clone());
    let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
    assert_eq!(execution.discharged_count(),0);assert!(execution.pending.as_ref().unwrap().reply.is_some());
    assert_ne!(worker.incarnation(),0);assert_ne!(foreign.incarnation(),0);
    let mut work=rejected.work;work.realizations[0]=own;execution.accept(work,&mut decoder,&router).unwrap();
    other_execution.accept(other_work,&mut other_decoder,&other_router).unwrap();
    let issued=reach(&mut execution,&mut worker,&mut decoder,&router,"boolean").await;
    let mut work=issued.execute_browser(&mut worker,0.001,15.,8_388_608).await.unwrap();
    let PendingRetainedOperation::Boolean {expected,inputs}=&execution.pending.as_ref().unwrap().operations[0] else {panic!("Boolean")};
    let ifc_lite_geometry::program::RetainedOperationKind::Boolean {inputs:values,..}=expected.kind() else {panic!("Boolean")};
    let wrong=worker.evaluate_retained_boolean(inputs[0].dependency(&values[0]).unwrap(),inputs[1].dependency(&values[1]).unwrap(),
        ifc_lite_geometry::document::BooleanOperation::Union,0.001,15.,8_388_608).await.unwrap();
    let original=std::mem::replace(&mut work.realizations[0],Arc::new(CommonRetainedRealization::new(
        RealizationKind::Boolean(Box::new(wrong)),execution.resources.clone())));
    let before=execution.discharged_count();let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
    assert_eq!(execution.discharged_count(),before);assert!(execution.pending.as_ref().unwrap().reply.is_some());
    let mut work=rejected.work;work.realizations[0]=original;execution.accept(work,&mut decoder,&router).unwrap();
    complete(&mut execution,&mut worker,&mut decoder,&router).await;
    assert!(execution.traversal_plan().unwrap().values[0].is_empty());
}

#[wasm_bindgen_test(async)]
async fn p3_unrelated_callback_resource_stop_during_actual_await_cannot_replace_captured_account() {
    use ifc_lite_geometry::resource::{self,Cost,ExecutionAccount,ExecutionPolicy,ResourceLimits};
    let mut worker=worker().await;let (_,context)=model(13,"");
    let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
    let captured=ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let unrelated=ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {work:Some(0),..Default::default()}));
    let mut execution=captured.scope(||execution(&context,&mut decoder,&router));
    let issued=execution.issue_next(&worker,&mut decoder,&router).unwrap().unwrap();
    let observation=worker.cancellation().observe_dispatch(15);
    let mut future=Box::pin(issued.execute_browser(&mut worker,0.001,15.,8_388_608));
    assert!(matches!(unrelated.scope(||future.as_mut().poll(&mut Context::from_waker(Waker::noop()))),Poll::Pending));
    assert!(unrelated.check().is_ok(),"preflight charged only the captured account");
    assert!(!matches!(decoder.try_source_execution_lease(),Ok(Some(_))),"dormant owner/TLS source access was restored before await");
    assert_eq!(JsFuture::from(observation).await.unwrap().as_f64(),Some(15.));
    unrelated.scope(||assert!(resource::charge(Cost {work:1,..Default::default()}).is_err()));
    assert!(unrelated.check().is_err());assert!(captured.check().is_ok());
    let work=future.await.unwrap();execution.accept(work,&mut decoder,&router).unwrap();
    complete(&mut execution,&mut worker,&mut decoder,&router).await;
    assert!(captured.usage().work>0);assert!(captured.check().is_ok());
}

#[wasm_bindgen_test(async)]
async fn p3_captured_resource_stop_while_actual_worker_awaits_wins_over_transport_cancellation() {
    use ifc_lite_geometry::resource::{ExecutionAccount,ExecutionPolicy,ResourceLimits};
    for source_expiry in [false,true] {
    let mut worker=worker().await;let (model,context)=model(13,"");
    let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
    let account=ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let mut execution=account.scope(||execution(&context,&mut decoder,&router));
    let issued=execution.issue_next(&worker,&mut decoder,&router).unwrap().unwrap();
    let observation=worker.cancellation().observe_dispatch(15);
    let mut future=Box::pin(issued.execute_browser(&mut worker,0.001,15.,8_388_608));
    assert!(matches!(future.as_mut().poll(&mut Context::from_waker(Waker::noop())),Poll::Pending));
    assert_eq!(JsFuture::from(observation).await.unwrap().as_f64(),Some(15.));
    if source_expiry {model.invalidate_source();}else {account.cancel();}
    let rejected=future.await.unwrap_err();
    assert!(rejected.issued.is_none());
    if source_expiry {assert!(matches!(rejected.reason,RetainedExecutionError::Source));}
    else {assert!(matches!(rejected.reason,RetainedExecutionError::Stopped(ProgramStop::Cancelled)));}
    assert_eq!(worker.incarnation(),0);assert_eq!(execution.discharged_count(),0);
    assert!(execution.pending.as_ref().unwrap().reply.is_some());assert!(execution.traversal_plan().is_none());
    }
}

#[path = "predispatch_browser_tests.rs"]
mod predispatch;
