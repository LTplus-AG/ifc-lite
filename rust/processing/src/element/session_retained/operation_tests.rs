// SPDX-License-Identifier: MPL-2.0
//! Actual native SDK arithmetic and intact transaction witnesses. No certificates
//! or numerical buffers are mocked. Missing canonical worker means an explicit skip.
use super::*;
use super::value::RealizationKind;
use super::tests::{execution,worker};
use super::super::session_tests::{SOURCE,router};
use super::super::{OwnedMeshProductionData,ProductionModel};
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry_runtime::MeshLimits;

fn operation_context(root: u32, operations: &str) -> (ProductionModel,Arc<OwnedMeshProductionContext>) {
    let source=SOURCE.replace("'SweptSolid',(#13)",&format!("'CSG',(#{root})"))
        .replace("ENDSEC;END-ISO-10303-21;",&format!("
        #90=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#13));
        #91=IFCREPRESENTATIONMAP(#5,#90);
        #92=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,1.,$);
        #93=IFCMAPPEDITEM(#91,#92);
        #94=IFCMAPPEDITEM(#91,#96);#95=IFCCARTESIANPOINT((50.,0.,0.));
        #96=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#95,1.,$);
        {operations}ENDSEC;END-ISO-10303-21;"));
    let model=ProductionModel::from_source(SourceBundle::new(source.into_bytes()));
    let context=model.snapshot(OwnedMeshProductionData::default());
    (model,context)
}

#[test]
fn p2_sdk_a_minus_a_and_disjoint_intersection_remain_empty_and_chain_as_real_values() {
    let Some(mut worker)=worker() else {return};
    for first in ["#100=IFCBOOLEANRESULT(.DIFFERENCE.,#93,#93);",
        "#100=IFCBOOLEANRESULT(.INTERSECTION.,#93,#94);"] {
        let source=format!("{first}#101=IFCBOOLEANRESULT(.UNION.,#100,#93);");
        let (_,context)=operation_context(101,&source);
        let mut decoder=context.source().unwrap().decoder();
        let router=router(&mut decoder);
        let mut execution=execution(&context,&mut decoder,&router);
        let mut booleans=0;
        let mut constructions=0;
        while let Some(issued)=execution.issue_next(&worker,&mut decoder,&router).unwrap() {
            assert!(execution.traversal_plan().is_none(),"issued work is not completed traversal");
            let work=issued.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
            for value in work.realizations() {
                match value.kind() {
                    RealizationKind::Construction(_)=>constructions+=1,
                    RealizationKind::Boolean(result)=> {
                        if booleans==0 {assert!(result.is_empty());}
                        else {
                            assert!(!result.is_empty());
                            assert!((worker.volume(result.solid(),1e-8).unwrap()-24.).abs()<1e-6);
                        }
                        booleans+=1;
                    }
                    _=>panic!("rigid mapping is metadata"),
                }
            }
            execution.accept(work,&mut decoder,&router).unwrap();
        }
        assert_eq!((constructions,booleans),(1,2));
        let plan=execution.traversal_plan().unwrap();
        assert!(!plan.values[0].is_empty());
        assert!(!plan.remaining.is_empty(),"SDK leaf operations do not close openings/layers/appearance");
    }
}

#[test]
fn p2_sdk_empty_host_avoids_unreached_invalid_cutter() {
    let Some(mut worker)=worker() else {return};
    let (_,context)=operation_context(101,"#100=IFCBOOLEANRESULT(.DIFFERENCE.,#93,#93);
        #101=IFCBOOLEANRESULT(.DIFFERENCE.,#100,#999);");
    let mut decoder=context.source().unwrap().decoder();
    let router=router(&mut decoder);
    let mut execution=execution(&context,&mut decoder,&router);
    while let Some(issued)=execution.issue_next(&worker,&mut decoder,&router).unwrap() {
        let work=issued.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
        execution.accept(work,&mut decoder,&router).unwrap();
    }
    assert!(execution.traversal_plan().unwrap().values[0].is_empty());
    assert!(decoder.get_cached(999).is_none());
}

fn affine_context() -> (ProductionModel,Arc<OwnedMeshProductionContext>) {
    let source=SOURCE.replace("'SweptSolid',(#13)","'MappedRepresentation',(#93)")
        .replace("ENDSEC;END-ISO-10303-21;","
        #90=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#13,#13));
        #91=IFCREPRESENTATIONMAP(#5,#90);
        #92=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,2.,$);
        #93=IFCMAPPEDITEM(#91,#92);ENDSEC;END-ISO-10303-21;");
    let model=ProductionModel::from_source(SourceBundle::new(source.into_bytes()));
    let context=model.snapshot(OwnedMeshProductionData::default());
    (model,context)
}

#[test]
fn p1_sdk_affine_batch_rejects_swapped_actual_outputs_before_any_common_acceptance() {
    let Some(mut worker)=worker() else {return};
    let (_,context)=affine_context();
    let mut decoder=context.source().unwrap().decoder();
    let router=router(&mut decoder);
    let mut execution=execution(&context,&mut decoder,&router);
    loop {
        let issued=execution.issue_next(&worker,&mut decoder,&router).unwrap().expect("affine batch reached");
        let mut work=issued.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
        if matches!(work.realizations()[0].kind(),RealizationKind::Affine(_)) {
            assert_eq!(work.realizations.len(),2);
            let before=execution.discharged_count();
            work.realizations.swap(0,1);
            let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
            assert_eq!(execution.discharged_count(),before);
            assert!(execution.pending.as_ref().unwrap().reply.is_some());
            assert!(rejected.work.realizations.iter().all(|value|value.validate_live().is_ok()));
            let mut work=rejected.work;
            work.realizations.swap(0,1);
            let missing=work.realizations.pop().unwrap();
            let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
            assert!(execution.pending.as_ref().unwrap().reply.is_some());
            let mut work=rejected.work;work.realizations.push(missing);
            execution.accept(work,&mut decoder,&router).unwrap();
            break;
        }
        execution.accept(work,&mut decoder,&router).unwrap();
    }
    assert!(execution.issue_next(&worker,&mut decoder,&router).unwrap().is_none());
    assert_eq!(execution.traversal_plan().unwrap().values.len(),2);
    let copy=execution.ledger.last().unwrap().receipt.clone();
    drop(execution);
    // Managed operand leases can now release; this independently retained physical
    // result still owns its object, without keeping the construction leases alive.
    assert!(copy.validate_live().is_ok());
    assert!((worker.volume(copy.solid(),1e-8).unwrap()-192.).abs()<1e-5);
}

fn reach_boolean(execution: &mut RetainedProductExecution, worker: &mut SmlibWorker,
    decoder: &mut EntityDecoder<'_>, router: &GeometryRouter) -> IssuedCommonConstruction {
    loop {
        let issued=execution.issue_next(worker,decoder,router).unwrap().expect("Boolean reached");
        if matches!(execution.pending.as_ref().unwrap().operations[0],PendingRetainedOperation::Boolean {..}) {return issued;}
        let work=issued.execute(worker,0.001,15.,MeshLimits::default()).unwrap();
        execution.accept(work,decoder,router).unwrap();
    }
}

#[test]
fn p2_sdk_actual_wrong_operation_and_context_reject_with_original_reply_intact() {
    let Some(mut worker)=worker() else {return};
    let (_,context)=operation_context(100,"#100=IFCBOOLEANRESULT(.DIFFERENCE.,#93,#93);");
    let (_,foreign_context)=operation_context(100,"#100=IFCBOOLEANRESULT(.UNION.,#93,#93);");
    let mut decoder=context.source().unwrap().decoder();
    let router=router(&mut decoder);
    let mut execution=execution(&context,&mut decoder,&router);
    let issued=reach_boolean(&mut execution,&mut worker,&mut decoder,&router);
    let mut work=issued.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
    let PendingRetainedOperation::Boolean {expected,inputs}=&execution.pending.as_ref().unwrap().operations[0] else {panic!("Boolean")};
    let ifc_lite_geometry::program::RetainedOperationKind::Boolean {inputs:values,..}=expected.kind() else {panic!("Boolean packet")};
    let wrong=worker.evaluate_retained_boolean(inputs[0].dependency(&values[0]).unwrap(),
        inputs[1].dependency(&values[1]).unwrap(),ifc_lite_geometry::document::BooleanOperation::Union,
        0.001,15.,MeshLimits::default()).unwrap();
    let original=std::mem::replace(&mut work.realizations[0],Arc::new(CommonRetainedRealization::new(RealizationKind::Boolean(Box::new(wrong)),execution.resources.clone())));
    let before=execution.discharged_count();
    let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
    assert!(execution.pending.as_ref().unwrap().reply.is_some());
    assert_eq!(execution.discharged_count(),before);
    let mut work=rejected.work;work.realizations[0]=original;
    let original_context=execution.pending.as_ref().unwrap().context;
    execution.pending.as_mut().unwrap().context=foreign_context.id();
    let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
    assert!(execution.pending.as_ref().unwrap().reply.is_some());
    execution.pending.as_mut().unwrap().context=original_context;
    execution.accept(rejected.work,&mut decoder,&router).unwrap();
    assert!(execution.issue_next(&worker,&mut decoder,&router).unwrap().is_none());
    assert!(execution.traversal_plan().unwrap().values[0].is_empty());
}

#[test]
fn p2_sdk_stale_operand_and_cancelled_stage_never_publish_boolean_values() {
    for cancel in [false,true] {
        let Some(mut worker)=worker() else {return};
        let (_,context)=operation_context(100,"#100=IFCBOOLEANRESULT(.DIFFERENCE.,#93,#93);");
        let mut decoder=context.source().unwrap().decoder();
        let router=router(&mut decoder);
        let mut execution=execution(&context,&mut decoder,&router);
        let issued=reach_boolean(&mut execution,&mut worker,&mut decoder,&router);
        let cancellation=issued.cancellation();
        let work=issued.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
        let before=execution.discharged_count();
        if cancel {cancellation.cancel();} else {
            let PendingRetainedOperation::Boolean {inputs,..}=&execution.pending.as_ref().unwrap().operations[0] else {panic!("Boolean")};
            worker.release(inputs[0].solid()).unwrap();
        }
        let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
        assert!(execution.pending.as_ref().unwrap().reply.is_some());
        assert_eq!(execution.discharged_count(),before);
        assert!(execution.traversal_plan().is_none());
        if !cancel {assert!(rejected.work.realizations[0].validate_live().is_ok(),"actual result copy survives lost operand");}
    }
}

#[test]
fn p2_sdk_original_resource_stop_after_boolean_delivery_prevents_linear_acceptance() {
    use ifc_lite_geometry::resource::{ExecutionAccount,ExecutionPolicy,ResourceLimits};
    let Some(mut worker)=worker() else {return};
    let (_,context)=operation_context(100,"#100=IFCBOOLEANRESULT(.DIFFERENCE.,#93,#93);");
    let mut decoder=context.source().unwrap().decoder();
    let router=router(&mut decoder);
    let account=ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let mut execution=account.scope(||execution(&context,&mut decoder,&router));
    let issued=reach_boolean(&mut execution,&mut worker,&mut decoder,&router);
    let work=issued.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
    let before=execution.discharged_count();
    account.cancel();
    let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
    assert!(matches!(rejected.reason,RetainedExecutionError::Stopped(ProgramStop::Cancelled)));
    assert_eq!(execution.discharged_count(),before);
    assert!(execution.pending.as_ref().unwrap().reply.is_some());
    assert!(execution.traversal_plan().is_none());
}

#[test]
fn p2_sdk_nested_outcome_binding_exhaustion_is_typed_and_preserves_original_reply() {
    use ifc_lite_geometry::resource::{self,Cost,Dimension,ExecutionAccount,ExecutionPolicy,ResourceLimits};
    let Some(mut worker)=worker() else {return};
    let (_,context)=operation_context(100,"#100=IFCBOOLEANRESULT(.DIFFERENCE.,#93,#93);");
    let mut decoder=context.source().unwrap().decoder();
    let router=router(&mut decoder);
    let limit=100_000;
    let account=ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {work:Some(limit),..Default::default()}));
    let mut execution=account.scope(||execution(&context,&mut decoder,&router));
    let issued=reach_boolean(&mut execution,&mut worker,&mut decoder,&router);
    let work=issued.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
    assert!(matches!(work.realizations[0].kind(),RealizationKind::Boolean(_)));
    let before=account.usage().work;
    execution.validate_intact(&work,&decoder,&router).unwrap();
    let validation_cost=account.usage().work-before;
    // Admit ledger backing first. Acceptance still charges one append; leave
    // enough for both intact validations, that append, and one reply envelope.
    execution.resources.reserve_headers(&mut execution.ledger,1).unwrap().retain();
    let remaining=2*validation_cost+2;
    let burn=limit-account.usage().work-remaining;
    account.scope(||resource::charge(Cost {work:burn,..Default::default()}).unwrap().retain());
    let ledger_before=execution.discharged_count();
    let outer=execution.pending.as_ref().unwrap().outer;
    let rejected=execution.accept(work,&mut decoder,&router).unwrap_err();
    let stop=account.check().unwrap_err();
    assert!(matches!(stop,ProgramStop::ResourceRefused(f) if f.dimension==Dimension::Work && f.requested==1));
    assert!(matches!(rejected.reason,RetainedExecutionError::Stopped(actual) if actual==stop));
    let pending=execution.pending.as_ref().unwrap();
    assert_eq!(pending.outer,outer);
    assert!(pending.reply.is_some());
    assert_eq!(pending.stage.load(Ordering::Acquire),DELIVERED);
    assert_eq!(execution.discharged_count(),ledger_before);
    assert!(execution.traversal_plan().is_none());
    assert!(execution.issue_next(&worker,&mut decoder,&router).is_err());
}
