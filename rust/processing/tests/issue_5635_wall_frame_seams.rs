// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #5635: a plan-rotated wall cut in its own frame (#1167) came back
//! with T-junction seams (open directed edges) even when every opening was
//! redundant and the wall was left untouched.
//!
//! The host and its cutters reach the frame as f32 WORLD positions. Rotated
//! into the frame, each authored face lands on many depth values spread over
//! the world f32 quantum (µm), and the exact cut splits along all of them.
//! The model is a neutral reproduction of the reporter's curtain-wall layer:
//! a 44.7 m, 80 mm voided leaf ~86 m from the origin, turned in plan, whose
//! window voids are re-cut by tessellated box openings that remove nothing.

mod common;

use common::wall_frame_seams::{authored_volume, signed_volume, unpaired_directed_edges, wall_ifc};
use ifc_lite_processing::process_geometry;

fn assert_frame_cut_keeps_leaf_closed(plan_deg: f64) {
    let result = process_geometry(wall_ifc(plan_deg).as_bytes());
    let leaf = result
        .meshes
        .iter()
        .find(|m| m.express_id == 100)
        .expect("wall mesh");
    let open = unpaired_directed_edges(&leaf.positions, &leaf.indices);
    let volume = signed_volume(&leaf.positions, &leaf.indices);
    let expected = authored_volume();
    assert_eq!(
        open,
        0,
        "{plan_deg}°: redundant openings must leave the rotated leaf closed ({} tris, {volume:.6} m^3) (#5635)",
        leaf.indices.len() / 3
    );
    assert!(
        (volume - expected).abs() / expected < 5e-4,
        "{plan_deg}°: the openings only re-cut the voids; expected {expected:.6} m^3, got {volume:.6} m^3"
    );
}

#[test]
fn axis_aligned_leaf_stays_closed_5635() {
    assert_frame_cut_keeps_leaf_closed(0.0);
}

#[test]
fn plan_rotated_leaf_stays_closed_5635() {
    for deg in [-34.3, -12.0, 17.0, 29.0, 41.0, 61.0, 73.3, 133.0] {
        assert_frame_cut_keeps_leaf_closed(deg);
    }
}
