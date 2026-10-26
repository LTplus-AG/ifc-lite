// SPDX-License-Identifier: MPL-2.0
//! #7955 H2c: retained Boolean operations follow the common reached spine.
use super::*;
#[path = "boolean_origin_tests.rs"]
mod origins;
pub(super) fn nested() -> String {
    SOURCE.replace("#13=IFCEXTRUDEDAREASOLID", "#13=IFCBOOLEANRESULT(.DIFFERENCE.,#113,#213);#113=IFCEXTRUDEDAREASOLID")
        .replace("ENDSEC;END-ISO", "#213=IFCBOOLEANRESULT(.UNION.,#114,#115);#114=IFCEXTRUDEDAREASOLID(#14,#5,#15,1.);#115=IFCEXTRUDEDAREASOLID(#14,#5,#15,2.);ENDSEC;END-ISO")
}
#[test]
fn h2c_nested_boolean_admits_children_before_ordered_parent_and_never_meshes() {
    let bytes = nested();
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    let operations = drive(&mut program, &router, &mut decoder);
    assert_eq!(operations.len(), 5);
    for operation in &operations[..3] { assert!(operation.construction().is_some()); }
    for (index, kind, left, right) in [(3, crate::BoolOp::Union, 1, 2), (4, crate::BoolOp::Difference, 0, 3)] {
        let RetainedOperationKind::Boolean { inputs, operation } = operations[index].kind() else { panic!("Boolean required") };
        assert_eq!(*operation, kind);
        assert_eq!(inputs[0].definition(), operations[left].value().definition());
        assert_eq!(inputs[1].definition(), operations[right].value().definition());
        assert_eq!(operations[index].value().object_frame(), inputs[0].object_frame());
        assert!(operations[index].construction().is_none());
        assert!(operations[index].value().world_from_source().is_none());
    }
    let plan = program.finish().unwrap();
    assert_eq!(plan.values.len(), 1);
    assert_eq!(plan.values[0].definition(), operations[4].value().definition());
    assert!(plan.values[0].is_product_placed());
}
#[test]
fn h2c_unsupported_boolean_operand_refuses_the_whole_product() {
    let bytes = nested().replace(".UNION.,#114,#115", ".UNION.,#114,#53");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    let reached = drive(&mut program, &router, &mut decoder);
    assert_eq!(reached.len(), 2, "supported constructions are reached before the bad operand");
    assert!(program.finish().is_err(), "no partial Boolean product");
}


#[test]
fn h2c_mapped_operand_uses_common_mapping_and_mixed_cycle_refuses() {
    let bytes = nested().replace(".UNION.,#114,#115", ".UNION.,#314,#115")
        .replace("ENDSEC;END-ISO", "#314=IFCMAPPEDITEM(#315,#316);#315=IFCREPRESENTATIONMAP(#5,#317);#316=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,2.,$);#317=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#114));ENDSEC;END-ISO");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    let operations = drive(&mut program, &router, &mut decoder);
    assert_eq!(operations.len(), 6, "three constructors, mapped physical copy, two Booleans");
    let copy = operations.iter().find(|operation| matches!(operation.kind(), RetainedOperationKind::Affine { .. })).unwrap();
    let union = operations.iter().find(|operation| matches!(operation.kind(), RetainedOperationKind::Boolean { operation: crate::BoolOp::Union, .. })).unwrap();
    let RetainedOperationKind::Boolean { inputs, .. } = union.kind() else { unreachable!() };
    assert_eq!(inputs[0].definition(), copy.value().definition());
    assert_eq!(program.finish().unwrap().values.len(), 1);

    let bytes = bytes.replace("'SweptSolid',(#114)", "'SweptSolid',(#13)");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    let error = super::mapping_tests::stop(&mut program, &router, &mut decoder);
    assert!(matches!(error, RetainedProgramError::Stopped(_)), "{error:?}");
    assert!(program.finish().is_err());
}


#[test]
fn h2c_boolean_admission_resource_refusal_is_typed_and_sticky() {
    use crate::resource::{Dimension, ExecutionAccount, ExecutionPolicy, ResourceLimits, ProgramStop};
    // Unplaced, unstyled operands have no placement/presentation payload to copy.
    // Admission still allocates logical headers and visits the operand values.
    for dimension in [Dimension::LiveBytes, Dimension::Work] {
        let bytes = nested();
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes, &mut decoder);
        let entity = decoder.decode_by_id(10).unwrap();
        let mut program = RetainedProgram::product_parts(&entity, contract());
        let mut constructions = 0;
        let mut refused = false;
        while let Some(ticket) = program.request().unwrap() {
            let ready = matches!(&program.inner.control, Control::Product(control) if control.retained_ready());
            if constructions == 3 && ready {
                let limits = ResourceLimits {
                    live_bytes: (dimension == Dimension::LiveBytes).then_some(0),
                    work: (dimension == Dimension::Work).then_some(0),
                    ..Default::default()
                };
                ExecutionAccount::new(ExecutionPolicy::Bounded(limits)).scope(|| {
                    let error = program.admit(ticket, &router, &mut decoder).err().unwrap();
                    assert!(matches!(error, RetainedProgramError::Stopped(ProgramStop::ResourceRefused(failure)) if failure.dimension == dimension));
                    assert_eq!(program.request().err(), Some(error));
                });
                refused = true;
                break;
            }
            let (reply, operations) = program.admit(ticket, &router, &mut decoder).unwrap();
            constructions += operations.iter().filter(|operation| operation.construction().is_some()).count();
            program.accept(reply, &router).unwrap_or_else(|error| panic!("{:?}", error.error));
        }
        assert!(refused, "fixture must reach a Boolean numerical admission");
    }
}
