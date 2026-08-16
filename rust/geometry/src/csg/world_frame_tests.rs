// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! World-frame corpus coverage for the boolean seam (#2598's area).
//!
//! #2598 (caught pre-merge) derived the clip epsilon from the max
//! |coordinate| over all three axes plus the plane point: a georeferenced
//! model 10 km out in X, cut by a roughly-Z-normal plane, got a ~2.4 mm
//! epsilon from the irrelevant X magnitude and collapsed thin flush cuts.
//! That code never merged; the kernel's near-coplanar band carried the same
//! max-over-axes shape and DID reach production, which is what
//! `a_2mm_recess_cuts_identically_10km_out_in_x` caught. The band now
//! projects its per-axis extents onto the plane under test
//! (`kernel/near_band.rs`), and this corpus stays as the live guard on the
//! invariant the class keeps violating: a boolean's result must not depend
//! on how far along an ORTHOGONAL axis the operands sit (up to that axis's
//! own f32 noise).
//!
//! Observable: result volume, which is translation-invariant by
//! construction. Thin features are sized against the corpus's
//! normal-projected noise bound so a far-placement collapse is a defect,
//! never a tolerance judgement call.

use crate::csg::ClippingProcessor;
use crate::world_frame_fixture::{
    WORLD_FRAME_CASES, WorldFrameCase, mesh_volume, normal_projected_noise_bound,
    placed_box_mesh,
};

/// Host slab 1 m x 1 m x 0.3 m; cutter recesses `depth` into the TOP face
/// (plane normal Z) over a 0.4 m x 0.4 m footprint.
fn recess_volume(case: WorldFrameCase, depth: f64) -> f64 {
    let host = placed_box_mesh(case, [0.0, 0.0, 0.0], [1.0, 1.0, 0.3]);
    let cutter = placed_box_mesh(case, [0.3, 0.3, 0.3 - depth], [0.7, 0.7, 0.5]);
    let processor = ClippingProcessor::new();
    let result = processor
        .subtract_mesh(&host, &cutter)
        .expect("subtract must succeed");
    mesh_volume(&result)
}

const THIN_DEPTH: f64 = 0.002;
const EXPECTED_THIN: f64 = 0.3 - 0.4 * 0.4 * THIN_DEPTH;

#[test]
fn the_thin_recess_is_provably_above_the_z_noise_bound_in_every_case() {
    for case in WORLD_FRAME_CASES {
        let host = placed_box_mesh(case, [0.0, 0.0, 0.0], [1.0, 1.0, 0.3]);
        let cutter = placed_box_mesh(case, [0.3, 0.3, 0.3 - THIN_DEPTH], [0.7, 0.7, 0.5]);
        let bound = normal_projected_noise_bound([0.0, 0.0, 1.0], &[&host, &cutter]);
        assert!(
            THIN_DEPTH > 1_000.0 * bound,
            "corpus premise broken for {case:?}: depth {THIN_DEPTH} vs z-noise bound {bound}"
        );
    }
}

#[test]
fn a_deep_recess_is_placement_invariant() {
    // Counter-case scale: 100 mm is far outside every band in play, so this
    // must hold before and after any tolerance change.
    let near = recess_volume(WorldFrameCase::AtOrigin, 0.1);
    let far = recess_volume(WorldFrameCase::FarBaked, 0.1);
    let expected = 0.3 - 0.4 * 0.4 * 0.1;
    assert!((near - expected).abs() < 1e-4, "near {near} vs {expected}");
    assert!((far - expected).abs() < 1e-4, "far {far} vs {expected}");
}

#[test]
fn a_2mm_recess_cuts_at_the_origin() {
    let near = recess_volume(WorldFrameCase::AtOrigin, THIN_DEPTH);
    assert!(
        (near - EXPECTED_THIN).abs() < 1e-4,
        "near {near} vs {EXPECTED_THIN}"
    );
}

// The live regression guard for the normal-projected near band. It was
// KNOWN-FAILING under `#[should_panic]` until the band stopped reading the
// irrelevant 10 km X magnitude: on the max-over-axes form the far placement
// returns volume 0.3000030517580399, the full slab with the 2 mm recess
// WELDED AWAY. Mutating the projection back to max-over-axes still reproduces
// exactly that.
#[test]
fn a_2mm_recess_cuts_identically_10km_out_in_x() {
    let far = recess_volume(WorldFrameCase::FarBaked, THIN_DEPTH);
    assert!(
        (far - EXPECTED_THIN).abs() < 1e-4,
        "world-frame corpus: the SAME 2 mm recess that cuts at the origin must cut \
         10 km out in X (offset axis X, cut normal Z); far volume {far} vs expected \
         {EXPECTED_THIN}"
    );
}
