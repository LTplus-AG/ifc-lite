// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The frame an `IfcAxis2Placement3D` builds, checked within a 1e-9 tolerance.
//! Moved from `transform.rs` with the canonical placement readers.

use super::*;
use ifc_lite_core::EntityDecoder;

#[test]
fn direction3_reads_the_ratio_list_from_attribute_0() {
    let content = "#1=IFCDIRECTION((0.5,0.25,0.75));";
    let mut decoder = EntityDecoder::new(content);

    let v = decoder.direction3(1).unwrap();

    assert!((v[0] - 0.5).abs() < 1e-12);
    assert!((v[1] - 0.25).abs() < 1e-12);
    assert!((v[2] - 0.75).abs() < 1e-12);
}

#[test]
fn point3_at_reads_the_point_referenced_at_attribute_0() {
    // point3_at(parent, 0) resolves the ref stored at attribute 0 and
    // reads its coordinate list.
    let content = "\
#1=IFCCARTESIANPOINT((1.0,2.0,3.0));
#2=IFCAXIS2PLACEMENT3D(#1,$,$);";
    let mut decoder = EntityDecoder::new(content);
    let placement = decoder.decode_by_id(2).unwrap();

    let p = decoder.point3_at(&placement, 0).unwrap().unwrap();

    assert!((p[0] - 1.0).abs() < 1e-12);
    assert!((p[1] - 2.0).abs() < 1e-12);
    assert!((p[2] - 3.0).abs() < 1e-12);
}

#[test]
fn parse_axis2_placement_3d_defaults_missing_axis_and_ref_direction() {
    // IfcAxis2Placement3D attributes 1 (Axis) and 2 (RefDirection) are
    // entirely absent (not even `$`), so `placement.get(1)`/`get(2)`
    // return `None` and the default world Z/X axes must be used with no
    // orthogonalization needed (they're already perpendicular).
    let content = "\
#1=IFCCARTESIANPOINT((10.0,20.0,30.0));
#2=IFCAXIS2PLACEMENT3D(#1);";
    let mut decoder = EntityDecoder::new(content);
    let placement = decoder.decode_by_id(2).unwrap();
    assert_eq!(placement.attributes.len(), 1, "test fixture sanity check");

    let m = Axis2Placement::read_3d(&placement, &mut decoder)
        .unwrap()
        .matrix();

    // Translation column carries the location through unchanged.
    assert!((m[(0, 3)] - 10.0).abs() < 1e-9);
    assert!((m[(1, 3)] - 20.0).abs() < 1e-9);
    assert!((m[(2, 3)] - 30.0).abs() < 1e-9);
    // Default Z axis (0,0,1) -> column 2.
    assert!((m[(0, 2)] - 0.0).abs() < 1e-9);
    assert!((m[(1, 2)] - 0.0).abs() < 1e-9);
    assert!((m[(2, 2)] - 1.0).abs() < 1e-9);
    // Default X axis (1,0,0) -> column 0.
    assert!((m[(0, 0)] - 1.0).abs() < 1e-9);
    assert!((m[(1, 0)] - 0.0).abs() < 1e-9);
    assert!((m[(2, 0)] - 0.0).abs() < 1e-9);
}

// An Axis-only placement (RefDirection `$`, or the attribute missing) on
// each world axis: the frame the renderer draws. #5922: the viewer's
// compare reader (`apps/viewer/src/lib/compare/worldPlacement.test.ts`)
// pins the SAME table, so a change to this fill must move both.
#[test]
fn parse_axis2_placement_3d_axis_only_frames_on_world_axes() {
    type V = [f64; 3];
    let cases: [(V, V, V); 6] = [
        // (Axis, local X, local Y = Z x X)
        ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]),
        ([-1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, 1.0]),
        ([0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, -1.0]),
        ([0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
        ([0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
        ([0.0, 0.0, -1.0], [1.0, 0.0, 0.0], [0.0, -1.0, 0.0]),
    ];
    for ((axis, x, y), tail) in cases.iter().flat_map(|c| [(c, ",$"), (c, "")]) {
        let content = format!(
            "#1=IFCCARTESIANPOINT((0.0,0.0,0.0));\n#2=IFCDIRECTION(({:?},{:?},{:?}));\n#3=IFCAXIS2PLACEMENT3D(#1,#2{tail});",
            axis[0], axis[1], axis[2]
        );
        let mut decoder = EntityDecoder::new(&content);
        let placement = decoder.decode_by_id(3).unwrap();
        let m = Axis2Placement::read_3d(&placement, &mut decoder)
            .unwrap()
            .matrix();
        for i in 0..3 {
            assert!(
                (m[(i, 0)] - x[i]).abs() < 1e-9,
                "Axis {axis:?}{tail}: X = {:?}",
                m.column(0)
            );
            assert!(
                (m[(i, 1)] - y[i]).abs() < 1e-9,
                "Axis {axis:?}{tail}: Y = {:?}",
                m.column(1)
            );
        }
    }
}

#[test]
fn parse_axis2_placement_3d_orthogonalizes_parallel_ref_direction_low_z() {
    // RefDirection parallel to Axis forces the fallback branch. With
    // Axis = (1,0,0), |z.z| = 0 < 0.9, so the fallback is
    // world-Z x Axis = (0,0,1) x (1,0,0) = (0,1,0).
    let content = "\
#1=IFCCARTESIANPOINT((0.0,0.0,0.0));
#2=IFCDIRECTION((1.0,0.0,0.0));
#3=IFCDIRECTION((1.0,0.0,0.0));
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);";
    let mut decoder = EntityDecoder::new(content);
    let placement = decoder.decode_by_id(4).unwrap();

    let m = Axis2Placement::read_3d(&placement, &mut decoder)
        .unwrap()
        .matrix();

    // X axis (column 0) is the fallback perpendicular (0,1,0), not the
    // degenerate parallel RefDirection.
    assert!((m[(0, 0)] - 0.0).abs() < 1e-9);
    assert!((m[(1, 0)] - 1.0).abs() < 1e-9);
    assert!((m[(2, 0)] - 0.0).abs() < 1e-9);
    // Y = Z x X = (1,0,0) x (0,1,0) = (0,0,1) -> column 1.
    assert!((m[(0, 1)] - 0.0).abs() < 1e-9);
    assert!((m[(1, 1)] - 0.0).abs() < 1e-9);
    assert!((m[(2, 1)] - 1.0).abs() < 1e-9);
}

#[test]
fn parse_axis2_placement_3d_orthogonalizes_parallel_ref_direction_high_z() {
    // RefDirection parallel to Axis forces the fallback branch. With
    // Axis = (0,0,1), |z.z| = 1 >= 0.9, so the fallback is
    // world-X x Axis = (1,0,0) x (0,0,1) = (0,-1,0).
    let content = "\
#1=IFCCARTESIANPOINT((0.0,0.0,0.0));
#2=IFCDIRECTION((0.0,0.0,1.0));
#3=IFCDIRECTION((0.0,0.0,1.0));
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);";
    let mut decoder = EntityDecoder::new(content);
    let placement = decoder.decode_by_id(4).unwrap();

    let m = Axis2Placement::read_3d(&placement, &mut decoder)
        .unwrap()
        .matrix();

    // X axis (column 0) is the fallback perpendicular (0,-1,0).
    assert!((m[(0, 0)] - 0.0).abs() < 1e-9);
    assert!((m[(1, 0)] - (-1.0)).abs() < 1e-9);
    assert!((m[(2, 0)] - 0.0).abs() < 1e-9);
    // Y = Z x X = (0,0,1) x (0,-1,0) = (1,0,0) -> column 1.
    assert!((m[(0, 1)] - 1.0).abs() < 1e-9);
    assert!((m[(1, 1)] - 0.0).abs() < 1e-9);
    assert!((m[(2, 1)] - 0.0).abs() < 1e-9);
}
