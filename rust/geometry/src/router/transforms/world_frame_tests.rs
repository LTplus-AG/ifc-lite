// SPDX-License-Identifier: MPL-2.0
//! Captured placement arithmetic works after disposal of decoder and router.
use super::*;
use crate::{GeometryProcessor, TessellationQuality};
use crate::processors::BlockProcessor;
use ifc_lite_core::EntityDecoder;

#[test]
fn owned_world_frame_places_real_constructor_without_source_services() {
    let mut mesh = {
        let source = "#10=IFCBLOCK($,2.,3.,4.);".to_owned();
        let mut decoder = EntityDecoder::new(&source);
        let entity = decoder.decode_by_id(10).unwrap();
        BlockProcessor::new().lower_owned(&entity, &mut decoder, TessellationQuality::Medium, None)
            .unwrap().unwrap().evaluate().unwrap()
    };
    let rtc = (5_000_000., 1_000_000., 300.);
    let frame = WorldFrame { rtc_offset: rtc, local_frame_enabled: false };
    let mut placement = Matrix4::identity();
    placement[(0, 3)] = rtc.0 + 7.;
    placement[(1, 3)] = rtc.1 + 11.;
    placement[(2, 3)] = rtc.2 + 13.;
    frame.transform_mesh_world(&mut mesh, &placement);
    assert!(mesh.rtc_applied);
    assert_eq!(mesh.origin, [0.; 3]);
    for (axis, expected) in [(0, (7., 9.)), (1, (11., 14.)), (2, (13., 17.))] {
        let min = mesh.positions.chunks_exact(3).map(|p| p[axis]).fold(f32::INFINITY, f32::min);
        let max = mesh.positions.chunks_exact(3).map(|p| p[axis]).fold(f32::NEG_INFINITY, f32::max);
        assert_eq!((min, max), expected);
    }
    assert_eq!(mesh.local_bounds, Some([0., 0., 0., 2., 3., 4.]));
    assert_eq!(mesh.local_to_world, Some(crate::math::mat4::from_na(&placement)));
}
