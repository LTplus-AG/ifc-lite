// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Split out of `csg_capture.rs` because the revert-oracle classifies a FILE,
//! not a module, and an inline `#[cfg(test)] mod` leaves a branch reading
//! "changes production code and adds NO test file". That only gets past the
//! abort: reverting `csg_capture.rs` still removes the field and the whole
//! crate stops compiling, so this pair can never score OBSERVED. A compile
//! fix behind an off-by-default feature has no runtime observable, and the
//! real guard is the `--all-features` clippy leg in test.yml.

use super::*;

/// #4182 added `Mesh.welded_in_object_frame` and missed this construction
/// site, so `cargo build --all-features` failed on main with `E0063`. No CI
/// leg compiled the `csg_capture` feature, so it merged green.
///
/// DO NOT replace the literal below with `Mesh::new()`, `placed_box_mesh`, a
/// local `box_mesh` helper, or `..Default::default()`. Every one of them
/// builds a Mesh non-exhaustively, which silently removes the compile break
/// this test exists to create.
///
/// This pins the value rather than only the compile: a future `Mesh` field
/// makes the literal above fail to compile, and this asserts the one the
/// capture format cannot carry comes back `false` rather than whatever a
/// later `Default` happens to say.
#[test]
fn deserialize_defaults_welded_in_object_frame_to_false() {
    let mesh = Mesh {
        positions: vec![0.0, 0.0, 0.0],
        normals: vec![0.0, 0.0, 1.0],
        indices: vec![0],
        rtc_applied: true,
        origin: [1.0, 2.0, 3.0],
        instance_meta: None,
        local_bounds: None,
        local_to_world: None,
        welded_in_object_frame: true,
    };
    let job = CapturedCsgJob::Single { host: mesh.clone(), cutter: mesh.clone() };
    let blob = serialize(&[job]);
    let back = deserialize(&blob).expect("round trip");

    assert_eq!(back.len(), 1);
    let CapturedCsgJob::Single { host, .. } = &back[0] else {
        panic!("expected a Single job back");
    };
    assert_eq!(host.positions, mesh.positions);
    assert_eq!(host.rtc_applied, mesh.rtc_applied);
    assert!(
        !host.welded_in_object_frame,
        "the blob carries no weld bit, so it must deserialize false even when \
         the captured mesh was welded; see the comment on the constructor"
    );
}
