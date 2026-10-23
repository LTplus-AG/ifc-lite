// SPDX-License-Identifier: MPL-2.0
//! #7955 H2a2: reached mapping is a logical occurrence of a real construction.
use super::*;
pub(super) fn mapped() -> String {
    SOURCE.replace("#13=IFCEXTRUDEDAREASOLID", "#13=IFCMAPPEDITEM(#81,#82);#113=IFCEXTRUDEDAREASOLID")
        .replace("ENDSEC;END-ISO", "#81=IFCREPRESENTATIONMAP(#5,#83);#82=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#84,1.,$);#83=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#113));#84=IFCCARTESIANPOINT((2.,4.,6.));ENDSEC;END-ISO")
}
#[test]
fn h2a2_repeated_maps_share_one_definition_and_preserve_every_placed_occurrence() {
    let bytes = mapped().replace("'SweptSolid',(#13)", "'SweptSolid',(#13,#13)");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    let operations = drive(&mut program, &router, &mut decoder);
    assert_eq!(operations.len(), 1, "one reached source construction, not an exact mesh hit");
    let plan = program.finish().unwrap();
    assert_eq!(plan.values.len(), 2);
    assert_eq!(plan.values[0].definition(), plan.values[1].definition());
    assert_ne!(plan.values[0].slot(), plan.values[1].slot());
    for value in &plan.values {
        assert!(value.is_product_placed());
        assert_eq!(value.placements().len(), 2);
        let world = value.world_from_source().unwrap();
        assert_eq!([world[12], world[13], world[14]], [12.,24.,36.]);
    }
}
#[test]
fn h2a2_millimetre_mapping_translates_once_and_exact_warm_cache_does_not_discharge_work() {
    let bytes = mapped().replace("$,.METRE.", ".MILLI.,.METRE.");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let item = decoder.decode_by_id(13).unwrap();
    assert!(!GeometryProgram::mapped_item(&item).drain_parts(&router, &mut decoder).unwrap().is_empty());
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    assert_eq!(drive(&mut program, &router, &mut decoder).len(), 1);
    let plan = program.finish().unwrap();
    let world = plan.values[0].world_from_source().unwrap();
    for (got, expected) in [world[12],world[13],world[14]].into_iter().zip([0.012,0.024,0.036]) {
        assert!((got-expected).abs()<1e-12);
    }
}
pub(super) fn stop(program: &mut RetainedProgram, router: &GeometryRouter, decoder: &mut EntityDecoder) -> RetainedProgramError {
    loop {
        let ticket = match program.request() { Err(e) => return e, Ok(Some(t)) => t, Ok(None) => panic!("expected typed refusal") };
        let (reply, _) = match program.admit(ticket, router, decoder) { Ok(r) => r, Err(e) => return e };
        if let Err(rejected) = program.accept(reply, router) { return rejected.error; }
    }
}
#[test]
fn h2a2_mapping_cycles_report_a_sticky_typed_refusal() {
    let bytes = mapped().replace("'SweptSolid',(#113)", "'SweptSolid',(#13)");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    let first = stop(&mut program, &router, &mut decoder);
    assert!(matches!(first, RetainedProgramError::Stopped(crate::resource::ProgramStop::ResourceRefused(f))
        if f.dimension == crate::resource::Dimension::Representation && f.requested == 2));
    assert_eq!(program.request().err(), Some(first));
}
#[test]
fn h2a2_diamond_keeps_256_occurrences_and_work_refusal_is_sticky() {
    let bytes = mapped().replace("#13=IFCMAPPEDITEM(#81,#82)", "#13=IFCMAPPEDITEM(#92,#82)")
        .replace("ENDSEC;END-ISO", &format!("#91=IFCMAPPEDITEM(#81,#82);#92=IFCREPRESENTATIONMAP(#5,#93);#93=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',({}));ENDSEC;END-ISO", vec!["#91";256].join(",")));
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    assert_eq!(drive(&mut program, &router, &mut decoder).len(), 1);
    assert_eq!(program.finish().unwrap().values.len(), 256);
    let mut limited = RetainedProgram::product_parts(&entity, contract());
    let Control::Product(control) = &limited.inner.control else { panic!("product") };
    control.retained_selection().unwrap().set_work_limit(40);
    let first = stop(&mut limited, &router, &mut decoder);
    assert!(matches!(first, RetainedProgramError::Stopped(crate::resource::ProgramStop::ResourceRefused(f)) if f.dimension == crate::resource::Dimension::Work));
    assert_eq!(limited.request().err(), Some(first));
}
#[test]
fn h2a2_retained_cache_refuses_a_foreign_decoder_before_reusing_definitions() {
    let bytes = mapped();
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    drive(&mut program, &router, &mut decoder);
    let Control::Product(control) = &program.inner.control else { panic!("product") };
    let selection = control.retained_selection().unwrap();
    assert!(selection.cached(&decoder, &router, 81).unwrap().is_some());
    let other = source.decoder();
    assert!(selection.cached(&other, &router, 81).unwrap_err().to_string().contains("provenance"));
}
#[test]
fn h2a2_cached_acyclic_fanout_debits_work_before_copying_expanding_values() {
    // #7955: a visited set/depth guard cannot bound a successful binary DAG.
    let mut declarations = String::new();
    let mut previous_source = 81;
    for level in 0..12 {
        let item = 300 + level * 10;
        let source = item + 1;
        let rep = item + 2;
        declarations.push_str(&format!("#{item}=IFCMAPPEDITEM(#{previous_source},#82);#{source}=IFCREPRESENTATIONMAP(#5,#{rep});#{rep}=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#{item},#{item}));"));
        previous_source = source;
    }
    let bytes = mapped().replace("#13=IFCMAPPEDITEM(#81,#82)", &format!("#13=IFCMAPPEDITEM(#{previous_source},#82)"))
        .replace("ENDSEC;END-ISO", &(declarations + "ENDSEC;END-ISO"));
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    let Control::Product(control) = &program.inner.control else { panic!("product") };
    control.retained_selection().unwrap().set_work_limit(400);
    let first = stop(&mut program, &router, &mut decoder);
    assert!(matches!(first, RetainedProgramError::Stopped(crate::resource::ProgramStop::ResourceRefused(f))
        if f.dimension == crate::resource::Dimension::Work));
    assert_eq!(program.request().err(), Some(first));
}

#[test]
fn h2a2_styled_source_and_occurrence_bindings_survive_cache_reuse_with_real_frames() {
    let bytes = mapped().replace("'SweptSolid',(#13)", "'SweptSolid',(#13,#13)");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_submeshes(&entity, false, None, contract());
    assert_eq!(drive(&mut program, &router, &mut decoder).len(), 1);
    let plan = program.finish().unwrap();
    assert_eq!(plan.values.len(), 2);
    for value in plan.values {
        let bindings = value.presentation();
        assert_eq!(bindings.len(), 2);
        assert_eq!((bindings[0].geometry_id, bindings[0].style_source_id), (113,113));
        assert_eq!((bindings[1].style_source_id, bindings[1].representation_map), (13,Some(81)));
        assert!(bindings.iter().all(|b| b.template && !b.placeholder));
        let frame = value.world_from_source().unwrap();
        assert_eq!([frame[12],frame[13],frame[14]], [12.,24.,36.]);
    }
    assert!(plan.remaining.contains(&RetainedRequirement::IfcAppearance));
    assert!(plan.remaining.contains(&RetainedRequirement::PersistentFaces));
}
#[test]
fn h2a2_styled_direct_items_keep_geometry_identity_without_mapped_wrappers() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_submeshes(&entity, true, None, contract());
    assert_eq!(drive(&mut program, &router, &mut decoder).len(), 1);
    let plan = program.finish().unwrap();
    let binding = &plan.values[0].presentation()[0];
    assert_eq!((binding.geometry_id,binding.style_source_id,binding.representation_map), (13,13,None));
    assert!(binding.template && !binding.placeholder && binding.texture_pending.is_none());
}
#[test]
fn h2a2_logical_template_reuse_does_not_consume_the_exact_template_claim() {
    let bytes = mapped().replace("'SweptSolid',(#13)", "'SweptSolid',(#13,#93)")
        .replace("ENDSEC;END-ISO", "#93=IFCMAPPEDITEM(#81,#82);ENDSEC;END-ISO");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let mut router = GeometryRouter::with_units(&bytes, &mut decoder);
    router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
    router.enable_output_instancing(std::sync::Arc::new(rustc_hash::FxHashMap::from_iter([(81,(2,13))])));
    router.set_instancing_batch_local(true);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_submeshes(&entity, true, None, contract());
    assert_eq!(drive(&mut program, &router, &mut decoder).len(), 1);
    let plan = program.finish().unwrap();
    let first = plan.values[0].presentation().last().unwrap();
    let second = plan.values[1].presentation().last().unwrap();
    assert!(first.template && !first.placeholder);
    assert!(!second.template && second.placeholder);
    assert_eq!(first.geometry_id,113);
    assert_eq!(second.style_source_id,93);
    // Drive the real exact styled output afterwards. Its first occurrence
    // still materializes the template, and only its second is a placeholder.
    let exact = router.process_element_with_submeshes_textured(&entity, &mut decoder,
        &rustc_hash::FxHashMap::default()).unwrap();
    assert_eq!(exact.sub_meshes.len(),2);
    assert!(!exact.sub_meshes[0].mesh.is_empty());
    assert!(exact.sub_meshes[1].mesh.is_empty());
}
