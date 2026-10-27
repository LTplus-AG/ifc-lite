// SPDX-License-Identifier: MPL-2.0
//! #7955 B2b: parsed source through logical admission and consumed completion.
//! No SDK execution or numerical geometry qualification is claimed here.
use super::*;
use crate::program::retained::failure::{BooleanReason, OriginCause, OriginFailure};
use std::sync::Arc;

fn fixture(kind: &str, args: &str) -> String {
    SOURCE.replace("#13=IFCEXTRUDEDAREASOLID", &format!("#13={kind}({args});#113=IFCEXTRUDEDAREASOLID"))
        .replace("ENDSEC;END-ISO", "#213=IFCEXTRUDEDAREASOLID(#14,#5,#15,1.);ENDSEC;END-ISO")
}
fn program<'a>(entity: &'a DecodedEntity, decoder: &mut EntityDecoder, mode: usize) -> RetainedProgram<'a> {
    match mode {
        0 => RetainedProgram::product_parts(entity, contract()),
        1 => RetainedProgram::product_submeshes(entity, true, None, contract()),
        _ => RetainedProgram::type_map(decoder.decode_by_id(61).unwrap(), None, contract()),
    }
}
fn finish(program: RetainedProgram<'_>, mode: usize) -> std::result::Result<RetainedProductPlan, RetainedFailure> {
    if mode == 2 { program.finish_type_map(60, 1, [1.; 4]) } else { program.finish() }
}
fn origin(error: RetainedFailure) -> Arc<OriginFailure> {
    let RetainedFailure::Origin(handle) = error else { panic!("typed origin required: {error:?}") };
    handle.origin().expect("consumed completion retains origin")
}
fn run(bytes: &str, mode: usize, expected_operations: usize) -> Arc<OriginFailure> {
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = program(&entity, &mut decoder, mode);
    assert_eq!(drive(&mut program, &router, &mut decoder).len(), expected_operations);
    let recorded = program.selection().unwrap().failure_handle().origin().expect("source records before finish");
    let failure = origin(finish(program, mode).unwrap_err());
    assert!(Arc::ptr_eq(&recorded, &failure), "completion preserves the actual first cause");
    failure
}

#[test]
fn issue_7955_b2b_operator_action_refuses_whole_plan_after_first_operand() {
    for (kind, operator) in [("IFCBOOLEANRESULT", "$"), ("IFCBOOLEANCLIPPINGRESULT", ".UNION.")] {
        let bytes = fixture(kind, &format!("{operator},#113,#213"));
        for mode in 0..3 {
            let source = SourceBundle::new(bytes.as_bytes().to_vec());
            let mut decoder = source.decoder();
            let router = GeometryRouter::with_units(&bytes, &mut decoder);
            let entity = decoder.decode_by_id(10).unwrap();
            let mut program = program(&entity, &mut decoder, mode);
            let reached = drive(&mut program, &router, &mut decoder);
            let result = finish(program, mode);
            assert!(result.is_err(), "B2b operator action must refuse the whole logical plan");
            assert_eq!(reached.len(), 1, "operator admission remains after the base, before the cutter");
            assert!(matches!(reached[0].value().definition(), LogicalRetainedDefinition::Source { source_id: 113, .. }));
        }
    }
}

#[test]
fn issue_7955_b2b_source_report_distinguishes_missing_attributes_references_and_operators() {
    use BooleanReason::*;
    for (kind, args, site, reason, reached) in [
        ("IFCBOOLEANRESULT", ".DIFFERENCE.", FailureSite::BooleanFirstOperand, OperandAttributeMissing, 0),
        ("IFCBOOLEANRESULT", ".DIFFERENCE.,$,#213", FailureSite::BooleanFirstOperand, OperandReferenceRequired, 0),
        ("IFCBOOLEANRESULT", ".DIFFERENCE.,#113", FailureSite::BooleanSecondOperand, OperandAttributeMissing, 1),
        ("IFCBOOLEANRESULT", ".DIFFERENCE.,#113,$", FailureSite::BooleanSecondOperand, OperandReferenceRequired, 1),
        ("IFCBOOLEANRESULT", "$,#113,#213", FailureSite::BooleanOperator, OperatorRequired, 1),
        ("IFCBOOLEANCLIPPINGRESULT", "$,#113,#213", FailureSite::BooleanOperator, OperatorRequired, 1),
        ("IFCBOOLEANCLIPPINGRESULT", ".UNION.,#113,#213", FailureSite::BooleanOperator, InvalidClippingOperator, 1),
        ("IFCBOOLEANRESULT", ".BOGUS.,#113,#213", FailureSite::BooleanOperator, UnknownOperator, 1),
    ] {
        for mode in 0..3 {
            let failure = run(&fixture(kind, args), mode, reached);
            assert_eq!(failure.site, site);
            assert_eq!(failure.entity, Some(13));
            assert!(matches!(failure.cause, OriginCause::Boolean(actual) if actual == reason),
                "B2b source predicate must retain its actual fact: {failure:?}");
        }
    }
    for token in ["*", "42", "'not a reference'", "(#113)"] {
        for (args, site, reached) in [
            (format!(".DIFFERENCE.,{token},#213"), FailureSite::BooleanFirstOperand, 0),
            (format!(".DIFFERENCE.,#113,{token}"), FailureSite::BooleanSecondOperand, 1),
        ] {
            let failure = run(&fixture("IFCBOOLEANRESULT", &args), 0, reached);
            assert_eq!(failure.site, site);
            assert!(matches!(failure.cause, OriginCause::Boolean(OperandReferenceRequired)));
        }
    }
}

#[test]
fn issue_7955_b2b_core_payload_and_referenced_id_survive_consumption_and_teardown() {
    for mode in 0..3 {
        for (args, site, count) in [
            (".DIFFERENCE.,#999999,#213", FailureSite::BooleanFirstOperand, 0),
            (".DIFFERENCE.,#113,#999999", FailureSite::BooleanSecondOperand, 1),
        ] {
            let (failure, recorded, weak) = {
                let bytes = fixture("IFCBOOLEANRESULT", args);
                let source = SourceBundle::new(bytes.as_bytes().to_vec());
                let weak = Arc::downgrade(&source);
                let mut decoder = source.decoder();
                // Establish the real decoder variant independently; missing-index
                // errors are ParseError here, not invented InvalidEntityRef values.
                assert!(matches!(decoder.decode_by_id(999999), Err(ifc_lite_core::Error::ParseError { position: 0, message })
                    if message == "Entity #999999 not found"));
                let router = GeometryRouter::with_units(&bytes, &mut decoder);
                let entity = decoder.decode_by_id(10).unwrap();
                let mut program = program(&entity, &mut decoder, mode);
                assert_eq!(drive(&mut program, &router, &mut decoder).len(), count);
                let recorded = Arc::downgrade(&program.selection().unwrap().failure_handle().origin().unwrap());
                let failure = finish(program, mode).unwrap_err();
                drop(decoder.try_execution_lease().expect("no retained decoder lease"));
                (failure, recorded, weak)
            };
            assert!(weak.upgrade().is_none());
            std::thread::spawn(move || {
                let failure = origin(failure);
                assert!(Arc::ptr_eq(&failure, &recorded.upgrade().unwrap()));
                assert_eq!(failure.site, site);
                assert_eq!(failure.entity, Some(999999));
                assert!(matches!(&failure.cause, OriginCause::Core(ifc_lite_core::Error::ParseError { position: 0, message })
                    if message == "Entity #999999 not found"), "B2b must preserve actual Core payload: {failure:?}");
            }).join().unwrap();
        }
    }
}

#[test]
fn issue_7955_b2b_strict_decoder_failure_is_not_relabelled_missing_operand() {
    for mode in 0..3 {
        for (id, site, reached) in [(113, FailureSite::BooleanFirstOperand, 0), (213, FailureSite::BooleanSecondOperand, 1)] {
            let bytes = fixture("IFCBOOLEANRESULT", ".DIFFERENCE.,#113,#213")
                .replace(&format!("#{id}=IFCEXTRUDEDAREASOLID(#14,#5,#15,{}.)", if id == 113 { 3 } else { 1 }),
                    &format!("#{id}=IFCEXTRUDEDAREASOLID(#14,#5,#15,1.E999)"));
            let source = SourceBundle::new(bytes.as_bytes().to_vec());
            let mut decoder = source.decoder().with_strict_reals();
            let router = GeometryRouter::with_units(&bytes, &mut decoder);
            let entity = decoder.decode_by_id(10).unwrap();
            let mut program = program(&entity, &mut decoder, mode);
            assert_eq!(drive(&mut program, &router, &mut decoder).len(), reached);
            let failure = origin(finish(program, mode).unwrap_err());
            assert_eq!(failure.site, site);
            assert_eq!(failure.entity, Some(id));
            assert!(matches!(failure.cause, OriginCause::Core(ifc_lite_core::Error::UnrepresentableReal(actual)) if actual == id));
        }
    }
}

#[test]
fn issue_7955_b2b_nested_failure_names_inner_node_and_preserves_source_order() {
    for mode in 0..3 {
        for (replacement, site, id, count) in [
            ("$,#114,#115", FailureSite::BooleanOperator, 213, 2),
            (".UNION.,#999999,#115", FailureSite::BooleanFirstOperand, 999999, 1),
            (".UNION.,#114,#999999", FailureSite::BooleanSecondOperand, 999999, 2),
        ] {
            let failure = run(&nested().replace(".UNION.,#114,#115", replacement), mode, count);
            assert_eq!(failure.site, site);
            assert_eq!(failure.entity, Some(id));
        }
        // A first-operand failure wins over a bad operator and second operand.
        let failure = run(&fixture("IFCBOOLEANRESULT", "$,#999999,#888888"), mode, 0);
        assert_eq!(failure.site, FailureSite::BooleanFirstOperand);
        assert_eq!(failure.entity, Some(999999));
        let failure = run(&fixture("IFCBOOLEANRESULT", "$,#113,#888888"), mode, 1);
        assert_eq!(failure.site, FailureSite::BooleanOperator);
        assert!(matches!(failure.cause, OriginCause::Boolean(BooleanReason::OperatorRequired)));
    }
}

#[test]
fn issue_7955_b2b_valid_operator_controls_keep_ordered_logical_inputs() {
    for mode in 0..3 {
        for (kind, keyword, expected) in [
            ("IFCBOOLEANRESULT", "DIFFERENCE", crate::BoolOp::Difference),
            ("IFCBOOLEANRESULT", "UNION", crate::BoolOp::Union),
            ("IFCBOOLEANRESULT", "INTERSECTION", crate::BoolOp::Intersection),
            ("IFCBOOLEANCLIPPINGRESULT", "DIFFERENCE", crate::BoolOp::Difference),
        ] {
            let bytes = fixture(kind, &format!(".{keyword}.,#113,#213"));
            let source = SourceBundle::new(bytes.as_bytes().to_vec());
            let mut decoder = source.decoder();
            let router = GeometryRouter::with_units(&bytes, &mut decoder);
            let entity = decoder.decode_by_id(10).unwrap();
            let mut program = program(&entity, &mut decoder, mode);
            let reached = drive(&mut program, &router, &mut decoder);
            assert_eq!(reached.len(), 3);
            let RetainedOperationKind::Boolean { inputs, operation } = reached[2].kind() else { panic!("Boolean operation required") };
            assert_eq!(*operation, expected);
            for i in 0..2 { assert_eq!(inputs[i].definition(), reached[i].value().definition()); }
            assert!(program.selection().unwrap().failure_handle().origin().is_none());
            assert_eq!(finish(program, mode).unwrap().values[0].definition(), reached[2].value().definition());
        }
    }
}

#[path = "boolean_origin_protocol_tests.rs"]
mod protocol;
