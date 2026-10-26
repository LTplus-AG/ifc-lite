// SPDX-License-Identifier: MPL-2.0
//! #7955: owned type-map roots share canonical admission, frames and bounds.
use super::*;
#[test]
fn h2a2_owned_type_map_keeps_late_mapping_origin_class_and_fallback_colour() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE,&mut decoder);
    let map = decoder.decode_by_id(61).unwrap();
    let mut program = RetainedProgram::type_map(map,None,contract());
    assert_eq!(drive(&mut program,&router,&mut decoder).len(),1);
    let plan = program.finish_type_map(60,1,[0.2,0.3,0.4,1.]).unwrap();
    assert_eq!(plan.values.len(),1);
    let value = &plan.values[0];
    let frame = value.world_from_source().unwrap();
    assert_eq!([frame[12],frame[13],frame[14]],[10.,20.,30.]);
    assert!(matches!(value.placements()[0].stage,RetainedPlacementStage::TypeMap { representation_map:61 }));
    let binding = value.presentation().last().unwrap();
    assert_eq!(binding.type_product,Some((60,1)));
    assert_eq!(binding.representation_map,Some(61));
    assert_eq!(binding.fallback_color,Some([0.2,0.3,0.4,1.]));
    assert_eq!(plan.remaining, vec![RetainedRequirement::ProductPlacement,
        RetainedRequirement::OpeningClosure, RetainedRequirement::MaterialLayers,
        RetainedRequirement::IfcAppearance, RetainedRequirement::PersistentFaces]);
}
#[test]
fn h2a2_type_map_source_runs_before_late_origin_refusal_even_when_empty() {
    for empty in [false,true] {
        let mut bytes = SOURCE.replace("#61=IFCREPRESENTATIONMAP(#7,#12)","#61=IFCREPRESENTATIONMAP(#999,#12)");
        if empty { bytes = bytes.replace("'SweptSolid',(#13)","'SweptSolid',()"); }
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes,&mut decoder);
        let map = decoder.decode_by_id(61).unwrap();
        let mut program = RetainedProgram::type_map(map,None,contract());
        assert_eq!(drive(&mut program,&router,&mut decoder).len(),usize::from(!empty));
        assert!(program.finish_type_map(60,1,[1.;4]).is_err());
    }
}
#[test]
fn h2a2_type_map_roots_share_one_sticky_work_budget() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE,&mut decoder);
    let traversal = RetainedTraversal::new(contract());
    traversal.selection.as_ref().unwrap().set_work_limit(7);
    let mut first = traversal.type_map(decoder.decode_by_id(61).unwrap(),None);
    assert_eq!(drive(&mut first,&router,&mut decoder).len(),1);
    first.finish_type_map(60,1,[1.;4]).unwrap();
    let mut second = traversal.type_map(decoder.decode_by_id(71).unwrap(),None);
    let stopped = super::mapping_tests::stop(&mut second,&router,&mut decoder);
    assert!(matches!(stopped,RetainedProgramError::Stopped(crate::resource::ProgramStop::ResourceRefused(f))
        if f.dimension == crate::resource::Dimension::Work));
    let mut third = traversal.type_map(decoder.decode_by_id(61).unwrap(),None);
    assert_eq!(third.request().err(),Some(stopped));
}
#[test]
fn h2a2_shared_type_traversal_rejects_foreign_decoder_before_source_execution() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE,&mut decoder);
    let traversal = RetainedTraversal::new(contract());
    let mut first = traversal.type_map(decoder.decode_by_id(61).unwrap(),None);
    drive(&mut first,&router,&mut decoder);
    first.finish_type_map(60,1,[1.;4]).unwrap();
    let mut other = source.decoder();
    let mut next = traversal.type_map(other.decode_by_id(71).unwrap(),None);
    let ticket = next.request().unwrap().unwrap();
    assert_eq!(next.admit(ticket,&router,&mut other).err(),Some(RetainedProgramError::WrongOwner));
}
