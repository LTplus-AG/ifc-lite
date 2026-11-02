// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955, SMLib-free: the exact volume beyond a clip plane and the frozen limit it answers to.
//! The refusal through a real kernel is `retained-native/tests/clip_sliver_native_7955.rs`.
use ifc_lite_processing::element::retained_runtime::{volume_beyond, within_clip_limit};

/// A 2 x 1 x 1 box; `tilt` raises the plane's far end, so z' = z - 1 + tilt x removes a wedge.
fn tilted_box(tilt: f64) -> (Vec<f64>, Vec<u32>, [f64; 16]) {
    let positions: Vec<f64> = (0..8).flat_map(|i| [if i & 4 != 0 { 2. } else { 0. }, if i & 2 != 0 { 1. } else { 0. }, if i & 1 != 0 { 1. } else { 0. }]).collect();
    let indices = vec![0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3];
    // Column-major: third row (z') = tilt x + z - 1.
    let plane = [1., 0., tilt, 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., -1., 1.];
    (positions, indices, plane)
}

#[test]
fn the_wedge_beyond_a_tilted_plane_has_its_closed_form() {
    for depth in [4.9e-6, 1e-4, 0.5] {
        let (positions, indices, plane) = tilted_box(depth / 2.);
        // z' > 0 over the whole footprint at x = 2: a wedge of length 2, width 1, height `depth`.
        let beyond = volume_beyond(&positions, &indices, &plane).unwrap();
        assert!((beyond - depth).abs() <= depth * 1e-9, "{beyond} vs {depth}");
    }
}

#[test]
fn a_clean_cut_has_nothing_beyond_its_plane() {
    let (positions, indices, _) = tilted_box(0.);
    let plane = [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., -1., 1.];
    assert_eq!(volume_beyond(&positions, &indices, &plane), Some(0.));
    let clear = [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., -2., 1.];
    assert_eq!(volume_beyond(&positions, &indices, &clear), Some(0.));
}

#[test]
fn only_a_wedge_past_the_frozen_limit_is_refused() {
    // ISSUE_129 #271772 at 2.4e-5 and beam #314098 at 1.1e-6 against the linear 1e-6.
    assert!(!within_clip_limit(2.4e-5, 1., false));
    assert!(!within_clip_limit(1.1e-6, 1., false));
    // Rounding of a clean cut, and a wedge inside the limit, publish.
    assert!(within_clip_limit(1e-12, 1., false));
    assert!(within_clip_limit(9e-7, 1., false));
    // A curved host answers to the curved limit.
    assert!(within_clip_limit(1.1e-6, 1., true));
    assert!(!within_clip_limit(2.1e-3, 1., true));
}
