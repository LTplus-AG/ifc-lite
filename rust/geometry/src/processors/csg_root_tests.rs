// SPDX-License-Identifier: MPL-2.0
//! Platform extraction preserves CSG entry admission and failure ownership.
use super::super::{BooleanClippingProcessor, CsgSolidProcessor, OperandPath};
use crate::{BoolFailureReason, Error, GeometryProcessor, TessellationQuality};
use ifc_lite_core::{EntityDecoder, IfcSchema};

#[test]
fn positional_compatible_csg_wrapper_still_builds_its_primitive_volume() {
    let bytes = "#1=IFCPROPERTYSINGLEVALUE(#10,$,$,$);#10=IFCBLOCK($,2.,3.,4.);";
    let mut decoder = EntityDecoder::new(bytes);
    let entity = decoder.decode_by_id(1).unwrap();
    let mesh = CsgSolidProcessor::new()
        .process(
            &entity,
            &mut decoder,
            &IfcSchema::new(),
            TessellationQuality::Medium,
        )
        .unwrap();
    assert!((crate::kernel::mesh_volume::mesh_volume(&mesh) - 24.).abs() < 1e-8);
    assert_eq!(mesh.indices.len(), 36);
}

#[test]
fn csg_root_errors_preserve_exact_admission_and_never_visit_rejected_root_children() {
    for (wrapper, root, expected) in [
        ("#1=IFCCSGSOLID();", "", "IfcCsgSolid missing TreeRootExpression"),
        ("#1=IFCCSGSOLID($);", "", "IfcCsgSolid TreeRootExpression unresolved"),
        ("#1=IFCCSGSOLID(#10);", "#10=IFCCSGSOLID(#99);",
            "IfcCsgSolid TreeRootExpression must be IfcBooleanResult or IfcCsgPrimitive3D, not another IfcCsgSolid (spec violation)"),
        ("#1=IFCCSGSOLID(#10);", "#10=IFCEXTRUDEDAREASOLID(#99,$,$,1.);",
            "Unsupported IfcCsgSolid TreeRootExpression: IfcExtrudedAreaSolid"),
    ] {
        let bytes = format!("{wrapper}{root}#99=IFCCARTESIANPOINT((1.E400,0.,0.));");
        let mut decoder = EntityDecoder::new(&bytes).with_strict_reals();
        let entity = decoder.decode_by_id(1).unwrap();
        let error = CsgSolidProcessor::new().process(&entity, &mut decoder, &IfcSchema::new(),
            TessellationQuality::Medium).unwrap_err();
        assert!(matches!(&error, Error::GeometryError(message) if message == expected), "{error}");
        assert!(decoder.refused_record_ids().is_empty(), "rejected root children remain unused");
    }
}

#[test]
fn csg_guard_rejects_existing_path_entry_without_removing_its_callers_frame() {
    let bytes = "#1=IFCCSGSOLID(#10);#10=IFCBLOCK($,2.,3.,4.);";
    let mut decoder = EntityDecoder::new(bytes);
    let entity = decoder.decode_by_id(1).unwrap();
    let mut path = OperandPath::default();
    assert!(path.insert(1));
    let error = BooleanClippingProcessor::new()
        .execute_csg(
            &entity,
            &mut decoder,
            0,
            TessellationQuality::Medium,
            &mut path,
            true,
        )
        .unwrap_err();
    assert!(matches!(error, Error::GeometryError(message)
        if message=="Cyclic boolean/CSG operand reference at #1"));
    assert_eq!(
        path.len(),
        1,
        "the rejected entry never owned this existing frame"
    );
}

#[test]
fn transient_boolean_failures_leave_csg_processor_even_when_later_operand_errors() {
    let bytes = "#1=IFCCSGSOLID(#2);#2=IFCBOOLEANRESULT(.UNION.,#3,#4);\n\
        #3=IFCPOLYLINE(());#4=IFCCSGSOLID(#4);";
    let mut decoder = EntityDecoder::new(bytes);
    let entity = decoder.decode_by_id(1).unwrap();
    let processor = CsgSolidProcessor::new();
    assert!(processor
        .process(
            &entity,
            &mut decoder,
            &IfcSchema::new(),
            TessellationQuality::Medium
        )
        .is_err());
    let failures = processor.take_failures();
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert_eq!(
        failures[0].reason,
        BoolFailureReason::UnsupportedOperand("IfcPolyline".to_owned())
    );
}
