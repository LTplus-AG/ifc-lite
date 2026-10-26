// SPDX-License-Identifier: MPL-2.0
//! #7955 S3: classifications follow real admitted definitions, never product closure.
use super::*;

#[test]
fn s3_outcome_reaches_cached_occurrences_without_discharging_obligations() {
    let bytes = mapping_tests::mapped().replace("'SweptSolid',(#13)", "'SweptSolid',(#13,#13)");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_submeshes(&entity, true, None, contract());
    let operations = drive(&mut program, &router, &mut decoder);
    let plan = program.finish().unwrap();
    assert_eq!(operations.len(), 1, "cache retains one source definition");
    assert_eq!(plan.values.len(), 2, "two placed occurrences survive");
    assert_ne!(plan.values[0].slot(), plan.values[1].slot());
    assert!(plan.values.iter().all(|value| value.evaluated_empty().is_none()));
    operations[0].bind_numerical_outcome(true).unwrap();
    assert!(plan.values.iter().all(LogicalRetainedValue::is_empty));
    operations[0].bind_numerical_outcome(true).unwrap();
    assert!(operations[0].bind_numerical_outcome(false).is_err(), "conflict cannot rewrite accepted outcome");
    assert!(plan.values.iter().all(LogicalRetainedValue::is_empty));
    assert_eq!(plan.remaining, vec![RetainedRequirement::OpeningClosure,
        RetainedRequirement::MaterialLayers, RetainedRequirement::IfcAppearance,
        RetainedRequirement::PersistentFaces], "empty annotation grants no removal or closure authority");
}

#[test]
fn s3_affine_output_does_not_alias_its_input_classification() {
    let bytes = mapping_tests::mapped().replace("#84,1.,$", "#84,2.,$");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    let operations = drive(&mut program, &router, &mut decoder);
    assert_eq!(operations.len(), 2);
    let RetainedOperationKind::Affine { input, .. } = operations[1].kind() else { panic!("affine operation required") };
    operations[0].bind_numerical_outcome(false).unwrap();
    assert_eq!(input.evaluated_empty(), Some(false));
    assert_eq!(operations[1].value().evaluated_empty(), None, "new physical operation needs its own outcome");
    operations[1].bind_numerical_outcome(true).unwrap();
    assert_eq!(input.evaluated_empty(), Some(false));
    assert!(program.finish().unwrap().values[0].is_empty());
}

#[test]
fn s3_boolean_outcomes_follow_ordered_dependencies_without_aliasing() {
    let bytes = boolean_tests::nested();
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    let operations = drive(&mut program, &router, &mut decoder);
    assert_eq!(operations.len(), 5);
    for operation in &operations[..3] { operation.bind_numerical_outcome(false).unwrap(); }
    operations[3].bind_numerical_outcome(true).unwrap();
    let RetainedOperationKind::Boolean { inputs, operation } = operations[4].kind() else { panic!("Boolean required") };
    assert_eq!(*operation, crate::BoolOp::Difference);
    assert_eq!(inputs[0].evaluated_empty(), Some(false));
    assert_eq!(inputs[1].evaluated_empty(), Some(true));
    assert_eq!(operations[4].value().evaluated_empty(), None);
    operations[4].bind_numerical_outcome(false).unwrap();
    let plan = program.finish().unwrap();
    assert_eq!(plan.values[0].evaluated_empty(), Some(false));
    assert_eq!(plan.remaining.len(), 4);
}
