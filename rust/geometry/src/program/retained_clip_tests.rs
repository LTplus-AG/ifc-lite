// SPDX-License-Identifier: MPL-2.0
//! Source/control invariants only; all new tests UNRUN. No numerical proof.
use super::*;
use ifc_lite_core::EntityDecoder;

fn source(operator:&str, agreement:&str, bounded:bool) -> String {
    let subtype=if bounded {"IFCPOLYGONALBOUNDEDHALFSPACE(#60,.T.,#2,#999)"}
        else if agreement=="T" {"IFCHALFSPACESOLID(#60,.T.)"} else {"IFCHALFSPACESOLID(#60,.F.)"};
    format!("#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);
        #3=IFCDIRECTION((0.,0.,1.));#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2000.,4000.);
        #5=IFCEXTRUDEDAREASOLID(#4,#2,#3,3000.);
        #10=IFCWALL('clip',$,$,$,$,$,#11,$,$);#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));
        #12=IFCSHAPEREPRESENTATION($,'Body','CSG',(#50));
        #20=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#5));#21=IFCREPRESENTATIONMAP(#2,#20);
        #22=IFCCARTESIANPOINT((5000000000.,7000.,11000.));
        #23=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#22,1.,$);#24=IFCMAPPEDITEM(#21,#23);
        #50=IFCBOOLEANRESULT(.{operator}.,#24,#61);
        #55=IFCCARTESIANPOINT((5000000000.,7000.,12500.));#56=IFCDIRECTION((0.,0.,2.));
        #57=IFCAXIS2PLACEMENT3D(#55,#56,$);#60=IFCPLANE(#57);#61={subtype};")
}
#[test]
fn p2_plain_plane_reached_unary_keeps_raw_provenance_and_selected_local_metres() {
    for operator in ["DIFFERENCE","INTERSECTION"] { for agreement in ["T","F"] {
        let source=source(operator,agreement,false);
        let mut decoder=EntityDecoder::new(&source);
        let router=crate::GeometryRouter::with_scale(0.001);
        let mut program=GeometryProgram::retained_parts(decoder.decode_by_id(10).unwrap(),
            RetainedContract {source_epoch:7,source_revision:11});
        let mut clips=0;let mut constructions=0;
        while let Some(request)=program.request().unwrap() {
            let (reply,operations)=program.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
            for operation in operations { match operation.kind() {
                RetainedOperationKind::Construction(_)=>constructions+=1,
                RetainedOperationKind::UnaryClip {input,clip}=> {
                    assert_eq!(clip.source.axis,Some(RetainedPlaneCoefficients {source_id:56,arity:3,values:[0.,0.,2.]} ));
                    assert_eq!(clip.source.location,Some(RetainedPlaneCoefficients {source_id:55,arity:3,values:[5000000000.,7000.,12500.]} ));
                    assert_eq!((clip.source.boolean_id,clip.source.half_space_id,clip.source.base_surface_id,clip.source.position_id),(50,61,60,57));
                    assert_eq!((clip.source.source_epoch,clip.source.source_revision),(7,11));
                    assert_eq!(clip.source.agreement,agreement=="T");
                    assert_eq!(clip.source.length_unit_scale,0.001);
                    assert_eq!(clip.source_plane,[5000000000.,7000.,12500.,0.,0.,1.]);
                    for (actual,expected) in clip.local_plane.iter().zip([1.,2.,1.5,0.,0.,1.]) {
                        assert!((actual-expected).abs()<1e-9);
                    }
                    assert_eq!(&clip.input_frame,input.object_frame());
                    assert_eq!(operation.value().object_frame(),input.object_frame());
                    assert_ne!(operation.value().slot(),input.slot());
                    assert_eq!(operation.value().presentation(),input.presentation());
                    assert_eq!(operation.value().placements(),input.placements());
                    assert!(matches!(operation.value().definition(),LogicalRetainedDefinition::Operation(_)));
                    assert!(operation.construction().is_none());clips+=1;
                }
                _=>panic!("unexpected non-unary operation"),
            }}
            program.accept(reply,&router).unwrap();
        }
        let plan=program.finish_retained().unwrap();
        assert_eq!((constructions,clips),(1,1));
        assert!(plan.remaining.contains(&RetainedRequirement::OpeningClosure));
        assert!(plan.remaining.contains(&RetainedRequirement::MaterialLayers));
    }}
}
#[test]
fn p2_bounded_and_unbounded_union_remain_explicit_residuals_without_boundary_reach() {
    for (operator,bounded,needle) in [("UNION",false,"unbounded"),("DIFFERENCE",true,"polygonally bounded")] {
        let source=source(operator,"T",bounded);let mut decoder=EntityDecoder::new(&source);
        let router=crate::GeometryRouter::with_scale(0.001);
        let mut program=GeometryProgram::retained_parts(decoder.decode_by_id(10).unwrap(),
            RetainedContract {source_epoch:7,source_revision:11});
        while let Some(request)=program.request().unwrap() {
            let (reply,operations)=program.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
            assert!(operations.iter().all(|op|matches!(op.kind(),RetainedOperationKind::Construction(_))));
            program.accept(reply,&router).unwrap();
        }
        assert!(program.finish_retained().unwrap_err().to_string().contains(needle));
        assert!(decoder.get_cached(999).is_none());
    }
}
#[test]
fn p2_unary_empty_binding_keeps_original_slot_and_lazy_later_operand() {
    // Injected control classification only. SDK witnesses must supply real Empty.
    let source=source("INTERSECTION","T",false).replace("'CSG',(#50)","'CSG',(#70)")+
        "#70=IFCBOOLEANRESULT(.DIFFERENCE.,#50,#999);";
    let mut decoder=EntityDecoder::new(&source);let router=crate::GeometryRouter::with_scale(0.001);
    let mut program=GeometryProgram::retained_parts(decoder.decode_by_id(10).unwrap(),
        RetainedContract {source_epoch:7,source_revision:11});let mut clips=0;
    while let Some(request)=program.request().unwrap() {
        let (mut reply,operations)=program.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
        for operation in operations {if let RetainedOperationKind::UnaryClip {input,..}=operation.kind() {
            assert!(reply.bind_retained_outcome(input.slot(),true).is_err());
            reply.bind_retained_outcome(operation.value().slot(),true).unwrap();clips+=1;
        }}
        program.accept(reply,&router).unwrap();
    }
    assert_eq!(clips,1);assert!(program.finish_retained().unwrap().values[0].is_empty());
    assert!(decoder.get_cached(999).is_none());
}

#[test]
fn p2_rotated_input_uses_point_inverse_and_normal_covector_without_double_units() {
    let source=source("INTERSECTION","T",false)
        .replace("IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#22,1.,$)","IFCCARTESIANTRANSFORMATIONOPERATOR3D(#80,$,#22,1.,#81)")
        .replace("IFCDIRECTION((0.,0.,2.))","IFCDIRECTION((2.,0.,2.))")+
        "#80=IFCDIRECTION((0.,1.,0.));#81=IFCDIRECTION((0.,0.,1.));";
    let mut decoder=EntityDecoder::new(&source);let router=crate::GeometryRouter::with_scale(0.001);
    let mut program=GeometryProgram::retained_parts(decoder.decode_by_id(10).unwrap(),
        RetainedContract {source_epoch:7,source_revision:11});let mut clips=0;
    while let Some(request)=program.request().unwrap() {
        let (reply,operations)=program.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
        for operation in operations {if let RetainedOperationKind::UnaryClip {clip,..}=operation.kind() {
            let n=nalgebra::Vector3::new(clip.source_plane[3],clip.source_plane[4],clip.source_plane[5]);
            let p=nalgebra::Vector3::new(clip.source_plane[0],clip.source_plane[1],clip.source_plane[2])*0.001;
            let frame=nalgebra::Matrix4::from_column_slice(&clip.input_frame);
            let local_n=nalgebra::Vector3::new(clip.local_plane[3],clip.local_plane[4],clip.local_plane[5]);
            let local_p=nalgebra::Vector3::new(clip.local_plane[0],clip.local_plane[1],clip.local_plane[2]);
            for sample in [[0.,0.,0.],[2.,4.,3.],[-7.,5.,11.]] {
                let local=nalgebra::Vector3::from_column_slice(&sample);
                let world=frame*nalgebra::Vector4::new(local.x,local.y,local.z,1.);
                let world=nalgebra::Vector3::new(world.x,world.y,world.z);
                assert!((local_n.dot(&(local-local_p))-n.dot(&(world-p))).abs()<1e-8);
            }
            assert!(local_n.x.abs()<1e-12);assert!(local_n.y<0. && local_n.z>0.);clips+=1;
        }}
        program.accept(reply,&router).unwrap();
    }
    program.finish_retained().unwrap();assert_eq!(clips,1);
}

#[test]
fn p2_reflected_and_nonuniform_mapped_hosts_clip_in_actual_baked_metre_frame() {
    for (mapping,determinant) in [("IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#22,-1.,$)",-1.),
        ("IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#22,2.,$,3.,4.)",24.)] {
        let source=source("INTERSECTION","T",false)
            .replace("IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#22,1.,$)",mapping);
        let mut decoder=EntityDecoder::new(&source);let router=crate::GeometryRouter::with_scale(0.001);
        let mut program=GeometryProgram::retained_parts(decoder.decode_by_id(10).unwrap(),
            RetainedContract {source_epoch:7,source_revision:11});let mut baked=None;let mut clips=0;
        while let Some(request)=program.request().unwrap() {
            let (reply,operations)=program.admit_retained_with_inputs(request,&router,&mut decoder,None,None).unwrap();
            for operation in operations {match operation.kind() {
                RetainedOperationKind::Affine {matrix,..}=> {
                    let matrix=nalgebra::Matrix4::from_column_slice(matrix);
                    assert!((matrix.fixed_view::<3,3>(0,0).determinant()-determinant).abs()<1e-12);
                    baked=Some(operation.value().slot());
                }
                RetainedOperationKind::UnaryClip {input,clip}=> {
                    assert_eq!(Some(input.slot()),baked,"physical bake must precede unary capture");
                    assert_eq!(clip.input_frame,crate::math::mat4::col_major_array(&nalgebra::Matrix4::identity()));
                    assert_eq!(clip.local_plane,[5_000_000.,7.,12.5,0.,0.,1.]);
                    assert_eq!(clip.source_plane,[5000000000.,7000.,12500.,0.,0.,1.]);clips+=1;
                }
                RetainedOperationKind::Construction(_)=>{},
                _=>panic!("unexpected binary operation"),
            }}
            program.accept(reply,&router).unwrap();
        }
        program.finish_retained().unwrap();assert!(baked.is_some());assert_eq!(clips,1);
    }
}
