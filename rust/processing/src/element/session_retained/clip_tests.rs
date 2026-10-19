// SPDX-License-Identifier: MPL-2.0
//! Actual STEP/common/native SDK witnesses. UNCOMPILED/UNRUN in this change.
//! A missing SDK explicitly skips; a skipped run is not numerical evidence.
use super::*;
use super::tests::{execution,worker};
use super::super::session_tests::{SOURCE,router};
use super::super::{OwnedMeshProductionData,ProductionModel};
use super::value::RealizationKind;
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry_runtime::{MeshLimits,SmlibWorker};

fn context(operator:&str, agreement:&str, z:f64, tail:&str) -> (ProductionModel,Arc<OwnedMeshProductionContext>) {
    context_root(operator,agreement,z,if tail.is_empty() {100} else {101},tail)
}
fn context_root(operator:&str,agreement:&str,z:f64,root:u32,tail:&str)->(ProductionModel,Arc<OwnedMeshProductionContext>) {
    let source=SOURCE.replace("'SweptSolid',(#13)",&format!("'CSG',(#{root})"))
        .replace("ENDSEC;END-ISO-10303-21;",&format!("
        #90=IFCCARTESIANPOINT((0.,0.,{z}));#91=IFCAXIS2PLACEMENT3D(#90,$,$);
        #92=IFCPLANE(#91);#93=IFCHALFSPACESOLID(#92,.{agreement}.);
        #100=IFCBOOLEANRESULT(.{operator}.,#13,#93);{tail}ENDSEC;END-ISO-10303-21;"));
    let model=ProductionModel::from_source(SourceBundle::new(source.into_bytes()));
    let context=model.snapshot(OwnedMeshProductionData::default());(model,context)
}
fn reach(execution:&mut RetainedProductExecution, worker:&mut SmlibWorker,
    decoder:&mut EntityDecoder<'_>, router:&GeometryRouter) -> IssuedCommonConstruction {
    loop {
        let issued=execution.issue_next(worker,decoder,router).unwrap().expect("reached clip");
        if matches!(execution.pending.as_ref().unwrap().operations[0],PendingRetainedOperation::UnaryClip {..}) {return issued;}
        let work=issued.execute(worker,0.001,15.,MeshLimits::default()).unwrap();
        execution.accept(work,decoder,router).unwrap();
    }
}
#[test]
fn p2_sdk_plain_halfspace_both_sides_and_modes_bind_original_reply_with_live_immutable_source() {
    let Some(mut worker)=worker() else {return};let mut volumes=[0.;2];
    for operator in ["DIFFERENCE","INTERSECTION"] {for agreement in ["T","F"] {
        let (_,context)=context(operator,agreement,1.,"");
        let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
        let mut oracle_decoder=context.source().unwrap().decoder();
        let oracle=if operator=="DIFFERENCE" {Some(super::clip_witness::exact_difference(&mut oracle_decoder))} else {None};
        let mut execution=execution(&context,&mut decoder,&router);
        let issued=reach(&mut execution,&mut worker,&mut decoder,&router);
        let pending=execution.pending.as_ref().unwrap();let ticket=pending.ticket.clone();let outer=pending.outer;
        let work=issued.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
        let RealizationKind::UnaryClip(value)=work.realizations[0].kind() else {panic!("sealed clip")};
        assert!(!value.is_empty());
        let upper=(operator=="DIFFERENCE")== (agreement=="T");
        let expected=if upper {16.} else {8.};
        let measured=worker.volume(value.solid(),1e-8).unwrap();
        assert!((measured-expected).abs()<1e-6);volumes[usize::from(agreement=="F")]+=measured;
        let shape=super::clip_witness::assert_offcentre(&value.mesh().positions,&value.mesh().indices,upper);
        if let Some(oracle)=oracle {super::clip_witness::assert_same(shape,oracle);}
        assert_eq!(value.operation_identity().plane,[1.,2.,1.,0.,0.,1.]);
        assert!((worker.volume(execution.ledger[0].receipt.solid(),1e-8).unwrap()-24.).abs()<1e-6);
        assert!(Arc::ptr_eq(&ticket,&execution.pending.as_ref().unwrap().ticket));
        assert_eq!(execution.pending.as_ref().unwrap().outer,outer);
        execution.accept(work,&mut decoder,&router).unwrap();
        assert!(execution.issue_next(&worker,&mut decoder,&router).unwrap().is_none());
        execution.validate_witness().unwrap();
        assert!(!execution.traversal_plan().unwrap().remaining.is_empty());
    }}
    assert!(volumes.iter().all(|v|(v-24.).abs()<1e-6),"Difference/Intersection must partition the original 24m3 host");
}
#[test]
fn p2_sdk_intersection_empty_skips_unreached_rhs_but_difference_empty_holds_intact() {
    let Some(mut worker)=worker() else {return};
    for (operator,z,tail) in [("INTERSECTION",-10.,"#101=IFCBOOLEANRESULT(.DIFFERENCE.,#100,#999);"),
        ("DIFFERENCE",10.,"")] {
        let (_,context)=context(operator,"T",z,tail);
        let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
        let mut execution=execution(&context,&mut decoder,&router);
        let issued=reach(&mut execution,&mut worker,&mut decoder,&router);
        let outer=execution.pending.as_ref().unwrap().outer;let before=execution.discharged_count();
        let work=issued.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
        let RealizationKind::UnaryClip(value)=work.realizations[0].kind() else {panic!("actual clip")};
        assert!(value.is_empty(),"real SDK semantic Empty required");
        if operator=="DIFFERENCE" {
            let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
            assert!(matches!(rejected.reason,RetainedExecutionError::Unsupported(ref e) if e.contains("full-host-removal")));
            let pending=execution.pending.as_ref().unwrap();
            assert_eq!(pending.outer,outer);assert!(pending.reply.is_some());
            assert_eq!(pending.stage.load(Ordering::Acquire),DELIVERED);
            assert_eq!(execution.discharged_count(),before);
            rejected.work.realizations[0].validate_live().unwrap();
            execution.ledger[0].receipt.validate_live().unwrap();
            assert!(execution.traversal_plan().is_none());
        } else {
            execution.accept(work,&mut decoder,&router).unwrap();
            assert!(execution.issue_next(&worker,&mut decoder,&router).unwrap().is_none());
            assert!(execution.traversal_plan().unwrap().values[0].is_empty());
            assert!(decoder.get_cached(999).is_none());
        }
    }
}
#[test]
fn p2_sdk_unary_foreign_ticket_and_changed_selected_frame_reject_before_linear_take() {
    let Some(mut worker)=worker() else {return};
    let (_,context)=context("INTERSECTION","T",1.5,"");
    let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
    let mut execution=execution(&context,&mut decoder,&router);
    let issued=reach(&mut execution,&mut worker,&mut decoder,&router);
    let mut work=issued.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
    let ticket=work.ticket.clone();work.ticket=Arc::new(());
    let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
    assert!(matches!(rejected.reason,RetainedExecutionError::Protocol(_)));
    let mut work=rejected.work;work.ticket=ticket;
    let PendingRetainedOperation::UnaryClip {input,..}=&mut execution.pending.as_mut().unwrap().operations[0] else {panic!("unary")};
    // A genuine alternate sealed input cannot satisfy this original handle binding.
    let source=input.clone();
    let original=work.realizations[0].clone();work.realizations[0]=source;
    let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
    assert!(matches!(rejected.reason,RetainedExecutionError::Protocol(_)));
    let mut work=rejected.work;work.realizations[0]=original;
    assert!(execution.pending.as_ref().unwrap().reply.is_some());
    let original=work.realizations[0].clone();
    let source=execution.ledger[0].receipt.construction().unwrap();
    let frame=ifc_lite_geometry::math::mat4::col_major_array(&nalgebra::Matrix4::new_translation(&nalgebra::Vector3::new(100.,0.,0.)));
    let wrong_frame=worker.clip_retained_plane(ifc_lite_geometry_runtime::RetainedDependency::Source {
        realization:source,world_from_source:frame},[1.,2.,1.5,0.,0.,1.],
        ifc_lite_geometry_runtime::PlaneSide::Negative,ifc_lite_geometry_runtime::PlaneClipMode::Intersection,
        0.001,15.,MeshLimits::default()).unwrap();
    assert_eq!(wrong_frame.operation_identity().input,execution.ledger[0].receipt.solid());
    work.realizations[0]=Arc::new(CommonRetainedRealization::new(RealizationKind::UnaryClip(Box::new(wrong_frame)),execution.resources.clone()));
    let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
    assert!(matches!(rejected.reason,RetainedExecutionError::Protocol(ref e) if e.contains("frame mismatch")));
    let mut work=rejected.work;work.realizations[0]=original;
    let original=work.realizations[0].clone();
    let source=execution.ledger[0].receipt.construction().unwrap();
    let signed_zero=worker.clip_retained_plane(ifc_lite_geometry_runtime::RetainedDependency::Source {
        realization:source,world_from_source:ifc_lite_geometry::math::mat4::col_major_array(&nalgebra::Matrix4::identity())},
        [1.,2.,1.5,-0.,0.,1.],ifc_lite_geometry_runtime::PlaneSide::Negative,ifc_lite_geometry_runtime::PlaneClipMode::Intersection,
        0.001,15.,MeshLimits::default()).unwrap();
    assert_eq!(signed_zero.operation_identity().plane[3].to_bits(),(-0.0f64).to_bits());
    work.realizations[0]=Arc::new(CommonRetainedRealization::new(RealizationKind::UnaryClip(Box::new(signed_zero)),execution.resources.clone()));
    let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
    assert!(matches!(rejected.reason,RetainedExecutionError::Protocol(_)));
    assert!(execution.pending.as_ref().unwrap().reply.is_some());
    let mut work=rejected.work;work.realizations[0]=original;
    execution.accept(work,&mut decoder,&router).unwrap();
}
#[test]
fn p2_sdk_unary_cancelled_resource_after_delivery_preserves_pending_and_ledger() {
    use ifc_lite_geometry::resource::{ExecutionAccount,ExecutionPolicy,ResourceLimits};
    let Some(mut worker)=worker() else {return};
    let (_,context)=context("INTERSECTION","T",1.5,"");
    let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
    let account=ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let mut execution=account.scope(||execution(&context,&mut decoder,&router));
    let issued=reach(&mut execution,&mut worker,&mut decoder,&router);
    let work=issued.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();let before=execution.discharged_count();
    account.cancel();let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
    assert!(matches!(rejected.reason,RetainedExecutionError::Stopped(ProgramStop::Cancelled)));
    assert_eq!(execution.discharged_count(),before);assert!(execution.pending.as_ref().unwrap().reply.is_some());
}

#[test]
fn p2_sdk_mapped_clip_feeds_same_unary_and_binary_dependency_selectors() {
    let Some(mut worker)=worker() else {return};
    let (_,context)=context_root("INTERSECTION","T",1.5,107,"
        #101=IFCSHAPEREPRESENTATION(#2,'Body','CSG',(#100));#102=IFCREPRESENTATIONMAP(#5,#101);
        #103=IFCCARTESIANPOINT((100.,0.,0.));#104=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#103,1.,$);
        #105=IFCMAPPEDITEM(#102,#104);#110=IFCCARTESIANPOINT((0.,0.,0.75));
        #111=IFCAXIS2PLACEMENT3D(#110,$,$);#112=IFCPLANE(#111);#113=IFCHALFSPACESOLID(#112,.T.);
        #106=IFCBOOLEANRESULT(.DIFFERENCE.,#105,#113);#107=IFCBOOLEANRESULT(.UNION.,#105,#106);");
    let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
    let mut execution=execution(&context,&mut decoder,&router);let mut clips=0;let mut unions=0;
    while let Some(issued)=execution.issue_next(&worker,&mut decoder,&router).unwrap() {
        let work=issued.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
        for value in work.realizations() {match value.kind() {
            RealizationKind::UnaryClip(v)=> {
                assert!((worker.volume(v.solid(),1e-8).unwrap()-if clips==0 {12.} else {6.}).abs()<1e-6);
                assert_eq!(v.world_from_evaluation()[12],if clips==0 {-1.} else {99.});clips+=1;
            }
            RealizationKind::Boolean(v)=> {assert!((worker.volume(v.solid(),1e-8).unwrap()-12.).abs()<1e-6);unions+=1;}
            _=>{},
        }}
        execution.accept(work,&mut decoder,&router).unwrap();
    }
    assert_eq!((clips,unions),(2,1));execution.validate_witness().unwrap();
}
#[test]
fn p2_sdk_unary_source_epoch_stale_after_delivery_leaves_original_pending_reply() {
    let Some(mut worker)=worker() else {return};let (model,context)=context("INTERSECTION","T",1.5,"");
    let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
    let mut execution=execution(&context,&mut decoder,&router);
    let issued=reach(&mut execution,&mut worker,&mut decoder,&router);
    let work=issued.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();let before=execution.discharged_count();
    model.invalidate_source();let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
    assert!(matches!(rejected.reason,RetainedExecutionError::Source));
    assert_eq!(execution.discharged_count(),before);assert!(execution.pending.as_ref().unwrap().reply.is_some());
}

#[test]
fn p2_sdk_issue_5314_source_edge_clip_obeys_existing_prism_integral() {
    let Some(mut worker)=worker() else {return};worker.qualify_ordered_regions().unwrap();
    let source=include_str!("../../../../geometry/tests/fixtures/issue_5314_halfspace_edge.ifc");
    let model=ProductionModel::from_source(SourceBundle::new(source.as_bytes().to_vec()));
    let context=model.snapshot(OwnedMeshProductionData::default());let mut decoder=context.source().unwrap().decoder();
    let router=GeometryRouter::with_scale(0.001);let entity=decoder.decode_by_id(30).unwrap();
    let mut execution=RetainedProductExecution::new(&ElementMeshJob {id:30,ifc_type:entity.ifc_type.clone(),entity:&entity,
        kind:super::super::ElementJobKind::Product,element_color:None,metadata:None},&context,
        &MeshProductionOptions::default(),&mut decoder,&router).unwrap();let mut clips=0;
    // Same authored integral as halfspace_clip_cap_regression, scaled mm^3 -> m^3.
    let expected=(38.9995574951+88.99974823)*60.0004196167*(300.00067435-60.0004196167/2.)*1e-9;
    while let Some(issued)=execution.issue_next(&worker,&mut decoder,&router).unwrap() {
        let work=issued.execute(&mut worker,0.00001,15.,MeshLimits::default()).unwrap();
        if let RealizationKind::UnaryClip(value)=work.realizations[0].kind() {
            let volume=worker.volume(value.solid(),1e-10).unwrap();
            assert!((volume/expected-1.).abs()<1e-5);assert!(worker.is_manifold(value.solid()).unwrap());clips+=1;
        }
        execution.accept(work,&mut decoder,&router).unwrap();
    }
    assert_eq!(clips,1);execution.validate_witness().unwrap();
}
#[test]
fn p2_sdk_actual_authoring_roof_walls_follow_existing_positive_volume_invariant() {
    let Some(source)=ifc_lite_testkit::fixture_bytes("ara3d/AC20-FZK-Haus.ifc") else {
        eprintln!("SKIP real roof-wall common SDK witness: run pnpm fixtures");return;
    };
    let Some(mut worker)=worker() else {return};worker.qualify_ordered_regions().unwrap();
    let model=ProductionModel::from_source(SourceBundle::new(source));let context=model.snapshot(OwnedMeshProductionData::default());
    for id in [67536,75347] {
        let mut decoder=context.source().unwrap().decoder();let scale=decoder.length_unit_scale();
        let router=GeometryRouter::with_scale(scale);let entity=decoder.decode_by_id(id).unwrap();
        let mut execution=RetainedProductExecution::new(&ElementMeshJob {id,ifc_type:entity.ifc_type.clone(),entity:&entity,
            kind:super::super::ElementJobKind::Product,element_color:None,metadata:None},&context,
            &MeshProductionOptions::default(),&mut decoder,&router).unwrap();let mut clips=0;
        while let Some(issued)=execution.issue_next(&worker,&mut decoder,&router).unwrap() {
            let work=issued.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
            if let RealizationKind::UnaryClip(value)=work.realizations[0].kind() {
                // Existing halfspace_clip_cap_regression positive solid oracle.
                assert!(worker.volume(value.solid(),1e-8).unwrap()>0.5);
                assert!(worker.is_manifold(value.solid()).unwrap());clips+=1;
            }
            execution.accept(work,&mut decoder,&router).unwrap();
        }
        assert!(clips>0);execution.validate_witness().unwrap();
    }
}

#[test]
fn p2_sdk_difference_empty_captured_cancel_or_refusal_precedes_compatibility_hold() {
    use ifc_lite_geometry::resource::{self,Cost,ExecutionAccount,ExecutionPolicy,ResourceLimits};
    for cancelled in [true,false] {
        // Cancellation owns retirement of this exact worker domain. The next
        // independent first-fault scenario must start a fresh actual worker.
        let Some(mut worker)=worker() else {return};
        let (_,context)=context("DIFFERENCE","T",10.,"");
        let mut decoder=context.source().unwrap().decoder();let router=router(&mut decoder);
        let limit=100_000;
        let account=ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {work:Some(limit),..Default::default()}));
        let mut execution=account.scope(||execution(&context,&mut decoder,&router));
        let issued=reach(&mut execution,&mut worker,&mut decoder,&router);
        let work=issued.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
        let RealizationKind::UnaryClip(value)=work.realizations[0].kind() else {panic!("actual Difference clip")};
        assert!(value.is_empty());
        let before=execution.discharged_count();let outer=execution.pending.as_ref().unwrap().outer;
        if cancelled {account.cancel();} else {
            let burn=limit-account.usage().work;
            account.scope(|| {
                resource::charge(Cost {work:burn,..Default::default()}).unwrap().retain();
                assert!(resource::charge(Cost {work:1,..Default::default()}).is_err());
            });
        }
        let stop=account.check().unwrap_err();
        let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
        assert!(matches!(rejected.reason,RetainedExecutionError::Stopped(actual) if actual==stop));
        let pending=execution.pending.as_ref().unwrap();assert_eq!(pending.outer,outer);
        assert!(pending.reply.is_some());assert_eq!(pending.stage.load(Ordering::Acquire),DELIVERED);
        assert_eq!(execution.discharged_count(),before);
        rejected.work.realizations[0].validate_live().unwrap();execution.ledger[0].receipt.validate_live().unwrap();
        assert!(execution.traversal_plan().is_none());
    }
}
