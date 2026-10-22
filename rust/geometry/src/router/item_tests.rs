// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Parsed placement and producer metadata contracts recovered from #7867 (#7781).

use crate::router::GeometryRouter;
use ifc_lite_core::EntityDecoder;
use nalgebra::Matrix4;

const MODEL: &str = "#1=IFCCARTESIANPOINT((1000.,2000.,3000.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\
    #3=IFCLOCALPLACEMENT($,#2);#10=IFCWALL('g',$,$,$,$,#3,$,$);\
    #11=IFCWALL('g',$,$,$,$,#99,$,$);#12=IFCWALL('g',$,$,$,$,$,$,$);\
    #13=IFCWALL('g',$,$,$,$,123.,$,$);#14=IFCWALL('g',$,$,$,$,*,$,$);\
    #15=IFCWALL('g',$,$,$,$);";

#[test]
fn element_world_placement_scales_and_defaults_to_identity() {
    let mut d = EntityDecoder::new(MODEL);
    let router = GeometryRouter::with_scale(0.001);
    let wall = d.decode_by_id(10).unwrap();
    let t = router.element_world_placement(&wall, &mut d).unwrap();
    assert_eq!((t[(0, 3)], t[(1, 3)], t[(2, 3)]), (1.0, 2.0, 3.0));
    for id in [12, 14, 15] {
        let bare = d.decode_by_id(id).unwrap();
        assert_eq!(router.element_world_placement(&bare, &mut d).unwrap(), Matrix4::identity());
    }
}

#[test]
fn a_dangling_placement_keeps_the_canonical_decoder_error() {
    let mut d = EntityDecoder::new(MODEL);
    let router = GeometryRouter::new();
    let wall = d.decode_by_id(11).unwrap();
    let err = router.element_world_placement(&wall, &mut d).unwrap_err();
    assert!(err.to_string().contains("Entity #99 not found"), "{err}");
}

/// Pure pipeline consolidation must preserve externally supplied instance
/// metadata without an authored placement, while placed products replace it
/// with their actual world frame (#7781).
#[test]
fn placement_application_preserves_unplaced_instance_metadata() {
    use crate::{InstanceMeta, Mesh, SubMeshCollection};

    let mut decoder = EntityDecoder::new(MODEL);
    let router = GeometryRouter::with_scale_and_local_frame(1.0, false);
    let mut mesh = Mesh::new();
    mesh.positions = vec![0., 0., 0., 1., 0., 0., 0., 1., 0.];
    mesh.normals = vec![0., 0., 1., 0., 0., 1., 0., 0., 1.];
    mesh.indices = vec![0, 1, 2];
    let mut supplied = InstanceMeta::instanceable(42, None);
    supplied.transform[3] = 7.;
    let supplied_transform = supplied.transform;
    mesh.instance_meta = Some(supplied);

    for id in [12, 14, 15, 10] {
        for submesh_path in [false, true] {
            let element = decoder.decode_by_id(id).unwrap();
            let mut output = mesh.clone();
            if submesh_path {
                let mut parts = SubMeshCollection::new();
                parts.add(20, output);
                router.apply_submesh_placement(&mut parts, &element, &mut decoder).unwrap();
                output = parts.sub_meshes.remove(0).mesh;
            } else {
                router.apply_placement(&element, &mut decoder, &mut output).unwrap();
            }
            let metadata = output.instance_meta.as_ref().expect("instance metadata survives placement");
            assert_eq!(metadata.rep_identity, 42);
            assert!(metadata.instanceable);
            assert_eq!(metadata.local_transform, None);
            assert_eq!(metadata.canonical_transform, None);
            if id != 10 {
                assert_eq!(metadata.transform, supplied_transform);
                assert_eq!(output.positions, mesh.positions);
            } else {
                assert_eq!((metadata.transform[3], metadata.transform[7], metadata.transform[11]), (1000., 2000., 3000.));
                assert_eq!(&output.positions[..3], &[1000., 2000., 3000.]);
            }
        }
    }
}

/// Preserve main's #7877 refusal policy while consolidating #7867 helpers:
/// a present non-reference value cannot become an identity placement.
#[test]
fn issue_7867_main_7877_nonreference_placement_refuses_every_entry() {
    use crate::{Mesh, SubMeshCollection};

    let mut decoder = EntityDecoder::new(MODEL);
    let router = GeometryRouter::with_scale(0.001);
    let element = decoder.decode_by_id(13).unwrap();
    assert!(router.element_world_placement(&element, &mut decoder).is_err());
    let strict_error = router.resolve_scaled_placement_strict(&element, &mut decoder).unwrap_err();
    assert!(matches!(strict_error, crate::Error::GeometryError(ref message)
        if message.contains("cannot be resolved")), "{strict_error}");

    let mut mesh = Mesh::new();
    mesh.positions = vec![0., 0., 0., 1., 0., 0., 0., 1., 0.];
    mesh.normals = vec![0., 0., 1., 0., 0., 1., 0., 0., 1.];
    mesh.indices = vec![0, 1, 2];
    let mut parts = SubMeshCollection::new();
    parts.add(20, mesh.clone());
    assert!(router.apply_placement(&element, &mut decoder, &mut mesh).is_err());
    assert!(router.apply_submesh_placement(&mut parts, &element, &mut decoder).is_err());
}
