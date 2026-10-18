// SPDX-License-Identifier: MPL-2.0
//! Field-loss invariants over actual production geometry, not generated oracles.
use super::*;
use bits::Exact;
fn actual_mesh()->ifc_lite_processing::MeshData {
    let source=include_bytes!("../../../../rust/geometry/tests/fixtures/bath_csg_solid.ifc");
    let result=ifc_lite_processing::process_geometry(source);
    assert!(!result.meshes.is_empty(),"actual STEP fixture must construct geometry");
    result.meshes.into_iter().next().unwrap()
}
fn encoded(mesh:&ifc_lite_processing::MeshData)->serde_json::Value {
    serde_json::to_value(Exact(&mesh::CompleteMesh::from(mesh))).unwrap()
}
#[test]
fn uv_and_metadata_loss_changes_actual_mesh_receipt() {
    let mut mesh=actual_mesh();
    mesh.uvs=Some(vec![0.;mesh.positions.len()/3*2]);
    mesh.name=Some("authored label".into());
    let expected=encoded(&mesh);
    mesh.uvs=None;
    assert_ne!(expected,encoded(&mesh),"the old geometry-only hash omitted this loss");
    mesh.uvs=Some(vec![0.;mesh.positions.len()/3*2]);
    mesh.name=None;
    assert_ne!(expected,encoded(&mesh),"metadata must participate in comparison");
}
#[test]
fn serde_skipped_frame_fields_participate_in_scene_comparison() {
    let mut mesh=actual_mesh();
    let expected=encoded(&mesh);
    mesh.local_to_world=Some([0.;16]);
    assert_ne!(expected,encoded(&mesh),"production serde intentionally skips this actual field");
    mesh.local_to_world=None;
    mesh.local_bounds=Some([0.;6]);
    assert_ne!(expected,encoded(&mesh));
}
