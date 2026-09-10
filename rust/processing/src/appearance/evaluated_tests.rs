// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
use crate::appearance::tests::apply;
fn request() -> AppearanceRequest {
    AppearanceRequest { representation_policy:RepresentationPolicy::EvaluatedOccurrence,
        schema:"IFC4".into(),source_revision:"real-AC20".into(),next_express_id:100_000,product_ids:vec![35169],
        image_uri:"textures/evaluated.png".into(),repeat_s:true,repeat_t:true,
        mapping:Mapping::Box {frame:MappingFrame::World,origin:[0.;3],metres_per_tile:[1.;3]} }
}
fn real_source()->Option<String> {
    let path=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/models/ara3d/AC20-FZK-Haus.ifc");
    match std::fs::read_to_string(path) {
        Ok(source)=>Some(source),
        Err(error) if error.kind()==std::io::ErrorKind::NotFound=>{eprintln!("skip real AC20 fixture; run pnpm fixtures");None},
        Err(error)=>panic!("read fixture: {error}"),
    }
}
fn corners(mesh:&crate::types::mesh::MeshData)->Vec<[f64;3]> {
    mesh.indices.iter().map(|&i|std::array::from_fn(|axis|f64::from(mesh.positions[i as usize*3+axis])+mesh.origin[axis])).collect()
}
#[test]
fn issue_4404_real_mapped_member_is_opt_in_and_preserves_every_sibling_and_world_corner() {
    let Some(source)=real_source() else{return};
    let mut request=request();request.representation_policy=RepresentationPolicy::Preserve;
    let refused=plan_appearance(source.as_bytes(),&request).unwrap();
    assert!(refused.items.is_empty());assert!(refused.conversions.is_empty());
    request.representation_policy=RepresentationPolicy::EvaluatedOccurrence;
    let plan=plan_appearance(source.as_bytes(),&request).unwrap();
    assert!(plan.exclusions.is_empty(),"{:?}",plan.exclusions);
    assert!(plan.conversions.iter().all(|conversion|conversion.source_removed_meshes.is_empty()));
    assert!(!serde_json::to_value(&plan).unwrap()["conversions"][0].as_object().unwrap().contains_key("sourceRemovedMeshes"));
    assert_eq!(plan.created.iter().map(|row|row.express_id).collect::<Vec<_>>(),(plan.next_express_id..plan.next_available_express_id).collect::<Vec<_>>());
    assert_eq!(plan.conversions.len(),1);assert_eq!(plan.items.len(),1);
    assert_eq!(plan.conversions[0].representation_id,35155);
    assert_eq!(plan.conversions[0].source_geometry_item_id,35135);
    assert!(plan.edits.iter().all(|edit|edit.express_id==35155));
    assert!(plan.removed.is_empty());
    let output=apply(&source,&plan);
    let before=crate::process_geometry(source.as_bytes());let after=crate::process_geometry(output.as_bytes());
    assert_eq!(before.meshes.len(),after.meshes.len());
    for mesh in &before.meshes {
        let other=after.meshes.iter().find(|m|m.express_id==mesh.express_id && (m.express_id==35169 || m.geometry_item_id==mesh.geometry_item_id)).unwrap();
        if mesh.express_id==35169 {
            assert_eq!(corners(mesh),corners(other));assert!(other.uvs.is_some());assert!(other.texture.is_some());
            let binding=&plan.conversions[0];
            assert_eq!(binding.source_positions,mesh.positions);
            assert_eq!(binding.source_normals,mesh.normals);
            assert_eq!(binding.source_indices,mesh.indices);
            assert_eq!(binding.source_origin,mesh.origin);
            assert_eq!(binding.source_color,mesh.color);
            assert_eq!(binding.rtc_offset,[0.;3]);
            assert_eq!(mesh.global_id,other.global_id);
        } else { assert_eq!(serde_json::to_value(mesh).unwrap(),serde_json::to_value(other).unwrap()); }
    }
    if let Ok(directory)=std::env::var("IFCLITE_EVALUATED_EVIDENCE_DIR") {
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(std::path::Path::new(&directory).join("native-planned.ifc"),output).unwrap();
        std::fs::write(std::path::Path::new(&directory).join("native-plan.json"),serde_json::to_vec_pretty(&plan).unwrap()).unwrap();
    }
}
#[test]
fn issue_4404_unsupported_classes_and_shared_mapped_wrappers_remain_refused() {
    let Some(source)=real_source() else{return};let mut request=request();
    request.product_ids=vec![21966];
    let plan=plan_appearance(source.as_bytes(),&request).unwrap();
    assert_eq!(plan.exclusions.len(),1);assert!(plan.created.is_empty());assert!(plan.edits.is_empty());assert!(plan.conversions.is_empty());
    let shared=source.replace("#35155=", "#99999=IFCREPRESENTATIONMAP(#5,#35155);\n#35155=");
    request.product_ids=vec![35169];
    let plan=plan_appearance(shared.as_bytes(),&request).unwrap();
    assert_eq!(plan.exclusions.len(),1);assert!(plan.created.is_empty());assert!(plan.edits.is_empty());
}
#[test]
fn issue_4404_page_projection_composes_conversion_and_atlas_in_one_plan() {
    let Some(source)=real_source() else{return};let mut appearance=request();
    appearance.repeat_s=false;appearance.repeat_t=false;
    appearance.mapping=Mapping::Planar {frame:MappingFrame::World,origin:[1.,6.,3.],axis_u:[0.,1.,0.],axis_v:[0.,0.,1.],metres_per_tile:[2.,2.]};
    let request=PageAppearanceRequest {appearance,page:AppearanceRaster {width:1,height:1,byte_offset:0,byte_length:4},source_images:vec![],texels_per_metre:32.};
    let result=plan_page_appearance(source.as_bytes(),&request,&[255,0,0,255]).unwrap();
    assert_eq!(result.plan.created.iter().map(|row|row.express_id).collect::<Vec<_>>(),(result.plan.next_express_id..result.plan.next_available_express_id).collect::<Vec<_>>());
    assert_eq!(result.item_images[0].geometry_item_id,result.plan.items[0].geometry_item_id);
    assert_eq!(result.plan.conversions.len(),1);assert_eq!(result.item_images.len(),1);assert!(!result.assets.is_empty());
    assert!(result.plan.edits.iter().all(|edit|edit.express_id==35155));
    let output=apply(&source,&result.plan);
    let reopened=crate::process_geometry(output.as_bytes());
    let target=reopened.meshes.iter().find(|mesh|mesh.express_id==35169).unwrap();
    assert!(target.uvs.is_some());assert!(target.texture.is_some());
    assert_eq!(target.geometry_item_id,Some(result.plan.conversions[0].geometry_item_id));
}
#[test]
fn issue_4404_inherited_aggregate_voids_cannot_be_baked_as_uncut_geometry() {
    let Some(source)=real_source() else{return};
    let inherited=source.replace("#35155=", "#99996=IFCRELVOIDSELEMENT('x',$,$,$,#99998,#59365);\n#99997=IFCRELAGGREGATES('y',$,$,$,#99998,(#35169));\n#99998=IFCELEMENTASSEMBLY('z',$,$,$,$,$,$,$,$,$);\n#35155=");
    let plan=plan_appearance(inherited.as_bytes(),&request()).unwrap();
    assert_eq!(plan.exclusions.len(),1);assert!(plan.exclusions[0].reason.contains("opening-bearing"));
    assert!(plan.items.is_empty());assert!(plan.created.is_empty());assert!(plan.edits.is_empty());
}
#[test]
fn issue_4404_failed_image_mapping_never_publishes_its_successful_private_conversion() {
    let Some(source)=real_source() else{return};let mut request=request();
    request.mapping=Mapping::Box {frame:MappingFrame::World,origin:[0.;3],metres_per_tile:[f64::MIN_POSITIVE;3]};
    let plan=plan_appearance(source.as_bytes(),&request).unwrap();
    assert_eq!(plan.exclusions.len(),1);assert!(plan.items.is_empty());assert!(plan.created.is_empty());
    assert!(plan.edits.is_empty());assert!(plan.conversions.is_empty());
}
#[test]
fn issue_4404_same_albedo_different_roughness_on_mapped_chain_is_not_silently_lost() {
    let Some(source)=real_source() else{return};
    // Same Kiefer name, colour, diffuse and specular as the source; only
    // roughness differs. RGB/name comparison alone cannot detect this override.
    let styles="#99990=IFCSURFACESTYLERENDERING(#17389,0.,IFCNORMALISEDRATIOMEASURE(0.74),$,$,$,IFCNORMALISEDRATIOMEASURE(0.1),IFCSPECULARROUGHNESS(0.01),.NOTDEFINED.);\n#99991=IFCSURFACESTYLE('Kiefer',.BOTH.,(#99990));\n";
    for target in [35155,35153,35139] {
        let changed=source.replace("#35155=",&format!("{styles}#99992=IFCSTYLEDITEM(#{target},(#99991),$);\n#35155="));
        let plan=plan_appearance(changed.as_bytes(),&request()).unwrap();
        assert_eq!(plan.exclusions.len(),1);assert!(plan.exclusions[0].reason.contains("style overrides") || plan.exclusions[0].reason.contains("Body is shared"),"target {target}: {:?}",plan.exclusions);
        assert!(plan.created.is_empty());assert!(plan.edits.is_empty());assert!(plan.conversions.is_empty());
    }
    for target in [35153,35135] {
        let changed=source.replace("#35155=",&format!("{styles}#99992=IFCPRESENTATIONLAYERWITHSTYLE('Kiefer',$,(#{target}),$,.T.,.F.,.F.,(#99991));\n#35155="));
        let plan=plan_appearance(changed.as_bytes(),&request()).unwrap();
        assert_eq!(plan.exclusions.len(),1);assert!(plan.exclusions[0].reason.contains("Styled presentation layers"));
        assert!(plan.created.is_empty());assert!(plan.edits.is_empty());
    }
}
#[test]
fn issue_4404_material_layer_slicing_refusal_precedes_mapped_evaluation() {
    let Some(source)=real_source() else{return};
    let layers="#99980=IFCMATERIAL('Finish',$,$);\n#99981=IFCMATERIALLAYER(#99980,0.05,$,$,$,$,$);\n#99982=IFCMATERIALLAYER(#99980,0.2,$,$,$,$,$);\n#99983=IFCMATERIALLAYERSET((#99981,#99982),$,$);\n#99984=IFCMATERIALLAYERSETUSAGE(#99983,.AXIS2.,.POSITIVE.,0.,$);\n#99985=IFCRELASSOCIATESMATERIAL('0Proxy000000000000000a',$,$,$,(#35169),#99984);\n";
    let changed=source.replace("#35155=",&format!("{layers}#35155="));
    let mut decoder=ifc_lite_core::EntityDecoder::new(changed.as_bytes());
    assert!(ifc_lite_geometry::MaterialLayerIndex::from_content(changed.as_bytes(),&mut decoder).is_sliceable(35169));
    let plan=plan_appearance(changed.as_bytes(),&request()).unwrap();
    assert_eq!(plan.exclusions.len(),1);assert!(plan.exclusions[0].reason.contains("Material-layer slicing"));
    assert!(plan.created.is_empty());assert!(plan.edits.is_empty());
}

#[test]
fn issue_4404_filtered_private_conversion_prefix_compacts_to_host_allocation_order() {
    let Some(text)=real_source() else{return};
    let mut request=request(); request.product_ids=vec![35169,35304];
    let mut source=Source::new(text.as_bytes()).unwrap();
    let mut normalized=prepare(text.as_bytes(),&request,&mut source).unwrap();
    assert_eq!(normalized.conversions.len(),2);
    // The final appearance pass can exclude a normalized occurrence. Its unused
    // private IDs must not leave a gap before the accepted occurrence's rows.
    normalized.request.product_ids.retain(|id|*id==35304);
    let mapped=super::super::plan_with_source(text.as_bytes(),&normalized.request,&mut source).unwrap();
    let (plan,ids)=normalized.compose(mapped,&source).unwrap();
    assert_eq!(plan.conversions.len(),1);
    assert_eq!(plan.conversions[0].product_id,35304);
    assert!(ids.iter().any(|(old,new)|old!=new));
    assert_eq!(plan.created.iter().map(|row|row.express_id).collect::<Vec<_>>(),(plan.next_express_id..plan.next_available_express_id).collect::<Vec<_>>());
    let output=apply(&text,&plan);
    let before=crate::process_geometry(text.as_bytes()); let after=crate::process_geometry(output.as_bytes());
    for id in [35169,35304] {
        let original=before.meshes.iter().find(|m|m.express_id==id).unwrap();
        let replacement=after.meshes.iter().find(|m|m.express_id==id).unwrap();
        assert_eq!(corners(original),corners(replacement));
        if id==35169 {assert_eq!(serde_json::to_value(original).unwrap(),serde_json::to_value(replacement).unwrap());}
        else {assert_eq!(replacement.geometry_item_id,Some(plan.conversions[0].geometry_item_id));assert!(replacement.texture.is_some());}
    }
}

#[test]
fn issue_4404_real_page_material_name_that_looks_like_generated_reference_is_literal() {
    let Some(source)=real_source() else{return};
    let mut appearance=request(); appearance.repeat_s=false;appearance.repeat_t=false;
    appearance.mapping=Mapping::Planar {frame:MappingFrame::World,origin:[1.,6.,3.],axis_u:[0.,1.,0.],axis_v:[0.,0.,1.],metres_per_tile:[2.,2.]};
    let request=PageAppearanceRequest {appearance,page:AppearanceRaster {width:1,height:1,byte_offset:0,byte_length:4},source_images:vec![],texels_per_metre:32.};
    for name in ["#100001",".FOO.","*","$"," .T. "," #100001 "] {
        let ambiguous_source=source.replace("'Kiefer'",&format!("'{name}'"));
        let error=plan_page_appearance(ambiguous_source.as_bytes(),&request,&[255,0,0,255]).unwrap_err();
        assert!(error.contains("reserved appearance wire token"),"{name}: {error}");
    }
    for name in ["#material",".surface","*label","$label","ordinary'quoted"] {
        let named_source=source.replace("'Kiefer'",&format!("'{}'",name.replace('\'',"''")));
        let result=plan_page_appearance(named_source.as_bytes(),&request,&[255,0,0,255]).unwrap();
        let output=apply(&named_source,&result.plan);
        let reopened=crate::process_geometry(output.as_bytes());
        let target=reopened.meshes.iter().find(|mesh|mesh.express_id==35169).unwrap();
        assert_eq!(target.material_name.as_deref(),Some(name));
    }
    // The public path refuses the ambiguous Name instead of emitting invalid
    // STEP. Also protect the finalizer itself against treating literal slots as
    // references, independently of the page writer's current restriction.
    let mut result=plan_page_appearance(source.as_bytes(),&request,&[255,0,0,255]).unwrap();
    for row in &mut result.plan.created {
        if row.r#type=="IfcSurfaceStyle" {row.attributes[0]=json!("#100001");}
    }
    let names=|plan:&AppearancePlan|plan.created.iter().filter(|row|row.r#type=="IfcSurfaceStyle")
        .map(|row|row.attributes[0].clone()).collect::<Vec<_>>();
    let original_names=names(&result.plan);assert!(original_names.contains(&json!("#100001")));
    // Force the same remapping that an omitted private prefix requires, using
    // the actual native page plan with its preserved exporter material label.
    result.plan.next_express_id-=1;
    let ids=super::super::evaluated_allocation::compact(&mut result.plan,&Source::new(source.as_bytes()).unwrap().types).unwrap();
    assert_ne!(ids[&100001],100001);
    assert_eq!(names(&result.plan),original_names);
    assert_eq!(result.plan.created[0].express_id,result.plan.next_express_id);
}

#[test]
fn issue_4404_materialization_payload_restores_georeferenced_native_frame_once() {
    let Some(source)=real_source() else{return};
    let source=source.replace("#112= IFCCARTESIANPOINT((0.,0.,0.));", "#112= IFCCARTESIANPOINT((1000000.,2000000.,0.));");
    let plan=plan_appearance(source.as_bytes(),&request()).unwrap();
    assert!(plan.exclusions.is_empty(),"{:?}",plan.exclusions);
    let binding=&plan.conversions[0];
    assert!(binding.rtc_offset.iter().any(|v|v.abs()>10_000.));
    let mut effective=source::Source::new(source.as_bytes()).unwrap();
    let context=context::Context::new(source.as_bytes(),&mut effective.decoder);
    effective.context=Some(context);
    let styles=page_source::appearance(source.as_bytes(),&mut effective);
    let textures=ifc_lite_geometry::build_texture_index(source.as_bytes(),&mut effective.decoder);
    let meshes=canonical::produce(&mut effective,35169,&textures,Some(&styles)).unwrap();
    let mesh=&meshes[0];
    assert_eq!(binding.source_positions,mesh.positions);
    assert_eq!(binding.source_normals,mesh.normals);
    assert_eq!(binding.source_origin,mesh.origin);
    let output=apply(&source,&plan);
    let reopened=crate::process_geometry(output.as_bytes());
    let target=reopened.meshes.iter().find(|m|m.express_id==35169).unwrap();
    // Full native loads choose a site-local frame; the planner uses detected RTC.
    // Restore both in f64 before comparing their independently rounded f32 vertices.
    let mut max_error=0.0_f64;
    for (before,after) in corners(mesh).iter().zip(corners(target)) {
        for axis in 0..3 {
            max_error=max_error.max((before[axis]+binding.rtc_offset[axis]
                -after[axis]-reopened.metadata.coordinate_info.origin_shift[axis]).abs());
        }
    }
    assert!(max_error<1e-6,"restored native world error: {max_error}");
    let json=serde_json::to_value(&plan).unwrap();
    assert_eq!(json["conversions"][0]["rtcOffset"],serde_json::json!(binding.rtc_offset));
    for key in ["sourcePositions","sourceNormals","sourceOrigin","sourceColor","rtcOffset"] {
        assert!(json["conversions"][0][key].as_array().unwrap().iter().all(|v|v.as_f64().is_some_and(f64::is_finite)), "{key}");
    }
}

#[test]
fn issue_4404_post_opening_source_matches_canonical_load() {
    let Some(bytes)=real_source() else{return};
    let mut source=super::super::source::Source::new(bytes.as_bytes()).unwrap();
    assert!(!source.context.as_ref().unwrap().layers.is_sliceable(59290), "real slab requires unsupported material slicing");
    let appearance=super::super::page_source::appearance(bytes.as_bytes(), &mut source);
    assert_eq!(appearance.void_index.get(&59290),Some(&vec![59365]));
    let produced=super::super::canonical::produce(&mut source,59290,&rustc_hash::FxHashMap::default(),Some(&appearance)).unwrap();
    let loaded=crate::process_geometry(bytes.as_bytes());
    let expected=loaded.meshes.iter().find(|m|m.express_id==59290).unwrap();
    assert_eq!(produced.len(),1);
    assert_eq!(expected.indices.len()/3,32);
    assert_eq!(corners(&produced[0]),corners(expected));
}

#[test]
fn issue_4404_reference_only_openings_allow_later_direct_appearance_but_mixed_body_does_not() {
    let source=crate::appearance::tests::CONTROLLED_IFC.replace("ENDSEC;\nEND-ISO-10303-21;", "#80=IFCOPENINGELEMENT('0000000000000000000001',$,$,$,$,#11,#81,$,.OPENING.);\n#81=IFCPRODUCTDEFINITIONSHAPE($,$,(#82));\n#82=IFCSHAPEREPRESENTATION(#2,'Reference','SweptSolid',(#84));\n#83=IFCRELVOIDSELEMENT('0000000000000000000002',$,$,$,#10,#80);\n#84=IFCBLOCK(#5,0.2,0.2,0.2);\nENDSEC;\nEND-ISO-10303-21;");
    let mut request=request();request.product_ids=vec![10];request.next_express_id=100;
    request.representation_policy=RepresentationPolicy::Preserve;
    let plan=plan_appearance(source.as_bytes(),&request).unwrap();
    assert!(plan.exclusions.is_empty(),"{:?}",plan.exclusions);
    assert_eq!(plan.items.len(),1);assert!(plan.conversions.is_empty());
    let output=apply(&source,&plan);
    let before=crate::process_geometry(source.as_bytes());
    let after=crate::process_geometry(output.as_bytes());
    let host=|meshes:Vec<crate::types::mesh::MeshData>|meshes.into_iter().find(|m|m.express_id==10).unwrap();
    assert_eq!(corners(&host(before.meshes)),corners(&host(after.meshes)));
    for changed in [source.replace("'Reference'","'Body'"),source.replace("(#82));","(#82,#85));").replace("#83=", "#85=IFCSHAPEREPRESENTATION(#2,'Body','CSG',(#84));\n#83=")] {
        let refused=plan_appearance(changed.as_bytes(),&request).unwrap();
        assert!(refused.items.is_empty());assert!(refused.created.is_empty());assert!(refused.edits.is_empty());
    }
}

#[test]
fn issue_4404_opening_policy_freezes_only_exclusively_owned_body_identifiers() {
    let Some(bytes)=real_source() else{return};
    let inspect=|bytes:&str,exclusive:BTreeSet<u32>| {
        let mut source=source::Source::new(bytes.as_bytes()).unwrap();
        super::super::evaluated_openings::prepare(&mut source,59290,&[59365],&exclusive)
    };
    let edits=inspect(&bytes,BTreeSet::from([59365])).unwrap();
    assert_eq!(edits.iter().map(|entity|entity.id).collect::<Vec<_>>(),vec![59354]);
    assert_eq!(edits[0].get_string(1),Some("Body"));
    assert!(inspect(&bytes,BTreeSet::new()).unwrap_err().contains("another canonical host"));
    let shared=bytes.replace("#59354=", "#99999=IFCREPRESENTATIONMAP(#5,#59354);\n#59354=");
    assert!(inspect(&shared,BTreeSet::from([59365])).unwrap_err().contains("shared"));
    let shared_pds=bytes.replace("#59361=", "#99999=IFCOPENINGELEMENT('0000000000000000000001',$,$,$,$,$,#59361,$,.OPENING.);\n#59361=");
    assert!(inspect(&shared_pds,BTreeSet::from([59365])).unwrap_err().contains("ProductDefinitionShape is shared"));
}

#[test]
fn issue_4404_real_cut_slab_preserves_type_semantics_and_accepts_second_appearance() {
    let Some(bytes)=real_source() else{return};
    let mut request=request();request.product_ids=vec![59290];
    let plan=plan_appearance(bytes.as_bytes(),&request).unwrap();
    assert!(plan.exclusions.is_empty(),"{:?}",plan.exclusions);
    assert_eq!(plan.items.len(),1);assert_eq!(plan.conversions.len(),1);
    assert_eq!(plan.created.iter().map(|row|row.express_id).collect::<Vec<_>>(),(plan.next_express_id..plan.next_available_express_id).collect::<Vec<_>>());
    assert_eq!(plan.edits.iter().map(|edit|edit.express_id).collect::<BTreeSet<_>>(),BTreeSet::from([59286,59354]));
    assert_ne!(plan.conversions[0].representation_id,59278);
    let output=apply(&bytes,&plan);
    let mut reopened=Source::new(output.as_bytes()).unwrap();
    assert_eq!(reopened.entity(59354).unwrap().get_string(1),Some("Reference"));
    assert_eq!(reopened.entity(59290).unwrap().get_ref(6),Some(59286));
    assert_eq!(reopened.entity(59492).unwrap().get_ref(1),Some(59278));
    assert_eq!(reopened.entity(59278).unwrap().get_string(2),Some("SweptSolid"));
    assert_eq!(reopened.entity(59368).unwrap().get_ref(4),Some(59290));
    assert_eq!(reopened.entity(59368).unwrap().get_ref(5),Some(59365));
    let before=crate::process_geometry(bytes.as_bytes());let after=crate::process_geometry(output.as_bytes());
    assert_eq!(plan.conversions[0].source_removed_meshes.len(),1);
    let companion=&plan.conversions[0].source_removed_meshes[0];
    assert_eq!(companion.express_id,59365);
    let original_opening=before.meshes.iter().find(|mesh|mesh.express_id==59365).unwrap();
    // The orchestrator additionally attaches entity labels; geometry/style and
    // provenance come from the shared per-element evaluator without that pass.
    assert_eq!(companion.geometry_item_id,original_opening.geometry_item_id);
    assert_eq!(companion.positions,original_opening.positions);
    assert_eq!(companion.normals,original_opening.normals);
    assert_eq!(companion.indices,original_opening.indices);
    assert_eq!(companion.origin,original_opening.origin);
    assert_eq!(companion.color,original_opening.color);
    assert_eq!(before.meshes.len(),after.meshes.len()+1);
    assert!(!after.meshes.iter().any(|mesh|mesh.express_id==59365),"Reference opening must no longer produce subtractive render geometry");
    let mut max_world_error=0f64;
    for mesh in before.meshes.iter().filter(|mesh|mesh.express_id!=59365) {
        let other=after.meshes.iter().find(|m|m.express_id==mesh.express_id && (m.express_id==59290 || m.geometry_item_id==mesh.geometry_item_id)).unwrap();
        if mesh.express_id==59290 {
            assert_eq!(plan.conversions[0].source_positions,mesh.positions);
            assert_eq!(plan.conversions[0].source_indices,mesh.indices);
            assert_eq!(plan.conversions[0].source_origin,mesh.origin);
            assert_eq!(mesh.indices.len()/3,32);assert_eq!(other.indices.len()/3,32);
            assert!(other.uvs.is_some());assert!(other.texture.is_some());
            assert_eq!(mesh.global_id,other.global_id);
            for (a,b) in corners(mesh).iter().zip(corners(other)) {
                for axis in 0..3 {max_world_error=max_world_error.max((a[axis]-b[axis]).abs());}
            }
        } else {assert_eq!(serde_json::to_value(mesh).unwrap(),serde_json::to_value(other).unwrap());}
    }
    request.next_express_id=plan.next_available_express_id;
    request.image_uri="textures/second.png".into();
    let second=plan_appearance(output.as_bytes(),&request).unwrap();
    assert!(second.exclusions.is_empty(),"{:?}",second.exclusions);
    assert!(second.conversions.is_empty());assert_eq!(second.items.len(),1);
    if let Ok(directory)=std::env::var("IFCLITE_EVALUATED_EVIDENCE_DIR") {
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(std::path::Path::new(&directory).join("native-opening-planned.ifc"),output).unwrap();
        std::fs::write(std::path::Path::new(&directory).join("native-opening-plan.json"),serde_json::to_vec_pretty(&plan).unwrap()).unwrap();
        std::fs::write(std::path::Path::new(&directory).join("native-opening-metrics.json"),serde_json::to_vec_pretty(&json!({"maxWorldCoordinateErrorMetres":max_world_error,"triangles":32,"secondAppearance":true})).unwrap()).unwrap();
    }
}

#[test]
fn issue_4404_opening_companions_share_the_aggregate_geometry_budget() {
    let Some(bytes)=real_source() else{return};
    let mut source=Source::new(bytes.as_bytes()).unwrap();
    let styles=page_source::appearance(bytes.as_bytes(),&mut source);
    let textures=ifc_lite_geometry::build_texture_index(bytes.as_bytes(),&mut source.decoder);
    let edits=super::super::evaluated_openings::prepare(&mut source,59290,&[59365],&BTreeSet::from([59365])).unwrap();
    let mut budget=budget::PlanBudget::default();
    budget.reserve(1_000_000,0,0).unwrap();
    budget.reserve(1_000_000,0,0).unwrap();
    let error=super::super::evaluated_openings::removed_meshes(&mut source,&[59365],&edits,&textures,&styles,&mut budget).unwrap_err();
    assert_eq!(error,budget::BUDGET_ERROR);
    assert!(budget.exhausted);
}
