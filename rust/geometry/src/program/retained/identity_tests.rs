// SPDX-License-Identifier: MPL-2.0
//! #7955 B2c: corrupt only the logical invariant on a real admitted source.
use super::*;
use crate::program::inner::retained_program::RetainedProgram;
use crate::program::retained::value_error::ValueError;

fn admitted() -> LogicalRetainedValue {
    let source = ifc_lite_core::SourceBundle::new(b"ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCDIRECTION((0.,0.,1.));#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);
#5=IFCEXTRUDEDAREASOLID(#4,#2,#3,3.);#6=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#2,$);
#7=IFCSHAPEREPRESENTATION(#6,'Body','SweptSolid',(#5));#8=IFCPRODUCTDEFINITIONSHAPE($,$,(#7));
#9=IFCLOCALPLACEMENT($,#2);#10=IFCWALL('w',$,$,$,$,#9,#8,$,$);
ENDSEC;END-ISO-10303-21;".to_vec());
    let mut decoder = source.decoder();
    let router = crate::GeometryRouter::new();
    let wall = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&wall, RetainedContract { source_epoch: 7, source_revision: 9 });
    let mut operations = Vec::new();
    while let Some(ticket) = program.request().unwrap() {
        let (reply, reached) = program.admit(ticket, &router, &mut decoder).unwrap();
        operations.extend(reached);
        program.accept(reply, &router).unwrap_or_else(|error| panic!("{:?}", error.error));
    }
    assert_eq!(program.finish().unwrap().values.len(), 1);
    assert_eq!(operations.len(), 1);
    operations.pop().unwrap().value
}

#[test]
fn issue_7955_identity_predicates_keep_the_first_fact_and_never_mutate_the_value() {
    let original = admitted();
    for reason in [ValueReason::SourceProgram, ValueReason::MissingSourceId, ValueReason::SourceEpoch,
        ValueReason::SourceRevision, ValueReason::OperationProgram, ValueReason::UnitDomain] {
        let mut value = original.try_copy().unwrap();
        match reason {
            ValueReason::SourceProgram => {
                let LogicalRetainedDefinition::Source { slot, .. } = &mut value.definition else { unreachable!() };
                slot.program += 1;
            }
            ValueReason::MissingSourceId => {
                let LogicalRetainedDefinition::Source { source_id, .. } = &mut value.definition else { unreachable!() };
                *source_id = 0;
            }
            ValueReason::SourceEpoch => value.contract.source_epoch += 1,
            ValueReason::SourceRevision => value.contract.source_revision += 1,
            ValueReason::OperationProgram => {
                let mut slot = value.slot;
                slot.program += 1;
                value.definition = LogicalRetainedDefinition::Operation(slot);
            }
            ValueReason::UnitDomain => {}
            _ => unreachable!(),
        }
        // Invalid identity must precede invalid units, domain and frame.
        value.length_unit_scale = -1.;
        let before = value.try_copy().unwrap();
        assert_eq!(value.validate_identity(), Err(reason));
        assert!(matches!(value.bake(), Err(ValueError::Fact(actual)) if actual == reason));
        assert!(matches!(value.place_in_place(&nalgebra::Matrix4::zeros(), value.slot.program + 1,
            RetainedPlacementStage::Product { product_id: 10 }), Err(ValueError::Fact(actual)) if actual == reason));
        assert_eq!(value, before);
    }
    for scale in [0., -1., f64::INFINITY, f64::NAN] {
        let mut value = original.try_copy().unwrap();
        value.length_unit_scale = scale;
        assert_eq!(value.validate_identity(), Err(ValueReason::UnitDomain));
    }
    assert!(original.validate_identity().is_ok());
}
