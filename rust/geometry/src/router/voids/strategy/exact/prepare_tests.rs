// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::kernel::mesh_bridge::SNAP_GRID;

fn axes() -> [Vector3<f64>; 3] {
    [Vector3::x(), Vector3::y(), Vector3::z()]
}

/// A 4 m x 0.2 m x 3 m core, the #11313 wall without its finish.
fn core() -> Mesh {
    GeometryRouter::make_box_mesh(Point3::new(0.0, 0.0, 0.0), Point3::new(4.0, 0.2, 3.0))
}

#[test]
fn a_box_holding_core_material_is_air_along_no_axis() {
    // The #635 fallback skips a directionless cut when ANY axis proves the
    // box is air (#11318). That is safe because a box holding material is
    // air along no axis: started 0.1 m inside the core, the core face
    // crosses its interior whichever axis is the depth.
    let host = core();
    let opening = (Point3::new(1.0, 0.1, 1.0), Point3::new(2.0, 0.212, 2.0));
    for dir in axes() {
        assert!(!cutter_is_outside_source(&host, opening, dir, SNAP_GRID * 0.5), "axis {dir:?}");
    }
}

#[test]
fn an_air_recess_on_the_core_face_is_air_along_its_depth_only() {
    // The recess fills y in [0.2, 0.212], touching the core and enclosing
    // only air. Its depth axis proves it; the other two see no exterior cap.
    let host = core();
    let recess = (Point3::new(1.0, 0.2, 1.0), Point3::new(2.0, 0.212, 2.0));
    let proved = axes().map(|axis| cutter_is_outside_source(&host, recess, axis, SNAP_GRID * 0.5));
    assert_eq!(proved, [false, true, false]);
}
