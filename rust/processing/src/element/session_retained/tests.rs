// SPDX-License-Identifier: MPL-2.0
//! #7955 source authentication, original resource ownership and sealed acceptance.
use super::super::session_tests::{job, metadata, options, SOURCE};
use super::*;
use ifc_lite_core::SourceBundle;
// Source authentication intentionally rejects the raw seed_unit_scales helper.
// Resolve units from the actual SourceBundle and preserve its cache provenance.
pub(super) fn router(decoder: &mut EntityDecoder) -> GeometryRouter {
    let mut router = GeometryRouter::with_units(SOURCE, decoder);
    router.set_rtc_offset((8., 16., 0.));
    router
}
#[test]
fn common_retained_entry_uses_actual_source_root_instead_of_caller_edited_snapshot() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = router(&mut decoder);
    let context = ProductionModel::from_source(source.clone()).snapshot(Default::default());
    let mut entity = decoder.decode_by_id(10).unwrap();
    entity.attributes = Arc::new(Vec::new());
    let metadata = metadata(10);
    let job = job(&entity, &metadata);
    assert!(matches!(
        RetainedProductExecution::begin(&job, &context, &options(), &mut decoder, &router),
        Err(RetainedExecutionError::Source(_))
    ));
}
#[test]
fn retained_entry_refuses_edited_root_type_even_when_job_type_is_authentic() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = router(&mut decoder);
    let context = ProductionModel::from_source(source.clone()).snapshot(Default::default());
    let mut entity = decoder.decode_by_id(10).unwrap();
    let original_type = entity.ifc_type.clone();
    entity.ifc_type = IfcType::IfcSlab;
    let metadata = metadata(10);
    let mut job = job(&entity, &metadata);
    job.ifc_type = original_type;
    assert!(matches!(
        RetainedProductExecution::begin(&job, &context, &options(), &mut decoder, &router),
        Err(RetainedExecutionError::Source(_))
    ));
}
#[test]
fn retained_constructor_refuses_original_zero_work_before_source_root_is_planned() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = router(&mut decoder);
    let context = ProductionModel::from_source(source.clone()).snapshot(Default::default());
    let entity = decoder.decode_by_id(10).unwrap();
    let metadata = metadata(10);
    let job = job(&entity, &metadata);
    let account = resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(
        resource::ResourceLimits {
            work: Some(0),
            ..Default::default()
        },
    ));
    let result = account
        .scope(|| RetainedProductExecution::begin(&job, &context, &options(), &mut decoder, &router));
    assert!(matches!(
        result,
        Err(RetainedExecutionError::Stopped(
            ProgramStop::ResourceRefused(_)
        ))
    ));
}
#[test]
fn retained_context_rejects_foreign_decoder_and_expired_source() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let other = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let model = ProductionModel::from_source(source.clone());
    let context = model.snapshot(Default::default());
    assert_eq!(
        context.validate_decoder(&other.decoder()),
        Err(RetainedContextError::Mismatched)
    );
    assert!(context.validate_decoder(&source.decoder()).is_ok());
    model.invalidate_source();
    assert_eq!(
        context.validate_decoder(&source.decoder()),
        Err(RetainedContextError::Stale)
    );
}
pub(super) fn worker() -> Option<SmlibWorker> {
    let Some(path) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        eprintln!("SKIP common retained SDK continuation: set IFCLITE_SMLIB_WORKER");
        return None;
    };
    Some(SmlibWorker::spawn(path).unwrap())
}
#[test]
fn common_retained_actual_construction_is_consumed_and_original_product_resumes() {
    let Some(mut worker) = worker() else { return };
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = router(&mut decoder);
    let context = ProductionModel::from_source(source.clone()).snapshot(Default::default());
    let entity = decoder.decode_by_id(10).unwrap();
    let metadata = metadata(10);
    let job = job(&entity, &metadata);
    let mut execution =
        RetainedProductExecution::begin(&job, &context, &options(), &mut decoder, &router).unwrap();
    let issued = execution
        .issue_next(&mut decoder, &router, &worker)
        .unwrap()
        .unwrap();
    let receipt = issued
        .execute(&mut worker, 0.001, 15., MeshLimits::default())
        .unwrap();
    assert!(!receipt
        .realizations()[0].construction().unwrap()
        .completion()
        .tessellation
        .indices
        .is_empty());
    execution
        .accept(receipt, &mut decoder, &router)
        .unwrap_or_else(|e| panic!("{:?}", e.reason));
    assert!(execution
        .issue_next(&mut decoder, &router, &worker)
        .unwrap()
        .is_none());
    let witness = execution.into_witness().unwrap();
    assert_eq!(witness.discharged_count(), 1);
    assert_eq!(witness.plan().values().len(), 1);
    assert_eq!(
        witness.plan().requirements().collect::<Vec<_>>(),
        vec![
            RetainedRequirement::OpeningClosure,
            RetainedRequirement::MaterialLayers,
            RetainedRequirement::IfcAppearance,
            RetainedRequirement::PersistentFaces
        ]
    );
    witness.validate().unwrap();
    assert!(matches!(witness.require_final_product(), Err(RetainedExecutionError::Unsupported(_))));
}
#[test]
fn common_retained_cancel_between_issue_and_execute_uses_independent_owner_capability() {
    let Some(mut worker) = worker() else { return };
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = router(&mut decoder);
    let context = ProductionModel::from_source(source.clone()).snapshot(Default::default());
    let entity = decoder.decode_by_id(10).unwrap();
    let metadata = metadata(10);
    let job = job(&entity, &metadata);
    let mut execution =
        RetainedProductExecution::begin(&job, &context, &options(), &mut decoder, &router).unwrap();
    let issued = execution
        .issue_next(&mut decoder, &router, &worker)
        .unwrap()
        .unwrap();
    issued.cancellation().cancel();
    assert!(issued
        .execute(&mut worker, 0.001, 15., MeshLimits::default())
        .is_err());
    assert!(execution.traversal_plan().is_none());
}

#[test]
fn common_retained_ordinary_product_acceptor_cannot_consume_logical_plan_admission() {
    // #7955: a logical numerical reply cannot complete the ordinary outer strategy.
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = router(&mut decoder);
    let context = ProductionModel::from_source(source.clone()).snapshot(Default::default());
    let entity = decoder.decode_by_id(10).unwrap();
    let metadata = metadata(10);
    let job = job(&entity, &metadata);
    let mut e =
        RetainedProductExecution::begin(&job, &context, &options(), &mut decoder, &router).unwrap();
    let program = e.program.as_mut().unwrap();
    let reply = loop {
        let ((reply, operations, _storage), _) = e
            .owner
            .work(&mut decoder, &router, |d, r| {
                let ticket = program.request().unwrap().unwrap();
                program.admit(ticket, r, d).unwrap()
            })
            .unwrap();
        if !operations.is_empty() {
            assert_eq!(operations.len(), 1);
            assert!(matches!(operations[0].kind(), RetainedOperationKind::Construction(recipe) if recipe.solid_id() == 13),
                "the detached admission must name the actual reached IFC construction");
            break reply;
        }
        program.accept(reply, &router).ok().unwrap();
    };
    assert_eq!(
        e.state
            .step_live(&context.borrowed(), &mut decoder, &router)
            .err(),
        Some(super::super::session_protocol::WorkError::Aborted)
    );
    assert!(
        e.state.protocol.before_execute(e.outer.unwrap()).is_ok(),
        "outer strategy has not executed"
    );
    program.validate_reply(&reply, &router).unwrap();
    assert_eq!(e.discharged_count(), 0);
}

#[test]
fn h2a2_native_cached_mapping_reuses_one_live_receipt_for_distinct_styled_occurrences() {
    let Some(mut worker) = worker() else { return };
    let bytes = SOURCE.replace("'SweptSolid',(#13)", "'SweptSolid',(#13,#93)")
        .replace("#13=IFCEXTRUDEDAREASOLID", "#13=IFCMAPPEDITEM(#81,#82);#113=IFCEXTRUDEDAREASOLID")
        .replace("ENDSEC;END-ISO", "#81=IFCREPRESENTATIONMAP(#5,#83);#82=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#84,1.,$);#83=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#113));#84=IFCCARTESIANPOINT((2.,4.,6.));#93=IFCMAPPEDITEM(#81,#94);#94=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,1.,$);ENDSEC;END-ISO");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let context = ProductionModel::from_source(source.clone()).snapshot(Default::default());
    let entity = decoder.decode_by_id(10).unwrap();
    let metadata = metadata(10);
    let job = job(&entity, &metadata);
    let mut execution = RetainedProductExecution::begin(&job, &context, &options(), &mut decoder, &router).unwrap();
    while let Some(issued) = execution.issue_next(&mut decoder, &router, &worker).unwrap() {
        let receipt = issued.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
        assert!(!receipt.realizations()[0].construction().unwrap().completion().tessellation.indices.is_empty());
        execution.accept(receipt,&mut decoder,&router).unwrap_or_else(|e|panic!("{:?}",e.reason));
    }
    let witness = execution.into_witness().unwrap();
    witness.validate().unwrap();
    assert!(matches!(witness.require_final_product(), Err(RetainedExecutionError::Unsupported(_))));
    assert_eq!(witness.discharged_count(),1);
    let values: Vec<_> = witness.plan().values().collect();
    assert_eq!(values.len(),2);
    assert_eq!(values[0].definition(),values[1].definition());
    assert_ne!(values[0].slot(),values[1].slot());
    let first = values[0].world_from_source().unwrap();
    let second = values[1].world_from_source().unwrap();
    assert_eq!([first[12],first[13],first[14]],[12.,24.,36.]);
    assert_eq!([second[12],second[13],second[14]],[10.,20.,30.]);
    assert_eq!(values[0].bindings().next().unwrap().0,113);
    assert_eq!(values[0].bindings().nth(1).unwrap().1,13);
    assert_eq!(values[1].bindings().nth(1).unwrap().1,93);
    assert!(witness.plan().requirements().any(|r| r == RetainedRequirement::IfcAppearance));
}

#[path = "type_map_tests.rs"]
mod type_map_tests;
