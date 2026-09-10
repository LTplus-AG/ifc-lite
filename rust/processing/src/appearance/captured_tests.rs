// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
use crate::appearance::tests::{apply,CONTROLLED_IFC};
fn fixture()->(String,CapturedMeshRequest) {
    let source=CONTROLLED_IFC.replace("#37=IFCINDEXEDTRIANGLETEXTUREMAP", "#40=IFCBUILDINGSTOREY('0Storey0000000000000000',$,'Level',$,$,#11,$,$,.ELEMENT.,0.);\n#37=IFCINDEXEDTRIANGLETEXTUREMAP");
    (source,CapturedMeshRequest {schema:"IFC4".into(),source_revision:"capture-test".into(),next_express_id:100,
        container_id:40,global_id:"0aaaaaaaaaaaaaaaaaaaaa".into(),containment_global_id:"0bbbbbbbbbbbbbbbbbbbbb".into(),
        name:"Captured surface".into(),repeat_s:false,repeat_t:false,image_uri:"textures/captured.png".into(),mesh:CapturedMesh {
            positions:vec![[2.,3.,4.],[3.,3.,4.],[3.,4.,4.],[2.,4.,5.]],triangles:vec![[0,1,2],[0,2,3]],
            uvs:vec![[0.,0.],[1.,0.],[1.,1.],[0.,1.],[0.2,0.2]],uv_triangles:vec![[0,1,2],[4,2,3]] }})
}
#[test]
fn issue_4380_captured_nonplanar_surface_seam_roundtrips_through_normal_import() {
    let (source,r)=fixture();
    let plan=plan_captured_mesh(source.as_bytes(),&r).unwrap();
    let restored=crate::process_geometry(apply(&source,&plan.plan).as_bytes());
    let mesh=restored.meshes.iter().find(|m|m.express_id==plan.object_id).unwrap();
    assert_eq!(mesh.positions,plan.mesh.positions);
    assert_eq!(mesh.indices,plan.mesh.indices);
    assert_eq!(mesh.uvs,plan.mesh.uvs);
    assert_eq!(mesh.texture.as_ref().unwrap().url.as_deref(),Some(r.image_uri.as_str()));
    assert!(plan.plan.created.iter().any(|e|e.r#type=="IfcBuildingElementProxy"));
}
#[test]
fn issue_4380_capture_rejects_invalid_triangle_uv_and_degenerate_inputs() {
    let (source,r)=fixture();
    let mut invalid=r.clone();invalid.mesh.triangles[0][0]=999;
    assert!(plan_captured_mesh(source.as_bytes(),&invalid).is_err());
    invalid=r.clone();invalid.mesh.uv_triangles.pop();
    assert!(plan_captured_mesh(source.as_bytes(),&invalid).is_err());
    invalid=r.clone();invalid.mesh.positions[0]=invalid.mesh.positions[1];
    assert!(plan_captured_mesh(source.as_bytes(),&invalid).is_err());
    invalid=r.clone();invalid.mesh.uvs[0][0]=f64::NAN;
    assert!(plan_captured_mesh(source.as_bytes(),&invalid).is_err());
}
#[test]
fn issue_4380_captured_surface_rotated_millimetre_container_retains_world_vertices() {
    let (source,request)=fixture();
    let source=source.replace(".LENGTHUNIT.,$,.METRE.",".LENGTHUNIT.,.MILLI.,.METRE.")
        .replace("'Level',$,$,#11", "'Level',$,$,#41")
        .replace("#37=IFCINDEXEDTRIANGLETEXTUREMAP", "#41=IFCLOCALPLACEMENT($,#42);\n#42=IFCAXIS2PLACEMENT3D(#43,#44,#45);\n#43=IFCCARTESIANPOINT((10000.,20000.,3000.));\n#44=IFCDIRECTION((0.,0.,1.));\n#45=IFCDIRECTION((0.,1.,0.));\n#37=IFCINDEXEDTRIANGLETEXTUREMAP");
    let result=plan_captured_mesh(source.as_bytes(),&request).unwrap();
    let restored=crate::process_geometry(apply(&source,&result.plan).as_bytes());
    let mesh=restored.meshes.iter().find(|m|m.express_id==result.object_id).unwrap();
    assert_eq!(mesh.positions,result.mesh.positions);
    assert_eq!(mesh.uvs,result.mesh.uvs);
}
#[test]
fn issue_4380_public_boulder_exact_triangle_image_correspondence() {
    let Ok(path)=std::env::var("IFCLITE_CAPTURED_MESH_FIXTURE") else {
        eprintln!("Skipping external captured surface: fetch the public Poly Haven boulder fixture and set IFCLITE_CAPTURED_MESH_FIXTURE");return;
    };
    let bytes=match std::fs::read(path) {
        Ok(bytes)=>bytes,
        Err(error) if error.kind()==std::io::ErrorKind::NotFound=>{
            eprintln!("Skipping missing captured fixture; run pnpm fixtures and fetch the public capture described in the authoring evidence");return;
        },
        Err(error)=>panic!("Cannot read captured fixture: {error}"),
    };
    let input:serde_json::Value=serde_json::from_slice(&bytes).unwrap();
    let (source,mut request)=fixture();
    request.mesh=serde_json::from_value(serde_json::json!({"positions":input["vertices"],"triangles":input["triangles"],"uvs":input["uvs"],"uvTriangles":input["uv_triangles"]})).unwrap();
    let plan=plan_captured_mesh(source.as_bytes(),&request).unwrap();
    assert_eq!(plan.mesh.indices.len(),request.mesh.triangles.len()*3);
    let restored=crate::process_geometry(apply(&source,&plan.plan).as_bytes());
    let mesh=restored.meshes.iter().find(|m|m.express_id==plan.object_id).unwrap();
    assert_eq!(mesh.indices.len(),plan.mesh.indices.len());
    for (left,right) in mesh.indices.iter().zip(&plan.mesh.indices) {
        for axis in 0..3 {
            let a=f64::from(mesh.positions[*left as usize*3+axis])+mesh.origin[axis];
            let b=f64::from(plan.mesh.positions[*right as usize*3+axis])+plan.mesh.origin[axis];
            assert!((a-b).abs()<1e-6,"roundtrip triangle corner difference {}",(a-b).abs());
        }
        for axis in 0..2 {
            let a=mesh.uvs.as_ref().unwrap()[*left as usize*2+axis];
            let b=plan.mesh.uvs.as_ref().unwrap()[*right as usize*2+axis];
            assert!((a-b).abs()<1e-6,"roundtrip triangle UV difference {}",(a-b).abs());
        }
    }
    eprintln!("Public capture verified {} triangles, {} vertices",mesh.indices.len()/3,mesh.positions.len()/3);
}
#[test]
fn issue_4380_ifc4x3_captured_proxy_has_tag_and_predefined_type_slots() {
    let (source,mut request)=fixture();
    request.schema="IFC4X3".into();
    let source=source.replace("FILE_SCHEMA(('IFC4'))","FILE_SCHEMA(('IFC4X3'))");
    let result=plan_captured_mesh(source.as_bytes(),&request).unwrap();
    let proxy=result.plan.created.iter().find(|e|e.r#type=="IfcBuildingElementProxy").unwrap();
    assert_eq!(proxy.attributes.len(),9);
    assert_eq!(proxy.attributes[7],serde_json::Value::Null);
    assert_eq!(proxy.attributes[8],".USERDEFINED.");
    let points=result.plan.created.iter().find(|e|e.r#type=="IfcCartesianPointList3D").unwrap();
    assert_eq!(points.attributes.len(),2);
}
#[test]
fn issue_4380_georeferenced_capture_reopens_at_same_world_triangle_corners() {
    let (source,mut request)=fixture();
    let source=source.replace("#4=IFCCARTESIANPOINT((0.,0.,0.));", "#4=IFCCARTESIANPOINT((5000000.,6000000.,100.));");
    for p in &mut request.mesh.positions { for axis in 0..3 {p[axis]+=[5000000.,6000000.,100.][axis];} }
    let result=plan_captured_mesh(source.as_bytes(),&request).unwrap();
    let restored=crate::process_geometry(apply(&source,&result.plan).as_bytes());
    let mesh=restored.meshes.iter().find(|m|m.express_id==result.object_id).unwrap();
    for (corner,index) in mesh.indices.iter().enumerate() {
        let expected=request.mesh.positions[request.mesh.triangles[corner/3][corner%3] as usize];
        for (axis,value) in expected.iter().enumerate() {
            let world=f64::from(mesh.positions[*index as usize*3+axis])+mesh.origin[axis]+restored.metadata.coordinate_info.origin_shift[axis];
            assert!((world-value).abs()<1e-6);
        }
    }
}

#[test]
fn issue_4380_capture_retains_each_original_sampler_combination_on_reimport() {
    for repeat_s in [false,true] { for repeat_t in [false,true] {
        let (source,mut request)=fixture();
        request.repeat_s=repeat_s;request.repeat_t=repeat_t;
        let plan=plan_captured_mesh(source.as_bytes(),&request).unwrap();
        let texture=plan.mesh.texture.as_ref().unwrap();
        assert_eq!((texture.repeat_s,texture.repeat_t),(repeat_s,repeat_t));
        let restored=crate::process_geometry(apply(&source,&plan.plan).as_bytes());
        let mesh=restored.meshes.iter().find(|mesh|mesh.express_id==plan.object_id).unwrap();
        let texture=mesh.texture.as_ref().unwrap();
        assert_eq!((texture.repeat_s,texture.repeat_t),(repeat_s,repeat_t));
        assert_eq!(mesh.uvs,plan.mesh.uvs);
    } }
}

#[test]
fn issue_4441_authored_metadata_refuses_wire_tokens_and_preserves_ordinary_names() {
    let (source, mut request) = fixture();
    for token in ["*", "$", "#123", ".ENUM.", " .lower_1. ", "\u{feff}#123\u{feff}"] {
        request.name = token.into();
        assert!(plan_captured_mesh(source.as_bytes(), &request).unwrap_err().contains("Authored product Name is a reserved appearance wire token"));
    }
    for name in ["Ordinary name", "O'Brien – 墙", "#not_a_ref", ".not-an-enum.", "* label", "\u{85}#123\u{85}"] {
        request.name = name.into();
        let result = plan_captured_mesh(source.as_bytes(), &request).unwrap();
        assert_eq!(result.plan.created.iter().find(|e| e.express_id == result.object_id).unwrap().attributes[2], serde_json::json!(name));
    }
    for token in ["*", "$", ".ENUM.", " .lower_1. "] {
        request.image_uri = token.into();
        assert!(plan_captured_mesh(source.as_bytes(), &request).unwrap_err().contains("Image URI is a reserved appearance wire token"));
    }
}
