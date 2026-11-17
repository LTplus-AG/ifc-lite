// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! An opening that only touches its host cuts nothing.
//!
//! `fixtures/touching_opening_post_1401204.ifc` is wall #1401204 of
//! `tests/models/ara3d/ISSUE_068_ARK_NUS_skolebygg.ifc` with its two openings,
//! cut out by `scripts/ifc-extract-hosts.py --anonymise`. The wall is a post,
//! a 96 x 120 mm box 2.2 m tall, turned 2.2 degrees in plan and 260 m from the
//! origin. Its openings belong to the wall beside it and end ON the post's
//! faces, so IfcOpenShell 0.8.2 returns the box: 12 triangles, 0.025344 m3.
//!
//! Stored as f32 at that distance an opening face lands 13 um inside the
//! post. Cut as stored, the wall-frame cut shaves the face and leaves 0.2 mm
//! chips at two corners: 16 triangles, four of them 600:1, 5 cm3 short. The
//! mesh is closed, so the frame's snapped retry (`voids/frame_snap.rs`), which
//! puts the two faces back on one plane, did not run for it. It used to run by
//! accident: the post-cut sliver bisection tore the chipped mesh open.

use ifc_lite_processing::{process, ProcessingRequest};
use ifc_lite_testkit::mesh::{open_edges, signed_volume, triangle_shape, Key};

#[test]
fn a_post_its_neighbours_openings_only_touch_stays_a_box() {
    let ifc = include_str!("fixtures/touching_opening_post_1401204.ifc");
    let result = process(ifc.as_bytes(), &ProcessingRequest::full_pass(), &mut ());
    let meshes: Vec<_> = result.meshes.iter().filter(|mesh| mesh.express_id == 1_401_204).collect();
    assert_eq!(meshes.len(), 1, "the post is one mesh");
    let (positions, indices) = (&meshes[0].positions, &meshes[0].indices);

    assert_eq!(open_edges(positions, indices, Key::Grid(1.0e-5)), 0, "the post must be closed");
    let shape = triangle_shape(positions, indices);
    assert_eq!(
        (indices.len() / 3, shape.slivers),
        (12, 0),
        "a box is 12 triangles and its 96 mm x 2.2 m faces are 23:1; worst here {:.0}:1",
        shape.max_aspect
    );
    // The opening cuts nothing: the post is cut in its site's frame (#10435),
    // where the uncut post and the cut both enclose 0.0253411 m3. That is the
    // post stored as f32 211 m from the site origin, one f32 step there being
    // 15 um on a 96 mm side, and what main gives with the site placement at
    // identity. Placing the cut back 270 m out takes 1.6 cm3 more: 0.0253395,
    // 4.5 cm3 under IfcOpenShell, where main's wall-frame cut reads 0.0253445.
    // The chips this test is about (16 triangles, 5 cm3 short) fail the
    // triangle and sliver counts above.
    let volume = signed_volume(positions, indices).abs();
    assert!((volume - 0.025_344).abs() < 5.0e-6, "post of {volume:.7} m3, IfcOpenShell 0.0253440");
}
