// SPDX-License-Identifier: MPL-2.0
//! #7955 actual source plane capture in the shared retained Boolean traversal.
use super::*;
use ifc_lite_testkit::retained_clip::SOURCE as CLIP_SOURCE;
#[test]
fn j1_source_plane_and_order_survive_shared_controller() {
    for case in ifc_lite_testkit::retained_clip::cases() {
        let source = SourceBundle::new(case.source.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&case.source, &mut decoder);
        let entity = decoder.decode_by_id(10).unwrap();
        let mut program = RetainedProgram::product_parts(&entity, contract());
        let operations = drive(&mut program, &router, &mut decoder);
        let mut clips=0;
        for (index, operation) in operations.iter().enumerate() {
            if let RetainedOperationKind::UnaryClip { input, clip } = operation.kind() {
                clips+=1;
                assert!(operations[..index].iter().any(|o| o.value().definition()==input.definition()));
                assert_eq!(clip.source.source_epoch, 7); assert_eq!(clip.source.source_revision, 9);
                assert_eq!(clip.source.length_unit_scale,1.);
                assert_eq!(clip.input_frame,*input.object_frame());
                let z=if clip.source.half_space_id==303 {2.} else {1.};
                assert_eq!(clip.source.location.as_ref().unwrap().values,[0.,0.,z]);
                assert_eq!(clip.source_plane,[0.,0.,z,0.,0.,1.]);
                let p=nalgebra::Matrix4::from_column_slice(&clip.input_frame)*nalgebra::Vector4::new(clip.local_plane[0],clip.local_plane[1],clip.local_plane[2],1.);
                assert!((p.z-z).abs()<1e-12);
                assert!(operation.construction().is_none());
            }
        }
        assert_eq!(clips,if case.name=="clip_of_clip" {2} else {1});
    }
}
#[test]
fn j1_unsupported_and_malformed_planes_refuse_whole_continuation() {
    // #7955: source errors travel in RetainedComplete replies; the whole
    // continuation refuses at finish(), not through the ticket protocol.
    for (case, source) in [
        ("union", CLIP_SOURCE.replace(".DIFFERENCE.", ".UNION.")),
        ("boxed", CLIP_SOURCE.replace("IFCHALFSPACESOLID(#202,.T.)", "IFCBOXEDHALFSPACE(#202,.T.,$)")),
        ("bounded", CLIP_SOURCE.replace("IFCHALFSPACESOLID(#202,.T.)", "IFCPOLYGONALBOUNDEDHALFSPACE(#202,.T.,#5,$)")),
        ("missing agreement", CLIP_SOURCE.replace("#202,.T.", "#202,$")),
        ("missing location", CLIP_SOURCE.replace("#200,#15,$", "$,#15,$")),
    ] {
        let source = SourceBundle::new(source.into_bytes());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(source.bytes(), &mut decoder);
        let entity = decoder.decode_by_id(10).unwrap();
        let mut program = RetainedProgram::product_parts(&entity, contract());
        let operations = drive(&mut program, &router, &mut decoder);
        assert_eq!(operations.len(), 1, "{case}: only the input construction may be admitted");
        assert!(operations[0].construction().is_some(), "{case}: no clip may be admitted");
        assert!(program.finish().is_err(), "{case}: malformed/unsupported clip must refuse the whole continuation");
    }
}
#[test]
fn j1_clip_capture_bound_reports_sticky_stop() {
    let source=SourceBundle::new(CLIP_SOURCE.as_bytes().to_vec());
    let mut decoder=source.decoder(); let router=GeometryRouter::with_units(source.bytes(),&mut decoder);
    let entity=decoder.decode_by_id(10).unwrap();
    let mut program=RetainedProgram::product_parts(&entity,contract());
    let input=loop {
        let ticket=program.request().unwrap().unwrap();
        let (reply,operations)=program.admit(ticket,&router,&mut decoder).unwrap();
        program.accept(reply,&router).unwrap_or_else(|e|panic!("{:?}",e.error));
        if let Some(operation)=operations.first() {break operation.value().try_copy().unwrap();}
    };
    let selection=program.selection().unwrap();
    selection.set_work_limit(0);
    let half_space=decoder.decode_by_id(203).unwrap();
    let result=selection.capture_clip(&half_space,&mut decoder,&input,crate::BoolOp::Difference,13);
    assert!(matches!(result,Err(crate::Error::ProgramStopped(_))),"clip must bound and report typed work refusal");
    assert!(selection.check().is_err(),"clip refusal must remain sticky");
    assert!(matches!(program.request(),Err(RetainedProgramError::Stopped(_))));
}

#[test]
fn j1_source_scale_and_foreign_domain_are_not_inferred_from_plane_bits() {
    let text=CLIP_SOURCE.replace("$,.METRE.",".MILLI.,.METRE.");
    let source=SourceBundle::new(text.as_bytes().to_vec());
    let mut decoder=source.decoder(); let router=GeometryRouter::with_units(&text,&mut decoder);
    let entity=decoder.decode_by_id(10).unwrap();
    let mut a=RetainedProgram::product_parts(&entity,contract());
    let operations=drive(&mut a,&router,&mut decoder);
    let RetainedOperationKind::UnaryClip {input,clip} = operations[1].kind() else {panic!("clip")};
    assert_eq!(clip.source.length_unit_scale,0.001);
    assert_eq!(clip.source_plane[2],1.);
    let p=nalgebra::Matrix4::from_column_slice(&clip.input_frame)*nalgebra::Vector4::new(clip.local_plane[0],clip.local_plane[1],clip.local_plane[2],1.);
    assert!((p.z-0.001).abs()<1e-12);
    let b=RetainedProgram::product_parts(&entity,contract());
    let half=decoder.decode_by_id(203).unwrap();
    assert!(b.selection().unwrap().capture_clip(&half,&mut decoder,input,crate::BoolOp::Difference,13).is_err());
}
