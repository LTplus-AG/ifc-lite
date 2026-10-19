// SPDX-License-Identifier: MPL-2.0
//! Actual module Worker/common STEP witnesses. UNCOMPILED/UNRUN in this change.
use super::*;
use super::browser_tests::{model,execution,router,worker,volume};
use super::value::RealizationKind;
use ifc_lite_geometry_runtime::browser::BrowserWorker;
use wasm_bindgen_test::*;

fn statements(operator:&str, agreement:&str,z:f64,tail:&str)->String {
    format!("#110=IFCCARTESIANPOINT((0.,0.,{z}));#111=IFCAXIS2PLACEMENT3D(#110,$,$);
        #112=IFCPLANE(#111);#113=IFCHALFSPACESOLID(#112,.{agreement}.);
        #100=IFCBOOLEANRESULT(.{operator}.,#93,#113);{tail}")
}
async fn reach(execution:&mut RetainedProductExecution, worker:&mut BrowserWorker,
    decoder:&mut EntityDecoder<'_>, router:&GeometryRouter)->IssuedCommonConstruction {
    loop {
        let issued=execution.issue_next(worker,decoder,router).unwrap().expect("actual clip reached");
        if matches!(execution.pending.as_ref().unwrap().operations[0],PendingRetainedOperation::UnaryClip {..}) {return issued;}
        let work=issued.execute_browser(worker,0.001,15.,8_388_608).await.unwrap();
        execution.accept(work,decoder,router).unwrap();
    }
}
#[wasm_bindgen_test(async)]
async fn p2_worker_plain_halfspace_both_sides_modes_keep_original_common_transaction() {
    let mut worker=worker().await;let mut volumes=[0.;2];
    for operator in ["DIFFERENCE","INTERSECTION"] {for agreement in ["T","F"] {
        let (_,context)=model(100,&statements(operator,agreement,1.,""));
        let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
        let mut oracle_decoder=context.source().unwrap().decoder();
        let oracle=if operator=="DIFFERENCE" {Some(super::clip_witness::exact_difference(&mut oracle_decoder))} else {None};
        let mut execution=execution(&context,&mut decoder,&router);
        let issued=reach(&mut execution,&mut worker,&mut decoder,&router).await;
        let outer=execution.pending.as_ref().unwrap().outer;
        let work=issued.execute_browser(&mut worker,0.001,15.,8_388_608).await.unwrap();
        let RealizationKind::UnaryClip(value)=work.realizations[0].kind() else {panic!("actual clip")};
        assert!(!value.is_empty());
        let upper=(operator=="DIFFERENCE")== (agreement=="T");
        let shape=super::clip_witness::assert_offcentre(&value.mesh().positions,&value.mesh().indices,upper);
        volumes[usize::from(agreement=="F")]+=shape.0;
        if let Some(oracle)=oracle {super::clip_witness::assert_same(shape,oracle);}
        assert_eq!(value.operation_identity().plane,[1.,2.,1.,0.,0.,1.]);
        assert_eq!(execution.pending.as_ref().unwrap().outer,outer);
        execution.accept(work,&mut decoder,&router).unwrap();
        assert!(execution.issue_next(&worker,&mut decoder,&router).unwrap().is_none());
        execution.validate_witness().unwrap();assert!(!execution.traversal_plan().unwrap().remaining.is_empty());
    }}
    assert!(volumes.iter().all(|v|(v-24.).abs()<1e-6),"Difference/Intersection must partition the original 24m3 host");
}
#[wasm_bindgen_test(async)]
async fn p2_worker_actual_empty_intersection_lazy_rhs_and_difference_hold() {
    let mut worker=worker().await;
    for (operator,z,tail) in [("INTERSECTION",-10.,"#101=IFCBOOLEANRESULT(.DIFFERENCE.,#100,#999);"),("DIFFERENCE",10.,"")] {
        let (_,context)=model(if tail.is_empty(){100}else{101},&statements(operator,"T",z,tail));
        let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
        let mut execution=execution(&context,&mut decoder,&router);
        let issued=reach(&mut execution,&mut worker,&mut decoder,&router).await;
        let before=execution.discharged_count();let outer=execution.pending.as_ref().unwrap().outer;
        let work=issued.execute_browser(&mut worker,0.001,15.,8_388_608).await.unwrap();
        let RealizationKind::UnaryClip(value)=work.realizations[0].kind() else {panic!("actual clip")};
        assert!(value.is_empty());
        if operator=="DIFFERENCE" {
            let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
            assert!(matches!(rejected.reason,RetainedExecutionError::Unsupported(ref e) if e.contains("full-host-removal")));
            assert_eq!(execution.discharged_count(),before);
            let pending=execution.pending.as_ref().unwrap();assert_eq!(pending.outer,outer);
            assert!(pending.reply.is_some());assert_eq!(pending.stage.load(Ordering::Acquire),DELIVERED);
            rejected.work.realizations[0].validate_live().unwrap();execution.ledger[0].receipt.validate_live().unwrap();
            assert!(execution.traversal_plan().is_none());
        } else {
            execution.accept(work,&mut decoder,&router).unwrap();
            assert!(execution.issue_next(&worker,&mut decoder,&router).unwrap().is_none());
            assert!(execution.traversal_plan().unwrap().values[0].is_empty());assert!(decoder.get_cached(999).is_none());
        }
    }
}
#[wasm_bindgen_test(async)]
async fn p2_worker_unary_foreign_receipt_and_replacement_frame_leave_original_reply_intact() {
    use ifc_lite_geometry_runtime::{PlaneSide,PlaneClipMode};
    use ifc_lite_geometry_runtime::browser::BrowserDependency;
    let mut worker=worker().await;let (_,context)=model(100,&statements("INTERSECTION","T",1.5,""));
    let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
    let mut execution=execution(&context,&mut decoder,&router);
    let issued=reach(&mut execution,&mut worker,&mut decoder,&router).await;
    let mut work=issued.execute_browser(&mut worker,0.001,15.,8_388_608).await.unwrap();
    let ticket=work.ticket.clone();work.ticket=Arc::new(());
    let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
    assert!(matches!(rejected.reason,RetainedExecutionError::Protocol(_)));
    let mut work=rejected.work;work.ticket=ticket;let original=work.realizations[0].clone();
    let frame=ifc_lite_geometry::math::mat4::col_major_array(&nalgebra::Matrix4::new_translation(&nalgebra::Vector3::new(100.,0.,0.)));
    let alternate=worker.clip_retained_plane(BrowserDependency::Source {
        realization:execution.ledger[0].receipt.construction().unwrap(),world_from_source:frame},
        [1.,2.,1.5,0.,0.,1.],PlaneSide::Negative,PlaneClipMode::Intersection,0.001,15.,8_388_608).await.unwrap();
    assert_eq!(alternate.operation_identity().input,execution.ledger[0].receipt.solid());
    work.realizations[0]=Arc::new(CommonRetainedRealization::new(RealizationKind::UnaryClip(Box::new(alternate)),execution.resources.clone()));
    let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
    assert!(matches!(rejected.reason,RetainedExecutionError::Protocol(ref e) if e.contains("frame mismatch")));
    assert!(execution.pending.as_ref().unwrap().reply.is_some());
    let mut work=rejected.work;work.realizations[0]=original;
    let original=work.realizations[0].clone();
    let alternate=worker.clip_retained_plane(BrowserDependency::Source {
        realization:execution.ledger[0].receipt.construction().unwrap(),
        world_from_source:ifc_lite_geometry::math::mat4::col_major_array(&nalgebra::Matrix4::identity())},
        [1.,2.,1.5,-0.,0.,1.],PlaneSide::Negative,PlaneClipMode::Intersection,0.001,15.,8_388_608).await.unwrap();
    assert_eq!(alternate.operation_identity().plane[3].to_bits(),(-0.0f64).to_bits());
    work.realizations[0]=Arc::new(CommonRetainedRealization::new(RealizationKind::UnaryClip(Box::new(alternate)),execution.resources.clone()));
    let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
    assert!(matches!(rejected.reason,RetainedExecutionError::Protocol(_)));
    assert!(execution.pending.as_ref().unwrap().reply.is_some());
    let mut work=rejected.work;work.realizations[0]=original;
    execution.accept(work,&mut decoder,&router).unwrap();
}
#[wasm_bindgen_test(async)]
async fn p2_worker_unary_stale_owner_rejects_before_pending_linear_take() {
    let mut worker=worker().await;let (_,context)=model(100,&statements("INTERSECTION","T",1.5,""));
    let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
    let mut execution=execution(&context,&mut decoder,&router);
    let issued=reach(&mut execution,&mut worker,&mut decoder,&router).await;
    let cancellation=issued.cancellation();let work=issued.execute_browser(&mut worker,0.001,15.,8_388_608).await.unwrap();
    let before=execution.discharged_count();cancellation.cancel();
    let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
    assert!(matches!(rejected.reason,RetainedExecutionError::Protocol(_)));
    assert_eq!(execution.discharged_count(),before);assert!(execution.pending.as_ref().unwrap().reply.is_some());
}

#[wasm_bindgen_test(async)]
async fn p2_worker_mapped_clip_uses_original_unary_and_binary_dependency_selectors() {
    let mut worker=worker().await;
    let tail="#101=IFCSHAPEREPRESENTATION(#2,'Body','CSG',(#100));#102=IFCREPRESENTATIONMAP(#5,#101);
        #103=IFCCARTESIANPOINT((100.,0.,0.));#104=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#103,1.,$);
        #105=IFCMAPPEDITEM(#102,#104);#120=IFCCARTESIANPOINT((0.,0.,0.75));
        #121=IFCAXIS2PLACEMENT3D(#120,$,$);#122=IFCPLANE(#121);#123=IFCHALFSPACESOLID(#122,.T.);
        #106=IFCBOOLEANRESULT(.DIFFERENCE.,#105,#123);#107=IFCBOOLEANRESULT(.UNION.,#105,#106);";
    let (_,context)=model(107,&statements("INTERSECTION","T",1.5,tail));
    let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
    let mut execution=execution(&context,&mut decoder,&router);let mut clips=0;let mut unions=0;
    while let Some(issued)=execution.issue_next(&worker,&mut decoder,&router).unwrap() {
        let work=issued.execute_browser(&mut worker,0.001,15.,8_388_608).await.unwrap();
        for value in work.realizations() {match value.kind() {
            RealizationKind::UnaryClip(v)=> {
                assert!((volume(v.mesh())-if clips==0 {12.} else {6.}).abs()<1e-6);
                assert_eq!(v.world_from_evaluation()[12],if clips==0 {-1.} else {99.});clips+=1;
            }
            RealizationKind::Boolean(v)=>{assert!((volume(v.mesh())-12.).abs()<1e-6);unions+=1;}
            _=>{},
        }}
        execution.accept(work,&mut decoder,&router).unwrap();
    }
    assert_eq!((clips,unions),(2,1));execution.validate_witness().unwrap();
}
#[wasm_bindgen_test(async)]
async fn p2_worker_unary_stale_source_epoch_retains_original_reply() {
    let mut worker=worker().await;let (model,context)=model(100,&statements("INTERSECTION","T",1.5,""));
    let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
    let mut execution=execution(&context,&mut decoder,&router);
    let issued=reach(&mut execution,&mut worker,&mut decoder,&router).await;
    let work=issued.execute_browser(&mut worker,0.001,15.,8_388_608).await.unwrap();let before=execution.discharged_count();
    model.invalidate_source();let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
    assert!(matches!(rejected.reason,RetainedExecutionError::Source));
    assert_eq!(execution.discharged_count(),before);assert!(execution.pending.as_ref().unwrap().reply.is_some());
}

#[wasm_bindgen_test(async)]
async fn p2_worker_issue_5314_source_edge_clip_obeys_existing_prism_integral() {
    use super::super::{ProductionModel,OwnedMeshProductionData,ElementJobKind};
    use ifc_lite_core::SourceBundle;
    let mut worker=worker().await;
    let source=include_str!("../../../../geometry/tests/fixtures/issue_5314_halfspace_edge.ifc");
    let model=ProductionModel::from_source(SourceBundle::new(source.as_bytes().to_vec()));
    let context=model.snapshot(OwnedMeshProductionData::default());let mut decoder=context.source().unwrap().decoder();
    let router=GeometryRouter::with_scale(0.001);let entity=decoder.decode_by_id(30).unwrap();
    let mut execution=RetainedProductExecution::new(&ElementMeshJob {id:30,ifc_type:entity.ifc_type.clone(),entity:&entity,
        kind:ElementJobKind::Product,element_color:None,metadata:None},&context,&MeshProductionOptions::default(),&mut decoder,&router).unwrap();
    let expected=(38.9995574951+88.99974823)*60.0004196167*(300.00067435-60.0004196167/2.)*1e-9;
    let mut clips=0;
    while let Some(issued)=execution.issue_next(&worker,&mut decoder,&router).unwrap() {
        let work=issued.execute_browser(&mut worker,0.00001,15.,8_388_608).await.unwrap();
        if let RealizationKind::UnaryClip(value)=work.realizations[0].kind() {
            assert!((volume(value.mesh())/expected-1.).abs()<1e-5);clips+=1;
        }
        execution.accept(work,&mut decoder,&router).unwrap();
    }
    assert_eq!(clips,1);execution.validate_witness().unwrap();
}

#[wasm_bindgen_test(async)]
async fn p2_worker_difference_empty_captured_cancel_precedes_compatibility_hold() {
    use ifc_lite_geometry::resource::{ExecutionAccount,ExecutionPolicy,ResourceLimits};
    let mut worker=worker().await;let (_,context)=model(100,&statements("DIFFERENCE","T",10.,""));
    let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
    let account=ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let mut execution=account.scope(||execution(&context,&mut decoder,&router));
    let issued=reach(&mut execution,&mut worker,&mut decoder,&router).await;
    let work=issued.execute_browser(&mut worker,0.001,15.,8_388_608).await.unwrap();
    let RealizationKind::UnaryClip(value)=work.realizations[0].kind() else {panic!("actual Difference clip")};
    assert!(value.is_empty());let before=execution.discharged_count();account.cancel();
    let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
    assert!(matches!(rejected.reason,RetainedExecutionError::Stopped(ProgramStop::Cancelled)));
    let pending=execution.pending.as_ref().unwrap();assert!(pending.reply.is_some());
    assert_eq!(pending.stage.load(Ordering::Acquire),DELIVERED);assert_eq!(execution.discharged_count(),before);
    rejected.work.realizations[0].validate_live().unwrap();execution.ledger[0].receipt.validate_live().unwrap();
}
