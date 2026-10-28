// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
use ifc_lite_processing::element::retained_runtime::{ShapePart, PartFaces, FaceKey};
#[path = "../src/element/session_retained/presentation/instancing_key.rs"]
mod key;

fn part() -> ShapePart {
    ShapePart { positions: vec![0.,0.,0., 1.,0.,0., 1.,1.,0., 0.,1.,0.],
        indices: vec![0,1,2, 0,2,3], world_from_object: [1.,0.,0.,0., 0.,1.,0.,0., 0.,0.,1.,0., 0.,0.,0.,1.],
        curved: false, revision_local_faces: vec![0,0], normals: None,
        appearance: None, faces: None, instance_key: None }
}

#[test]
fn issue_7955_m11_i_topology_is_part_of_byte_identity() {
    let a = part();
    let mut b = part();
    // Same vertices and triangle count, different connectivity. Never share.
    b.indices = vec![0,1,3, 1,2,3];
    assert_ne!(key::instance_key(16, &a), key::instance_key(16, &b));
}

#[test]
fn issue_7955_m11_i_key_excludes_placement_but_preserves_every_payload_bit() {
    let a = part();
    let mut b = part();
    b.world_from_object[12] = 2_600_000.;
    assert_eq!(key::instance_key(16, &a), key::instance_key(16, &b));
    assert_ne!(key::instance_key(16, &a), key::instance_key(17, &a));
    b.positions[0] = -0.;
    assert_ne!(key::instance_key(16, &a), key::instance_key(16, &b));
    b.positions[0] = f64::from_bits(1); // Even subnormal differences matter.
    assert_ne!(key::instance_key(16, &a), key::instance_key(16, &b));
}

#[test]
fn issue_7955_m11_i_optional_normals_and_source_faces_partition_groups() {
    let mut a = part();
    let mut b = part();
    b.normals = Some(vec![]);
    assert_ne!(key::instance_key(16, &a), key::instance_key(16, &b));
    a.normals = Some(vec![0.,0.,1.]);
    b.normals = Some(vec![0.,1.,0.]);
    assert_ne!(key::instance_key(16, &a), key::instance_key(16, &b));
    a.normals = None;
    b.normals = None;
    a.faces = Some(PartFaces { table: vec![FaceKey { item: 12, via: 0, role: "cap(end)".into() }], triangles: vec![0,0] });
    assert_ne!(key::instance_key(16, &a), key::instance_key(16, &b));
    b.faces = Some(PartFaces { table: vec![FaceKey { item: 12, via: 129, role: "cap(end)".into() }], triangles: vec![0,0] });
    assert_ne!(key::instance_key(16, &a), key::instance_key(16, &b));
}
