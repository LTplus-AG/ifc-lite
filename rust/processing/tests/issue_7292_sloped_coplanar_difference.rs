// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7292 through the canonical native producer, including model placement,
//! millimetre units and per-mesh origins. The reporter's public generated
//! fixture is shared with the geometry-level reproduction rather than copied.
//! Its stated oracle (IfcOpenShell and web-ifc) leaves only the 25 mm strip.

use ifc_lite_processing::process_geometry;

const FIXTURE: &str = include_str!(
    "../../geometry/tests/fixtures/issue_7292_sloped_coplanar_difference.ifc"
);

fn assert_strip(bytes: &[u8]) {
    let result = process_geometry(bytes);
    let (mut minimum, mut maximum) = (f64::INFINITY, f64::NEG_INFINITY);
    let mut referenced_vertices = 0;
    for mesh in result.meshes.iter().filter(|mesh| mesh.express_id == 107) {
        for &index in &mesh.indices {
            let x = mesh.positions[index as usize * 3] as f64 + mesh.origin[0];
            minimum = minimum.min(x);
            maximum = maximum.max(x);
            referenced_vertices += 1;
        }
    }
    assert!(referenced_vertices > 0, "the 25 mm strip must remain");
    // 0.1 mm covers f32 storage and the kernel snap. Unreferenced vertices
    // do not contribute: the issue specifically reports indexed world bounds.
    assert!(
        (minimum + 3.025).abs() < 1.0e-4 && (maximum + 3.000).abs() < 1.0e-4,
        "#7292: expected indexed world x [-3.025, -3.000] m, got [{minimum}, {maximum}]"
    );
}

#[test]
fn issue_7292_shared_producer_leaves_only_the_25mm_strip() {
    assert_strip(FIXTURE.as_bytes());
}

#[test]
fn issue_7292_flat_difference_positive_control_leaves_the_strip() {
    // The reporter's stated positive control: the same geometry at 0 %.
    // Flatten both operand axes and both prism planes, preserving the notch,
    // depth, millimetre units, placement and 25 mm footprint difference.
    let mut flat = FIXTURE.to_owned();
    for (sloped, level) in [
        ("-0.019996001199600", "0.000000000000000"),
        ("0.019996001199600", "0.000000000000000"),
        ("0.999800059980007", "1.000000000000000"),
        ("64.0000", "48.0000"),
        ("144.9000", "128.9000"),
        ("65.2000", "48.0000"),
        ("146.1000", "128.9000"),
        ("70.0000", "48.0000"),
        ("150.9000", "128.9000"),
    ] {
        flat = flat.replace(sloped, level);
    }
    assert_strip(flat.as_bytes());
}
