// SPDX-License-Identifier: MPL-2.0
//! Common source/control admission only. Never invent an SDK cut completion.
use super::*;
use crate::program::{LogicalRetainedDefinition, RetainedContract, RetainedOperationKind};
const SOURCE: &str =
    include_str!("../../../processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc");
fn contract() -> RetainedContract {
    RetainedContract {
        source_epoch: 7,
        source_revision: 11,
    }
}
fn source_id(value: &crate::program::LogicalRetainedValue) -> u32 {
    match value.definition() {
        LogicalRetainedDefinition::Source { source_id, .. } => *source_id,
        _ => panic!("original source definition"),
    }
}
#[test]
fn retained_issue_2019_reaches_original_context_then_first_ordered_analytic_cut() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let router = GeometryRouter::new();
    let mut program =
        GeometryProgram::retained_voided_submeshes(decoder.decode_by_id(30).unwrap(), contract());
    let index = FxHashMap::from_iter([(30, vec![50, 70, 100])]);
    let mut constructions = Vec::new();
    loop {
        let request = program
            .request()
            .unwrap()
            .expect("first cut must be reached");
        let (mut reply, operations) = program
            .admit_retained_with_inputs(request, &router, &mut decoder, None, Some(&index))
            .unwrap();
        for operation in &operations {
            match operation.kind() {
                RetainedOperationKind::Construction(source) => {
                    assert!(source.extrusion().unwrap().source.source.is_some());
                    constructions.push(source_id(operation.value()));
                    if constructions.len() == 1 {
                        assert!(
                            decoder.get_cached(46).is_none(),
                            "host source precedes opening context source"
                        );
                    }
                }
                RetainedOperationKind::Boolean {
                    inputs,
                    operation: kind,
                } => {
                    assert_eq!(*kind, crate::document::BooleanOperation::Difference);
                    assert_eq!(constructions, [26, 46, 66, 96]);
                    assert_eq!((source_id(&inputs[0]), source_id(&inputs[1])), (26, 46));
                    assert!(inputs.iter().all(|value| value.is_product_placed()));
                    assert_ne!(inputs[0].slot(), inputs[1].slot());
                    assert!(
                        reply.bind_retained_outcome(inputs[1].slot(), true).is_err(),
                        "foreign slot cannot mutate original cut reply"
                    );
                    assert_eq!(program.request().err(), Some(ProgramError::Outstanding));
                    program.cancel_with_reports(&router).unwrap();
                    assert!(
                        program.finish_retained().is_err(),
                        "admission is never cut completion"
                    );
                    return;
                }
                _ => panic!("fixture only needs original constructions and Difference"),
            }
        }
        // Construction replies here admit immutable source only. No numerical
        // outcome is synthesized and the first cut is deliberately never accepted.
        program.accept(reply, &router).unwrap();
    }
}
#[test]
fn retained_void_original_no_related_eligibility_is_product_specific() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let router = GeometryRouter::new();
    let mut program =
        GeometryProgram::retained_voided_parts(decoder.decode_by_id(30).unwrap(), contract());
    while let Some(request) = program.request().unwrap() {
        let (reply, operations) = program
            .admit_retained_with_inputs(request, &router, &mut decoder, None, None)
            .unwrap();
        assert!(operations
            .iter()
            .all(|operation| matches!(operation.kind(), RetainedOperationKind::Construction(_))));
        program.accept(reply, &router).unwrap();
    }
    let plan = program.finish_retained().unwrap();
    let fact = plan.opening_completion.unwrap();
    assert_eq!(fact.product(), 30);
    assert!(!fact.empty_host(),"the nonempty source control remains nonempty");
    assert_eq!(fact.related_openings(), 0);
    assert_eq!(fact.accepted_cuts(), 0);
    assert!(!fact.grouping_deferred());
    assert!(decoder.get_cached(46).is_none());
    assert!(plan
        .remaining
        .contains(&crate::program::RetainedRequirement::MaterialLayers));
    assert!(plan
        .remaining
        .contains(&crate::program::RetainedRequirement::IfcAppearance));
}
#[test]
fn retained_void_captured_stop_remains_typed_and_cannot_close_openings() {
    use crate::resource::{ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};
    let mut decoder = EntityDecoder::new(SOURCE);
    let router = GeometryRouter::new();
    let mut program =
        GeometryProgram::retained_voided_parts(decoder.decode_by_id(30).unwrap(), contract());
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let request = program.request().unwrap().unwrap();
    account.cancel();
    account.scope(|| {
        let (reply, operations) = program
            .admit_retained_with_inputs(request, &router, &mut decoder, None, None)
            .unwrap();
        assert!(operations.is_empty());
        program.accept(reply, &router).unwrap();
    });
    assert!(program.request().unwrap().is_none());
    assert!(matches!(
        program.finish_retained(),
        Err(crate::Error::ProgramStopped(ProgramStop::Cancelled))
    ));
    assert!(decoder.get_cached(46).is_none());
}

#[test]
fn retained_issue_2019_reached_malformed_opening_never_becomes_an_empty_cutter_success() {
    let source = SOURCE.replace("'SweptSolid',(#46)", "'SweptSolid',(#999)");
    let mut decoder = EntityDecoder::new(&source);
    let router = GeometryRouter::new();
    let mut program =
        GeometryProgram::retained_voided_parts(decoder.decode_by_id(30).unwrap(), contract());
    let index = FxHashMap::from_iter([(30, vec![50, 70, 100])]);
    while let Some(request) = program.request().unwrap() {
        let (reply, operations) = program
            .admit_retained_with_inputs(request, &router, &mut decoder, None, Some(&index))
            .unwrap();
        assert!(operations
            .iter()
            .all(|operation| matches!(operation.kind(), RetainedOperationKind::Construction(_))));
        program.accept(reply, &router).unwrap();
    }
    assert!(
        program.finish_retained().is_err(),
        "a reached required opening source error cannot close the product"
    );
    assert!(!router.host_consumed_by_void(30));
}

#[test]
fn retained_no_related_source_empty_host_closes_with_empty_metadata_and_no_late_reads() {
    // Authentic source absence: the existing host representation has no Items.
    // No SDK outcome or semantic classification is supplied by this test.
    let source=SOURCE.replace("'SweptSolid',(#26)","'SweptSolid',()");
    let mut decoder=EntityDecoder::new(&source);let router=GeometryRouter::new();
    let mut program=GeometryProgram::retained_voided_parts(decoder.decode_by_id(30).unwrap(),contract());
    while let Some(request)=program.request().unwrap() {
        let (reply,operations)=program.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
        assert!(operations.is_empty(),"an empty source list never fabricates construction work");
        program.accept(reply,&router).unwrap();
    }
    let plan=program.finish_retained().unwrap();assert!(plan.values.is_empty());
    let fact=plan.opening_completion.as_ref().unwrap();assert!(fact.empty_host());
    assert_eq!(fact.related_openings(),0);assert_eq!(fact.accepted_cuts(),0);assert!(!fact.grouping_deferred());
    assert!(!plan.remaining.contains(&crate::program::RetainedRequirement::OpeningClosure));
    assert!(plan.remaining.contains(&crate::program::RetainedRequirement::IfcAppearance));
    assert!(decoder.get_cached(50).is_none());assert!(decoder.get_cached(46).is_none());
}
