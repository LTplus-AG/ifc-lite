// SPDX-License-Identifier: MPL-2.0
//! P1 source-driven native witnesses. SDK absence is an explicit skip, never proof.
use super::*;
use super::tests::{execution,worker};
use super::super::session_tests::{SOURCE,router};
use super::super::{OwnedMeshProductionData,ProductionModel};
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry_runtime::MeshLimits;

fn context() -> (ProductionModel,Arc<OwnedMeshProductionContext>) {
    let source=SOURCE.replace("'SweptSolid',(#13)","'MappedRepresentation',(#93,#94)")
        .replace("ENDSEC;END-ISO-10303-21;","
        #90=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#13));
        #91=IFCREPRESENTATIONMAP(#5,#90);
        #92=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#95,1.,$);
        #93=IFCMAPPEDITEM(#91,#92);#94=IFCMAPPEDITEM(#91,#96);
        #95=IFCCARTESIANPOINT((2.,3.,4.));
        #96=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#97,1.,$);
        #97=IFCCARTESIANPOINT((-2.,3.,4.));ENDSEC;END-ISO-10303-21;");
    let model=ProductionModel::from_source(SourceBundle::new(source.into_bytes()));
    let context=model.snapshot(OwnedMeshProductionData::default());
    (model,context)
}

#[test]
fn p1_native_reached_cache_reuses_one_immutable_realization_for_distinct_placed_occurrences() {
    let Some(mut worker)=worker() else {return};
    let (_,context)=context();
    let mut decoder=context.source().unwrap().decoder();
    let router=router(&mut decoder);
    let mut execution=execution(&context,&mut decoder,&router);
    let issued=execution.issue_next(&worker,&mut decoder,&router).unwrap().unwrap();
    let receipt=issued.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
    let solid=receipt.realization().solid();
    assert!((worker.volume(solid,1e-8).unwrap()-24.).abs()<1e-6);
    execution.accept(receipt,&mut decoder,&router).unwrap();
    assert!(execution.issue_next(&worker,&mut decoder,&router).unwrap().is_none());
    assert_eq!(execution.discharged_count(),1);
    let plan=execution.traversal_plan().unwrap();
    assert_eq!(plan.values.len(),2);
    assert_eq!(plan.values[0].definition(),plan.values[1].definition());
    assert_ne!(plan.values[0].slot(),plan.values[1].slot());
    let a=plan.values[0].world_from_evaluation()*nalgebra::Vector4::new(0.,0.,0.,1.);
    let b=plan.values[1].world_from_evaluation()*nalgebra::Vector4::new(0.,0.,0.,1.);
    for (actual,expected) in [(a,[11.,21.,34.,1.]),(b,[7.,21.,34.,1.])] {
        for axis in 0..4 {assert!((actual[axis]-expected[axis]).abs()<1e-10);}
    }
    assert_eq!(execution.ledger[0].receipt.realization().solid(),solid);
    assert!((worker.volume(solid,1e-8).unwrap()-24.).abs()<1e-6,
        "logical occurrence placement never mutates shared source BRep");
}

#[test]
fn p1_mapped_foreign_receipt_and_expired_original_source_reject_before_take() {
    let Some(mut worker)=worker() else {return};
    let (model_a,context_a)=context();
    let (_,context_b)=context();
    let mut decoder_a=context_a.source().unwrap().decoder();
    let mut decoder_b=context_b.source().unwrap().decoder();
    let router_a=router(&mut decoder_a);let router_b=router(&mut decoder_b);
    let mut first=execution(&context_a,&mut decoder_a,&router_a);
    let mut foreign=execution(&context_b,&mut decoder_b,&router_b);
    let issued_a=first.issue_next(&worker,&mut decoder_a,&router_a).unwrap().unwrap();
    let issued_b=foreign.issue_next(&worker,&mut decoder_b,&router_b).unwrap().unwrap();
    let receipt_a=issued_a.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
    let receipt_b=issued_b.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
    let rejected=first.accept(receipt_b,&mut decoder_a,&router_a).unwrap_err();
    assert!(first.pending.as_ref().unwrap().reply.is_some());
    assert!(foreign.pending.as_ref().unwrap().reply.is_some());
    assert!(rejected.work.realization().validate_live().is_ok());
    assert_ne!(worker.incarnation(),0,"foreign receipt cannot retire captured worker");
    foreign.accept(rejected.work,&mut decoder_b,&router_b).unwrap();
    model_a.invalidate_source();
    let rejected=first.accept(receipt_a,&mut decoder_a,&router_a).unwrap_err();
    assert!(matches!(rejected.reason,RetainedExecutionError::Source));
    assert!(first.pending.as_ref().unwrap().reply.is_some());
    assert_eq!(first.discharged_count(),0);
    // Current cancellation retires its worker domain. This is NOT an independent
    // lifetime witness; managed native object release remains a runtime gate.
}
