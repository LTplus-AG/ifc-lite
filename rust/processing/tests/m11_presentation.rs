// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
// Exercise the production copy with hand mesh evidence, without a fabricated runtime receipt.
use ifc_lite_geometry::{program::transactions::Resources as OwnedResourceContext, resource::{self, Reservation}};
use ifc_lite_processing::element::retained_runtime::{RetainedExecutionError, ShapePart};
mod runtime { pub use ifc_lite_processing::element::retained_runtime::ReceiptMesh; }
mod publication { pub use super::ShapePart; }
#[allow(dead_code)]
#[path = "../src/element/session_retained/storage.rs"]
mod storage;
use storage::Storage;
#[path = "../src/element/session_retained/publication_mesh.rs"]
mod publication_mesh;

#[test]
fn m11_0_7955_copy_preserves_triangle_face_partition_without_claiming_persistent_identity() {
    let positions = [0.,0.,0., 1.,0.,0., 1.,1.,0., 0.,1.,0., 0.,0.,1.];
    let indices = [0,1,2, 0,2,3, 0,4,1];
    let faces = [17,17,93]; // two triangles of one plane, one of another; not dense indices
    let frame = [1.,0.,0.,0., 0.,1.,0.,0., 0.,0.,1.,0., 10.,20.,30.,1.];
    let part = publication_mesh::copy_part(runtime::ReceiptMesh { positions: &positions, indices: &indices, faces: &faces },
        frame, false, &OwnedResourceContext::capture_current(), &mut Storage::default()).unwrap();
    assert_eq!(part.positions, positions);
    assert_eq!(part.indices, indices);
    assert_eq!(part.world_from_object, frame);
    assert_eq!(part.revision_local_faces, faces, "every triangle retains the authenticated revision-local face partition");
    assert!(part.normals.is_none() && part.appearance.is_none() && part.faces.is_none() && part.instance_key.is_none());
}
