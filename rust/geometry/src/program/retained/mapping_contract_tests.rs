// SPDX-License-Identifier: MPL-2.0
//! #7955: complete public-facade plans, including refusal after real admission.
use super::*;

#[test]
fn mapped_later_unsupported_item_refuses_whole_plan() {
    for (later, expected) in [("#53", 1), ("#94", 2)] {
        let bytes = mapping_tests::mapped()
            .replace("'SweptSolid',(#113)", &format!("'SweptSolid',(#113,{later})"))
            .replace("ENDSEC;END-ISO", "#94=IFCBOOLEANRESULT(.UNKNOWN.,#113,#113);ENDSEC;END-ISO");
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes, &mut decoder);
        let entity = decoder.decode_by_id(10).unwrap();
        let mut program = RetainedProgram::product_submeshes(&entity, false, None, contract());
        assert_eq!(drive(&mut program, &router, &mut decoder).len(), expected);
        assert!(program.finish().is_err(), "no partial mapped product for {later}");
        let mut map = RetainedProgram::type_map(decoder.decode_by_id(81).unwrap(), None, contract());
        assert_eq!(drive(&mut map, &router, &mut decoder).len(), expected);
        assert!(map.finish_type_map(60, 1, [1.; 4]).is_err());
    }
}

#[test]
fn distinct_mapped_occurrences_keep_ordered_rigid_frames_and_style_sources() {
    let bytes = mapping_tests::mapped()
        .replace("'SweptSolid',(#13)", "'SweptSolid',(#13,#93)")
        .replace("ENDSEC;END-ISO", "#93=IFCMAPPEDITEM(#81,#94);#94=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#95,#96,#97,1.,$);#95=IFCDIRECTION((0.,1.,0.));#96=IFCDIRECTION((-1.,0.,0.));#97=IFCCARTESIANPOINT((7.,8.,9.));ENDSEC;END-ISO");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_submeshes(&entity, false, None, contract());
    assert_eq!(drive(&mut program, &router, &mut decoder).len(), 1);
    let plan = program.finish().unwrap();
    assert_eq!(plan.values.len(), 2);
    let a = &plan.values[0];
    let b = &plan.values[1];
    assert_eq!(a.definition(), b.definition());
    assert_ne!(a.slot(), b.slot());
    assert_ne!(a.placements()[0].output, b.placements()[0].output);
    assert_eq!(a.presentation().last().unwrap().style_source_id, 13);
    assert_eq!(b.presentation().last().unwrap().style_source_id, 93);
    let frame = nalgebra::Matrix4::from_column_slice(b.world_from_source().unwrap());
    let p = frame * nalgebra::Vector4::new(2., 3., 4., 1.);
    assert_eq!([p.x, p.y, p.z], [14., 30., 43.]);
    assert_eq!(plan.remaining, vec![RetainedRequirement::OpeningClosure,
        RetainedRequirement::MaterialLayers, RetainedRequirement::IfcAppearance,
        RetainedRequirement::PersistentFaces]);
}

#[test]
fn shared_traversal_does_not_reuse_plain_root_presentation_in_styled_root() {
    let bytes = mapping_tests::mapped();
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let traversal = RetainedTraversal::new(contract());
    let mut plain = traversal.product_parts(&entity);
    assert_eq!(drive(&mut plain, &router, &mut decoder).len(), 1);
    assert!(plain.finish().unwrap().values[0].presentation().is_empty());
    let mut styled = traversal.product_submeshes(&entity, false, None);
    assert_eq!(drive(&mut styled, &router, &mut decoder).len(), 1);
    let plan = styled.finish().unwrap();
    let bindings = plan.values[0].presentation();
    assert_eq!(bindings.len(), 2);
    assert_eq!(bindings[0].style_source_id, 113);
    assert_eq!(bindings[1].style_source_id, 13);
}

#[test]
fn mapped_and_type_map_numerical_replies_survive_foreign_and_cancelled_receivers() {
    let bytes = mapping_tests::mapped();
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let foreign_router = GeometryRouter::new();
    let entity = decoder.decode_by_id(10).unwrap();
    for type_root in [false, true] {
        let mut program = if type_root {
            RetainedProgram::type_map(decoder.decode_by_id(81).unwrap(), None, contract())
        } else { RetainedProgram::product_parts(&entity, contract()) };
        let (ticket, reply, operation) = protocol::numerical_reply(&mut program, &router, &mut decoder);
        assert_eq!(program.admit(ticket, &router, &mut decoder).err(), Some(RetainedProgramError::AlreadyExecuted));
        let mut cancelled = RetainedProgram::product_parts(&entity, contract());
        cancelled.cancel();
        let rejected = cancelled.accept(reply, &router).err().unwrap();
        assert_eq!(rejected.error, RetainedProgramError::Cancelled);
        let rejected = program.accept(rejected.reply, &foreign_router).err().unwrap();
        assert_eq!(rejected.error, RetainedProgramError::WrongOwner);
        program.accept(rejected.reply, &router).unwrap_or_else(|e| panic!("{:?}", e.error));
        assert!(drive(&mut program, &router, &mut decoder).is_empty());
        let plan = if type_root { program.finish_type_map(60, 1, [1.; 4]) } else { program.finish() }.unwrap();
        assert_eq!(plan.values.len(), 1);
        assert_eq!(plan.values[0].definition(), operation.value().definition());
    }
    let mut cancelled = RetainedProgram::type_map(decoder.decode_by_id(81).unwrap(), None, contract());
    let (ticket, reply, _) = protocol::numerical_reply(&mut cancelled, &router, &mut decoder);
    cancelled.cancel();
    assert_eq!(cancelled.admit(ticket, &router, &mut decoder).err(), Some(RetainedProgramError::Cancelled));
    assert_eq!(cancelled.accept(reply, &router).err().unwrap().error, RetainedProgramError::Cancelled);
    assert!(cancelled.finish_type_map(60, 1, [1.; 4]).is_err());
}

#[test]
fn exact_type_map_execution_refuses_without_consuming_numerical_ticket() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let mut program = RetainedProgram::type_map(decoder.decode_by_id(61).unwrap(), None, contract());
    let mut refused = 0;
    while let Some(ticket) = program.request().unwrap() {
        if matches!(&program.inner.control, Control::Mapping(c) if c.retained_ready()) {
            assert_eq!(program.inner.execute(ticket.0, &router, &mut decoder).err(), Some(ProgramError::UnsupportedRetained));
            refused += 1;
        }
        let (reply, _) = program.admit(ticket, &router, &mut decoder).unwrap();
        program.accept(reply, &router).unwrap_or_else(|e| panic!("{:?}", e.error));
    }
    assert_eq!(refused, 2, "constructor and late type-map placement admissions");
    assert_eq!(program.finish_type_map(60, 1, [1.; 4]).unwrap().values.len(), 1);
}
