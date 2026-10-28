// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
mod support;
use ifc_lite_geometry::program::transactions::Requirement;
use ifc_lite_processing::element::retained_runtime::ProductOutcome;

#[test]
fn m11_0_7955_real_sdk_keeps_face_partition_and_unmet_normals() {
    let Some(outcomes) = support::native(support::BOX) else { return; };
    let mut count = 0;
    for outcome in &outcomes {
        if let ProductOutcome::Published(product) = outcome {
            count += 1;
            assert_eq!(product.obligations.0.last(), Some(&Requirement::SurfaceNormals));
            for part in &product.parts {
                assert_eq!(part.revision_local_faces.len(), part.indices.len() / 3);
                assert!(!part.revision_local_faces.is_empty());
                assert!(part.normals.is_none() && part.appearance.is_none() && part.faces.is_none() && part.instance_key.is_none());
            }
        }
    }
    assert!(count > 0);
    println!("sdk witness executed: m11_0_faces_normals");
}
