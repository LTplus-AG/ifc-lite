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
fn issue_4404_opening_hosts_and_shared_body_wrappers_never_receive_conversion_mutations() {
    let Some(source)=real_source() else{return};let mut request=request();
    request.product_ids=vec![59290,21966];
    let plan=plan_appearance(source.as_bytes(),&request).unwrap();
    assert_eq!(plan.exclusions.len(),2);assert!(plan.created.is_empty());assert!(plan.edits.is_empty());assert!(plan.conversions.is_empty());
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
