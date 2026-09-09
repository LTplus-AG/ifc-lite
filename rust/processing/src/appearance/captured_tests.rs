// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
use crate::appearance::tests::{apply,CONTROLLED_IFC};
fn fixture()->(String,CapturedMeshRequest) {
    let source=CONTROLLED_IFC.replace("#37=IFCINDEXEDTRIANGLETEXTUREMAP", "#40=IFCBUILDINGSTOREY('0Storey0000000000000000',$,'Level',$,$,#11,$,$,.ELEMENT.,0.);\n#37=IFCINDEXEDTRIANGLETEXTUREMAP");
    (source,CapturedMeshRequest {schema:"IFC4".into(),source_revision:"capture-test".into(),next_express_id:100,
        container_id:40,global_id:"0aaaaaaaaaaaaaaaaaaaaa".into(),containment_global_id:"0bbbbbbbbbbbbbbbbbbbbb".into(),
        name:"Captured surface".into(),image_uri:"textures/captured.png".into(),mesh:CapturedMesh {
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
