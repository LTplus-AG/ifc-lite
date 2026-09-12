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


/// The reported `volume_m3` used to come from a world-origin divergence sum
/// over the arrangement's triangles. The box corpus above cannot see that:
/// its coordinates are integers and axis-aligned, so every product in the
/// sum is exact at any offset. The arrangement's output is f64 on the 2^-16
/// grid, ~30 significant bits at 9 km, so its cross products round, and a
/// rotated sphere clipped by a box (650 output triangles) read 1.9e-5
/// relative off its origin twin (bit-exact translation, see the fixture).
/// Small, but the field is documented "exact to f64" and the reference
/// point was the only thing that differed. About the solid's own centre the
/// two readings agree to 1e-15.
#[test]
fn a_rotated_overlap_9km_out_reports_the_same_volume_as_at_the_origin() {
    use crate::world_frame_fixture::{placed_sphere_mesh, translated_exactly, FAR_SITE_M};
    let sphere_far = placed_sphere_mesh(FAR_SITE_M, 0.3, 20, 25);
    // A box covering the sphere's lower half and then some, so the overlap
    // is a thick solid the trust gate has no reason to withhold.
    let lo: [f64; 3] = std::array::from_fn(|k| FAR_SITE_M[k] - 0.5);
    let hi = [FAR_SITE_M[0] + 0.5, FAR_SITE_M[1] + 0.5, FAR_SITE_M[2] + 0.05];
    let box_far = placed_box_mesh(WorldFrameCase::AtOrigin, lo, hi);
    let sphere_near = translated_exactly(&sphere_far, FAR_SITE_M);
    let box_near = translated_exactly(&box_far, FAR_SITE_M);

    let read = |a: &crate::mesh::Mesh, b: &crate::mesh::Mesh| {
        let solid = intersection_solid(a, b);
        solid
            .volume_m3()
            .unwrap_or_else(|| panic!("a thick sphere/box overlap must be a Solid, got {solid:?}"))
    };
    let v_near = read(&sphere_near, &box_near);
    let v_far = read(&sphere_far, &box_far);

    // Just over half a 0.3 m sphere: bounded by the half-sphere below and
    // the whole sphere above, which guards against a trivially-zero pass.
    let sphere = 4.0 / 3.0 * std::f64::consts::PI * 0.3f64.powi(3);
    assert!(
        v_near > 0.5 * sphere && v_near < sphere,
        "near-origin control reads {v_near}, outside ({}, {sphere})",
        0.5 * sphere
    );
    assert!(
        ((v_far - v_near) / v_near).abs() < 1e-7,
        "the same overlap 9 km out reports {v_far} against {v_near} at the origin \
         (relative {:e})",
        (v_far - v_near) / v_near
    );
}
