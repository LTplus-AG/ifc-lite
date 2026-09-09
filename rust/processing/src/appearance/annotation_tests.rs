// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
use crate::appearance::tests::{apply, CONTROLLED_IFC};
fn fixture() -> (String, AnnotationPlaneRequest) {
    let source=CONTROLLED_IFC.replace("#37=IFCINDEXEDTRIANGLETEXTUREMAP", "#40=IFCBUILDINGSTOREY('0Storey0000000000000000',$,'Level',$,$,#11,$,$,.ELEMENT.,0.);\n#37=IFCINDEXEDTRIANGLETEXTUREMAP");
    (source, AnnotationPlaneRequest { schema:"IFC4".into(),source_revision:"annotation-test".into(),next_express_id:100,
        container_id:40,global_id:"0aaaaaaaaaaaaaaaaaaaaa".into(),containment_global_id:"0bbbbbbbbbbbbbbbbbbbbb".into(),
        name:"Calibrated source".into(),image_uri:"textures/image.png".into(),frame:AnnotationPlaneFrame {
            origin:[2.,3.,4.],axis_u:[1.,0.,0.],axis_v:[0.,0.,1.],size_metres:[2.,1.] } })
}
#[test]
fn issue_4308_native_annotation_uses_canonical_geometry_and_roundtrips_identity_texture_containment() {
    let (source,request)=fixture();
    let result=plan_annotation_plane(source.as_bytes(),&request).unwrap();
    let exported=apply(&source,&result.plan);
    let restored=crate::process_geometry(exported.as_bytes());
    let mesh=restored.meshes.iter().find(|m|m.express_id==result.annotation_id).unwrap();
    assert_eq!(mesh.geometry_item_id,Some(result.geometry_item_id));
    assert_eq!(mesh.positions,result.mesh.positions);
    assert_eq!(mesh.normals,result.mesh.normals);
    assert_eq!(mesh.indices,result.mesh.indices);
    assert_eq!(mesh.uvs,result.mesh.uvs);
    assert_eq!(mesh.color,[1.;4]);
    assert_eq!(mesh.texture.as_ref().unwrap().url.as_deref(),Some(request.image_uri.as_str()));
    let mut decoder=Source::new(exported.as_bytes()).unwrap();
    assert_eq!(decoder.entity(result.annotation_id).unwrap().get_string(0),Some(request.global_id.as_str()));
    let relation=result.plan.created.iter().find(|e|e.r#type=="IfcRelContainedInSpatialStructure").unwrap();
    assert_eq!(decoder.entity(relation.express_id).unwrap().get_ref(5),Some(40));
}

fn assert_footprint(result: &AnnotationPlanePlan) {
    let uv=result.mesh.uvs.as_ref().unwrap();
    for (i,p) in result.mesh.positions.chunks_exact(3).enumerate() {
        let actual:[f64;3]=std::array::from_fn(|axis|f64::from(p[axis])+result.mesh.origin[axis]+result.rtc_offset[axis]);
        let expected:[f64;3]=std::array::from_fn(|axis|result.frame.origin[axis]
            +result.frame.axis_u[axis]*f64::from(uv[i*2])*result.frame.size_metres[0]
            +result.frame.axis_v[axis]*(1.-f64::from(uv[i*2+1]))*result.frame.size_metres[1]);
        for axis in 0..3 { assert!((actual[axis]-expected[axis]).abs()<1e-6,"{actual:?} != {expected:?}"); }
    }
}
#[test]
fn issue_4308_rotated_millimetre_container_preserves_world_frame_and_asymmetric_image_corners() {
    let (source,mut request)=fixture();
    let source=source.replace(".LENGTHUNIT.,$,.METRE.",".LENGTHUNIT.,.MILLI.,.METRE.")
        .replace("'Level',$,$,#11", "'Level',$,$,#41")
        .replace("#37=IFCINDEXEDTRIANGLETEXTUREMAP", "#41=IFCLOCALPLACEMENT($,#42);\n#42=IFCAXIS2PLACEMENT3D(#43,#44,#45);\n#43=IFCCARTESIANPOINT((10000.,20000.,3000.));\n#44=IFCDIRECTION((0.,0.,1.));\n#45=IFCDIRECTION((0.,1.,0.));\n#37=IFCINDEXEDTRIANGLETEXTUREMAP");
    request.frame.origin=[15.,25.,6.];
    let result=plan_annotation_plane(source.as_bytes(),&request).unwrap();
    assert_footprint(&result);
    let exported=apply(&source,&result.plan);
    let restored=crate::process_geometry(exported.as_bytes());
    let mesh=restored.meshes.iter().find(|m|m.express_id==result.annotation_id).unwrap();
    assert_eq!(mesh.positions,result.mesh.positions); assert_eq!(mesh.uvs,result.mesh.uvs);
    // IFC UV's upward V samples an asymmetric top-down raster. This oracle is
    // also exercised against the actual bitmap upload in the downstream UI.
    let rgba=[255,0,0,255, 0,255,0,255, 255,255,0,255, 0,0,255,255];
    let raster=super::super::page_raster::Raster::new(2,2,&rgba).unwrap();
    let uv=mesh.uvs.as_ref().unwrap();
    for (i,p) in mesh.positions.chunks_exact(3).enumerate() {
        let world_z=f64::from(p[2])+mesh.origin[2];
        let sample=raster.sample([f64::from(uv[2*i]),(1.-f64::from(uv[2*i+1]))],[false,false]);
        assert_eq!(sample[3],1.);
        if (world_z-7.).abs()<1e-6 { assert_eq!(sample[2],0.,"top row must contain red/green, never blue"); }
        else { assert!(sample[0]==1. || sample[2]==1.,"bottom row is yellow/blue"); }
    }
}
#[test]
fn issue_4308_rejects_wrong_container_stale_allocator_duplicate_identity_and_invalid_pose() {
    let (source,request)=fixture();
    for changed in [AnnotationPlaneRequest {container_id:10,..request.clone()},
        AnnotationPlaneRequest {next_express_id:40,..request.clone()},
        AnnotationPlaneRequest {global_id:request.containment_global_id.clone(),..request.clone()},
        AnnotationPlaneRequest {frame:AnnotationPlaneFrame {axis_v:[1.,0.,0.],..request.frame.clone()},..request.clone()}] {
        assert!(plan_annotation_plane(source.as_bytes(),&changed).is_err());
    }
    let result=plan_annotation_plane(source.as_bytes(),&request).unwrap();
    let exported=apply(&source,&result.plan);
    let retry=AnnotationPlaneRequest {next_express_id:result.plan.next_available_express_id,..request};
    assert!(plan_annotation_plane(exported.as_bytes(),&retry).unwrap_err().contains("GlobalId already exists"));
    let relation_collision=AnnotationPlaneRequest { global_id:"0ccccccccccccccccccccc".into(),
        containment_global_id:retry.global_id.clone(),..retry.clone() };
    assert!(plan_annotation_plane(exported.as_bytes(),&relation_collision).unwrap_err().contains("GlobalId already exists"));
    let owner_collision=AnnotationPlaneRequest { global_id:retry.containment_global_id.clone(),
        containment_global_id:"0ddddddddddddddddddddd".into(),..retry };
    assert!(plan_annotation_plane(exported.as_bytes(),&owner_collision).unwrap_err().contains("GlobalId already exists"));
}

#[test]
fn issue_4308_georeferenced_creation_keeps_world_footprint_after_normal_reparse() {
    let (source,mut request)=fixture();
    let source=source.replace("#4=IFCCARTESIANPOINT((0.,0.,0.));", "#4=IFCCARTESIANPOINT((5000000.,6000000.,100.));");
    request.frame.origin=[5000002.,6000003.,104.];
    let result=plan_annotation_plane(source.as_bytes(),&request).unwrap();
    assert_footprint(&result);
    let exported=apply(&source,&result.plan);
    let restored=crate::process_geometry(exported.as_bytes());
    let mesh=restored.meshes.iter().find(|m|m.express_id==result.annotation_id).unwrap().clone();
    let reopened=AnnotationPlanePlan { mesh,rtc_offset:restored.metadata.coordinate_info.origin_shift,..result };
    assert_footprint(&reopened);
}
#[test]
fn issue_4308_containment_accepts_spatial_elements_beyond_spatial_structure_elements() {
    let (source,request)=fixture();
    let source=source.replace("IFCBUILDINGSTOREY('0Storey0000000000000000',$,'Level',$,$,#11,$,$,.ELEMENT.,0.)",
        "IFCEXTERNALSPATIALELEMENT('0Storey0000000000000000',$,'Outside',$,$,#11,$,$,.NOTDEFINED.)");
    assert!(plan_annotation_plane(source.as_bytes(),&request).is_ok());
}
