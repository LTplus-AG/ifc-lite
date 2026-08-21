// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! World-frame corpus coverage for the intersection-solid trust gate.
//!
//! `intersection_solid` gates on `TRUST_BAND_MULTIPLE * band`, where `band`
//! used to come from `near_band_from_extent(operand_extent(a, b))` —
//! `operand_extent` being the max |coordinate| over ALL THREE axes of both
//! operands, the milder shared form of the #2598/#2600/#2529 class. The
//! thickness it gates is measured along the contact normal (Z here), whose
//! f32 noise does not grow with an X offset; deriving the requirement from
//! the X magnitude made the SAME genuine 5 mm overlap a `Solid` at the origin
//! and `BelowKernelResolution` 10 km out. The corpus places the identical
//! pair in both frames; a frame-correct gate answers identically.
//!
//! Fixed by projecting the operands' per-axis extents onto the SAME axis the
//! thickness is measured along (`NearBand::scaled_band2`, `operand_near_band`
//! in `clash_solid.rs`), exactly as `near_band.rs` already does for the
//! kernel's own near-coplanar reconciliation. `a_5mm_overlap_10km_out_in_x_
//! must_still_be_a_solid` below used to assert the correct behaviour under
//! `#[should_panic]`, documenting the defect without silently rotting; now
//! that the gate is frame-correct it asserts the same thing as a normal
//! passing test.

use super::{DegenerateReason, IntersectionSolid, intersection_solid};
use crate::world_frame_fixture::{
    WorldFrameCase, normal_projected_noise_bound, placed_box_mesh,
};

/// A 1 m x 1 m pair overlapping a genuine 5 mm in Z:
/// A spans z [0, 0.3], B spans z [0.295, 0.6].
const OVERLAP_M: f64 = 0.005;

fn overlapping_pair(case: WorldFrameCase) -> (crate::mesh::Mesh, crate::mesh::Mesh) {
    let a = placed_box_mesh(case, [0.0, 0.0, 0.0], [1.0, 1.0, 0.3]);
    let b = placed_box_mesh(case, [0.0, 0.0, 0.3 - OVERLAP_M], [1.0, 1.0, 0.6]);
    (a, b)
}

#[test]
fn the_overlap_is_provably_above_the_z_noise_bound_in_every_case() {
    // 5 mm is four orders of magnitude above the legitimate Z-noise bound in
    // BOTH placements (the offset touches only X), so withholding the solid
    // far from the origin is a defect, never a tolerance judgement call.
    for case in crate::world_frame_fixture::WORLD_FRAME_CASES {
        let (a, b) = overlapping_pair(case);
        let bound = normal_projected_noise_bound([0.0, 0.0, 1.0], &[&a, &b]);
        assert!(
            OVERLAP_M > 10_000.0 * bound,
            "corpus premise broken for {case:?}: overlap {OVERLAP_M} vs z-noise bound {bound}"
        );
    }
}

#[test]
fn counter_case_a_5mm_overlap_at_the_origin_is_a_solid() {
    let (a, b) = overlapping_pair(WorldFrameCase::AtOrigin);
    let solid = intersection_solid(&a, &b);
    let volume = solid
        .volume_m3()
        .unwrap_or_else(|| panic!("expected a Solid at the origin, got {solid:?}"));
    let expected = 1.0 * 1.0 * OVERLAP_M;
    assert!(
        (volume - expected).abs() < 1e-4,
        "volume {volume} vs expected {expected}"
    );
}

#[test]
fn counter_case_a_sub_band_overlap_at_the_origin_stays_withheld() {
    // Guards the other direction: a "fix" that simply loosens the gate must
    // not start trusting an overlap inside the kernel's own noise band.
    let a = placed_box_mesh(WorldFrameCase::AtOrigin, [0.0, 0.0, 0.0], [1.0, 1.0, 0.3]);
    let b = placed_box_mesh(
        WorldFrameCase::AtOrigin,
        [0.0, 0.0, 0.3 - 0.0002],
        [1.0, 1.0, 0.6],
    );
    assert!(
        matches!(
            intersection_solid(&a, &b),
            IntersectionSolid::Degenerate(DegenerateReason::BelowKernelResolution { .. })
        ),
        "a 0.2 mm overlap sits inside the kernel's near band and must stay withheld"
    );
}

// Was KNOWN-FAILING on the live max-over-axes gate (asserted the CORRECT
// behaviour under `#[should_panic(expected = "world-frame corpus
// [withheld]")]`): `operand_extent` read ~10 km from the irrelevant X axis,
// the required thickness ballooned to ~9.5 mm, and the genuine 5 mm Z overlap
// was withheld. Now that the gate projects the band onto the SAME axis the
// thickness is measured along (`operand_near_band` /
// `NearBand::scaled_band2` in `clash_solid.rs`), an X-axis offset no longer
// widens the Z-normal requirement and this passes like any other test.
#[test]
fn a_5mm_overlap_10km_out_in_x_must_still_be_a_solid() {
    let (a, b) = overlapping_pair(WorldFrameCase::FarBaked);
    let solid = intersection_solid(&a, &b);
    let volume = solid.volume_m3().unwrap_or_else(|| {
        panic!(
            "the SAME genuine 5 mm overlap that is a Solid at the origin must be a \
             Solid 10 km out in X (offset axis X, contact normal Z); got {solid:?}"
        )
    });
    let expected = 1.0 * 1.0 * OVERLAP_M;
    assert!(
        (volume - expected).abs() < 1e-4,
        "the gate returned a Solid 10 km out, but its far-placement volume {volume} \
         does not match the expected {expected}"
    );
}
