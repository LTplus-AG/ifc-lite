// SPDX-License-Identifier: MPL-2.0
//! Independent profile/solid rotation and oblique extrusion must reconstruct
//! the authored cap corners in both unit systems.
use super::*;
use crate::analytic::{extract_analytic_extrusion, with_source_capture, AnalyticStatus};
use ifc_lite_core::{build_entity_index, EntityDecoder};

pub(super) fn recipe(raw_per_metre: f64) -> RetainedExtrusion {
    let u = raw_per_metre;
    let data = format!(
        "#1=IFCCARTESIANPOINT(({},{}));\n\
#2=IFCDIRECTION((0.,2.));\n#3=IFCAXIS2PLACEMENT2D(#1,#2);\n\
#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,#3,{},{});\n\
#5=IFCCARTESIANPOINT(({},{},{}));\n\
#6=IFCDIRECTION((0.,1.,0.));\n#7=IFCDIRECTION((0.,0.,1.));\n\
#8=IFCAXIS2PLACEMENT3D(#5,#6,#7);\n#9=IFCDIRECTION((2.,1.,2.));\n\
#10=IFCEXTRUDEDAREASOLID(#4,#8,#9,{});",
        10. * u,
        20. * u,
        2. * u,
        4. * u,
        1e9 * u,
        2e9 * u,
        3e9 * u,
        3. * u
    );
    let mut decoder =
        EntityDecoder::with_index(data.as_bytes(), build_entity_index(data.as_bytes()));
    let entity = decoder.decode_by_id(10).unwrap();
    let source = with_source_capture(|| extract_analytic_extrusion(&entity, &mut decoder));
    assert_eq!(source.status, AnalyticStatus::Complete);
    RetainedExtrusion {
        source,
        length_unit_scale: 1. / u,
    }
}
fn number(bytes: &[u8], offset: usize) -> f64 {
    f64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}
#[test]
fn rectangle_caps_reconstruct_rotated_oblique_source_in_metres_and_millimetres() {
    for u in [1., 1000.] {
        let recipe = recipe(u);
        let original = recipe.source.clone();
        let payload = lower(&recipe).unwrap();
        assert_eq!(recipe.source, original);
        assert_eq!(payload.qualification, RegionQualification::Rectangle);
        let transform = Matrix4::from_column_slice(&payload.source_from_evaluation);
        let inverse = Matrix4::from_column_slice(&payload.evaluation_from_source);
        let axis = Vector4::new(
            number(&payload.bytes, 16),
            number(&payload.bytes, 24),
            number(&payload.bytes, 32),
            0.,
        );
        let depth = number(&payload.bytes, 40);
        assert!((depth - 3.).abs() < 1e-12);
        assert!((axis[0] - 1. / 3.).abs() < 1e-12);
        assert!((axis[1] + 2. / 3.).abs() < 1e-12);
        assert!((axis[2] - 2. / 3.).abs() < 1e-12);
        let base = transform * Vector4::new(0., 0., 0., 1.);
        let top = transform * Vector4::new(axis[0] * depth, axis[1] * depth, axis[2] * depth, 1.);
        let expected = [1e9 + 19., 2e9, 3e9 + 12.];
        for i in 0..3 {
            assert!((base[i] / u - expected[i]).abs() < 1e-6);
            let delta = [1., 2., 2.][i];
            assert!(((top[i] - base[i]) / u - delta).abs() < 1e-6);
        }
        // All four cap corners, independently computed from authored P and S.
        for (i, offset) in [[0., 0., 0.], [2., 0., 0.], [2., 4., 0.], [0., 4., 0.]]
            .iter()
            .enumerate()
        {
            let point = transform * Vector4::new(offset[0], offset[1], offset[2], 1.);
            let raw_corner = [[19., 0., 12.], [21., 0., 12.], [21., 0., 8.], [19., 0., 8.]][i];
            for axis in 0..3 {
                assert!(
                    (point[axis] / u - ([1e9, 2e9, 3e9][axis] + raw_corner[axis])).abs() < 1e-6
                );
            }
            let local = inverse * point;
            for axis in 0..3 {
                assert!((local[axis] - offset[axis]).abs() < 1e-3);
            }
        }
    }
}
