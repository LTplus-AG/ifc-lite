// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The local X axis the renderer gives an `IfcAxis2Placement3D` whose
//! `RefDirection` is `$` (#5922).
//!
//! TypeScript readers (the viewer's compare, the LOD0 exporter, collab, the
//! create package's writer) derive the same axis through ONE copy,
//! `firstProjAxis` in `packages/data/src/axis2-placement.ts`, which mirrors
//! `build_axis2_matrix`. Its tests (`axis2-placement.test.ts`) pin the vectors
//! below; if this behaviour changes, change both.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::parse_axis2_placement_3d;

/// Column 0 (local X in world) of a placement with Axis `axis` and `$`
/// RefDirection.
fn filled_x(axis: &str) -> [f64; 3] {
    let content = format!(
        "#1=IFCCARTESIANPOINT((0.0,0.0,0.0));\n#2=IFCDIRECTION(({axis}));\n#3=IFCAXIS2PLACEMENT3D(#1,#2,$);"
    );
    let mut decoder = EntityDecoder::new(&content);
    let placement = decoder.decode_by_id(3).unwrap();
    let m = parse_axis2_placement_3d(&placement, &mut decoder).unwrap();
    [m[(0, 0)], m[(1, 0)], m[(2, 0)]]
}

fn assert_close(actual: [f64; 3], expected: [f64; 3]) {
    for i in 0..3 {
        assert!(
            (actual[i] - expected[i]).abs() < 1e-12,
            "local X {actual:?}, expected {expected:?}"
        );
    }
}

#[test]
fn plus_x_axis_takes_world_y() {
    assert_close(filled_x("1.0,0.0,0.0"), [0.0, 1.0, 0.0]);
}

#[test]
fn minus_x_axis_takes_z_cross_axis() {
    // The schema's projection of X vanishes here; the renderer takes
    // (0,0,1) x (-1,0,0) = (0,-1,0), not world Y.
    assert_close(filled_x("-1.0,0.0,0.0"), [0.0, -1.0, 0.0]);
    assert_close(filled_x("-2.5,0.0,0.0"), [0.0, -1.0, 0.0]);
}

#[test]
fn near_x_axis_outside_tolerance_projects_world_x() {
    // Projection length ~4e-5 > 1e-6: world X projected, about (0,-1,0).
    let x = filled_x("1.0,0.00004,0.0");
    assert!(x[1] < -0.999_999, "local X {x:?}");
    assert!(x[0] > 0.0, "local X {x:?}");
}

#[test]
fn near_x_axis_inside_tolerance_takes_z_cross_axis() {
    // Projection length ~1e-7 <= 1e-6: (0,0,1) x Axis, about (0,+1,0).
    assert_close(filled_x("1.0,0.0000001,0.0"), [-1e-7, 1.0, 0.0]);
    assert_close(filled_x("-1.0,0.0000001,0.0"), [-1e-7, -1.0, 0.0]);
}

#[test]
fn tilted_axis_projects_world_x() {
    let h = std::f64::consts::FRAC_1_SQRT_2;
    assert_close(filled_x("1.0,0.0,1.0"), [h, 0.0, -h]);
}
