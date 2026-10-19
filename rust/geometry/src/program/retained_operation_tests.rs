// SPDX-License-Identifier: MPL-2.0
//! Source/control invariants only. Numerical Empty is qualified by SDK witnesses.
use super::*;
use ifc_lite_core::EntityDecoder;
use std::collections::HashSet;

const SOURCE: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCDIRECTION((0.,0.,1.));#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2000.,4000.);
#5=IFCEXTRUDEDAREASOLID(#4,#2,#3,3000.);
#10=IFCWALL('operation',$,$,$,$,$,#11,$,$);
#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));
#12=IFCSHAPEREPRESENTATION($,'Body','CSG',(#50));
#20=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#5));
#21=IFCREPRESENTATIONMAP(#2,#20);
#22=IFCCARTESIANPOINT((5000000000.,7000.,11000.));
#23=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#22,1.,$);
#24=IFCMAPPEDITEM(#21,#23);
#30=IFCBOOLEANRESULT(.DIFFERENCE.,#24,#24);
#50=IFCBOOLEANRESULT(.UNION.,#30,#24);";

#[test]
fn p2_nested_mapping_boolean_preserves_order_definition_sharing_and_survey_frames() {
    let mut decoder=EntityDecoder::new(SOURCE);
    let router=crate::GeometryRouter::with_scale(0.001);
    let mut program=GeometryProgram::retained_parts(decoder.decode_by_id(10).unwrap(),
        RetainedContract {source_epoch:7,source_revision:11});
    let mut definitions=HashSet::new();
    let mut boolean_outputs=Vec::new();
    let mut constructions=0;
    while let Some(request)=program.request().unwrap() {
        let (reply,operations)=program.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
        assert_eq!(program.request().err(),Some(ProgramError::Outstanding));
        for operation in operations {
            match operation.kind() {
                RetainedOperationKind::Construction(_)=> {
                    constructions+=1;definitions.insert(operation.value().definition().clone());
                }
                RetainedOperationKind::Boolean {inputs,operation:kind}=> {
                    assert!(inputs.iter().all(|input|definitions.contains(input.definition())));
                    // The 2m x4m rectangle is centred on its authored origin;
                    // the runtime packet starts at its first corner(-1,-2,0).
                    // Physical object frames therefore include that anchor,
                    // while the original mm source frame retains the map origin.
                    let expected=nalgebra::Matrix4::new_translation(&nalgebra::Vector3::new(4_999_999.,5.,11.));
                    let mut source_frame=nalgebra::Matrix4::new_nonuniform_scaling(&nalgebra::Vector3::repeat(0.001));
                    source_frame[(0,3)]=5_000_000.;source_frame[(1,3)]=7.;source_frame[(2,3)]=11.;
                    for input in inputs {
                        assert!((nalgebra::Matrix4::from_column_slice(input.object_frame())-expected).norm()<1e-9);
                        if let Some(source)=input.world_from_source() {
                            assert!((nalgebra::Matrix4::from_column_slice(source)-source_frame).norm()<1e-9);
                        }
                    }
                    if boolean_outputs.is_empty() {
                        assert_eq!(*kind,crate::document::BooleanOperation::Difference);
                        assert_eq!(inputs[0].definition(),inputs[1].definition(),"reached mapped source is shared");
                        assert_ne!(inputs[0].slot(),inputs[1].slot(),"repeated operand is another occurrence");
                    } else {
                        assert_eq!(*kind,crate::document::BooleanOperation::Union);
                        assert_eq!(inputs[0].slot(),boolean_outputs[0]);
                    }
                    assert!(operation.construction().is_none(),"operation output is not a source recipe");
                    assert!(matches!(operation.value().definition(),LogicalRetainedDefinition::Operation(_)));
                    boolean_outputs.push(operation.value().slot());
                    definitions.insert(operation.value().definition().clone());
                }
                RetainedOperationKind::Affine {..}=>panic!("proper rigid mapping stays metadata"),
            }
        }
        program.accept(reply,&router).unwrap();
    }
    let plan=program.finish_retained().unwrap();
    assert_eq!(constructions,1);
    assert_eq!(boolean_outputs.len(),2);
    assert_eq!(plan.values.len(),1);
    assert!(!plan.remaining.is_empty(),"source plan is never final-net qualification");
}

#[test]
fn p2_actual_empty_control_binding_skips_unreached_rhs_and_rejects_foreign_output_slot() {
    // This is a continuation witness using an injected classification, not a
    // certificate or proof of numerical A-A. The SDK test executes that arithmetic.
    let source=SOURCE.replace(".UNION.,#30,#24", ".DIFFERENCE.,#30,#999");
    let mut decoder=EntityDecoder::new(&source);
    let router=crate::GeometryRouter::with_scale(0.001);
    let mut program=GeometryProgram::retained_parts(decoder.decode_by_id(10).unwrap(),
        RetainedContract {source_epoch:7,source_revision:11});
    let mut constructions=0;
    let mut booleans=0;
    let mut source_slot=None;
    while let Some(request)=program.request().unwrap() {
        let (mut reply,operations)=program.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
        for operation in operations {
            match operation.kind() {
                RetainedOperationKind::Construction(_)=>{constructions+=1;source_slot=Some(operation.value().slot());}
                RetainedOperationKind::Boolean {..}=> {
                    assert!(reply.bind_retained_outcome(source_slot.unwrap(),true).is_err());
                    reply.bind_retained_outcome(operation.value().slot(),true).unwrap();booleans+=1;
                }
                _=>panic!("unexpected affine"),
            }
        }
        program.accept(reply,&router).unwrap();
    }
    let plan=program.finish_retained().unwrap();
    assert_eq!((constructions,booleans),(1,1));
    assert!(plan.values[0].is_empty());
    assert!(decoder.get_cached(999).is_none(),"empty difference never admits its later operand");
}

#[test]
fn p2_halfspace_is_precise_residual_and_never_becomes_giant_retained_cutter() {
    let source=format!("{}#60=IFCPLANE(#2);#61=IFCHALFSPACESOLID(#60,.T.);",
        SOURCE.replace(".UNION.,#30,#24", ".DIFFERENCE.,#24,#61"));
    let mut decoder=EntityDecoder::new(&source);
    let router=crate::GeometryRouter::with_scale(0.001);
    let mut program=GeometryProgram::retained_parts(decoder.decode_by_id(10).unwrap(),
        RetainedContract {source_epoch:7,source_revision:11});
    while let Some(request)=program.request().unwrap() {
        let (reply,operations)=program.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
        assert!(operations.iter().all(|operation|matches!(operation.kind(),RetainedOperationKind::Construction(_))));
        program.accept(reply,&router).unwrap();
    }
    let error=program.finish_retained().unwrap_err().to_string();
    assert!(error.contains("halfspace/clipping"),"{error}");
}

#[test]
fn p2_rigid_mapped_boolean_keeps_original_operation_definition_and_explicit_frame() {
    let source="#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);
        #3=IFCDIRECTION((0.,0.,1.));#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);
        #5=IFCEXTRUDEDAREASOLID(#4,#2,#3,3.);
        #10=IFCWALL('placed',$,$,$,$,$,#11,$,$);#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));
        #12=IFCSHAPEREPRESENTATION($,'Body','CSG',(#30));
        #20=IFCBOOLEANRESULT(.UNION.,#5,#5);
        #21=IFCSHAPEREPRESENTATION($,'Body','CSG',(#20));#22=IFCREPRESENTATIONMAP(#2,#21);
        #23=IFCCARTESIANPOINT((10.,20.,30.));#24=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#23,1.,$);
        #25=IFCMAPPEDITEM(#22,#24);#30=IFCBOOLEANRESULT(.UNION.,#25,#5);";
    let mut decoder=EntityDecoder::new(source);let router=crate::GeometryRouter::new();
    let mut program=GeometryProgram::retained_parts(decoder.decode_by_id(10).unwrap(),
        RetainedContract {source_epoch:7,source_revision:11});
    let mut outputs=Vec::new();let mut polls=0;
    while let Some(request)=program.request().unwrap() {
        polls+=1;assert!(polls<1000);
        let (reply,operations)=program.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
        for operation in operations {
            match operation.kind() {
                RetainedOperationKind::Construction(_)=>{},
                RetainedOperationKind::Affine {..}=>panic!("proper-rigid derived placement needs no rational conversion"),
                RetainedOperationKind::Boolean {inputs,..}=> {
                    if outputs.is_empty() {
                        assert_eq!(operation.value().world_from_evaluation(),
                            nalgebra::Matrix4::new_translation(&nalgebra::Vector3::new(-1.,-2.,0.)));
                    } else {
                        assert_eq!(inputs[0].definition(),&LogicalRetainedDefinition::Operation(outputs[0]));
                        assert_ne!(inputs[0].slot(),outputs[0],"mapping is a distinct occurrence");
                        assert_eq!(inputs[0].world_from_evaluation(),
                            nalgebra::Matrix4::new_translation(&nalgebra::Vector3::new(9.,18.,30.)));
                        assert_eq!(inputs[0].placements().last().unwrap().matrix[12..15],[10.,20.,30.]);
                    }
                    outputs.push(operation.value().slot());
                }
            }
        }
        program.accept(reply,&router).unwrap();
    }
    let plan=program.finish_retained().unwrap();assert_eq!(outputs.len(),2);
    assert_eq!(plan.values.len(),1);assert!(!plan.remaining.is_empty());
}
