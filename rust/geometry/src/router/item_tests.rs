// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The item-pipeline builders: `InstanceMeta::instanceable`, the unit-scaled
//! row-major transform and the one element placement resolver.

use crate::router::GeometryRouter;
use crate::InstanceMeta;
use ifc_lite_core::EntityDecoder;
use nalgebra::Matrix4;

const MODEL: &str = "#1=IFCCARTESIANPOINT((1000.,2000.,3000.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\
    #3=IFCLOCALPLACEMENT($,#2);#10=IFCWALL('g',$,$,$,$,#3,$,$);\
    #11=IFCWALL('g',$,$,$,$,#99,$,$);#12=IFCWALL('g',$,$,$,$,$,$,$);";

#[test]
fn instanceable_is_the_identity_placed_shareable_tag() {
    let meta = InstanceMeta::instanceable(7, Some([2.0; 16]));
    assert_eq!(meta.transform, crate::math::mat4::IDENTITY);
    assert_eq!((meta.local_transform, meta.canonical_transform), (Some([2.0; 16]), None));
    assert!(meta.instanceable && meta.rep_identity == 7);
}

#[test]
fn scaled_row_major_scales_the_translation_only() {
    let router = GeometryRouter::with_scale(0.001);
    let mut m = Matrix4::<f64>::identity();
    m[(0, 3)] = 1000.0;
    m[(0, 0)] = 2.0;
    let row = router.scaled_row_major(&m);
    assert_eq!((row[0], row[3]), (2.0, 1.0));
}

#[test]
fn element_world_placement_scales_and_defaults_to_identity() {
    let mut d = EntityDecoder::new(MODEL);
    let router = GeometryRouter::with_scale(0.001);
    let wall = d.decode_by_id(10).unwrap();
    let t = router.element_world_placement(&wall, &mut d, false).unwrap();
    assert_eq!((t[(0, 3)], t[(1, 3)], t[(2, 3)]), (1.0, 2.0, 3.0));
    let bare = d.decode_by_id(12).unwrap();
    assert_eq!(router.element_world_placement(&bare, &mut d, true).unwrap(), Matrix4::identity());
}

#[test]
fn a_dangling_placement_is_the_decoders_error_on_both_readings() {
    let mut d = EntityDecoder::new(MODEL);
    let router = GeometryRouter::new();
    let wall = d.decode_by_id(11).unwrap();
    for strict in [false, true] {
        let err = router.element_world_placement(&wall, &mut d, strict).unwrap_err();
        assert!(err.to_string().contains("Entity #99 not found"), "{err}");
    }
}
