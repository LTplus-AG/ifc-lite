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
use crate::kernel::arrangement::Tri;
use crate::kernel::mesh_bridge::tris_to_mesh;
use crate::mesh::Mesh;
use crate::router::voids::geom::mesh_signed_volume;
use crate::world_frame_fixture::{
    WorldFrameCase, normal_projected_noise_bound, placed_box_mesh,
};

/// A 1 m x 1 m pair overlapping a genuine 5 mm in Z:
/// A spans z [0, 0.3], B spans z [0.295, 0.6].
const OVERLAP_M: f64 = 0.005;

fn overlapping_pair(case: WorldFrameCase) -> (Mesh, Mesh) {
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

/// `volume_m3` is documented exact to f64. The arrangement's output is f64 on
/// the 2^-16 grid, ~30 significant bits at 9 km, so a world-origin sum over
/// it rounds: a rotated sphere clipped by a box read 1.9e-5 relative off its
/// bit-exact origin twin. About the solid's own centre the readings agree.
#[test]
fn a_rotated_overlap_9km_out_reports_the_same_volume_as_at_the_origin() {
    let sphere_far = far_sphere();
    // A box covering the sphere's lower half and then some, so the overlap
    // is a thick solid the trust gate has no reason to withhold.
    let lo: [f64; 3] = std::array::from_fn(|k| FAR_SITE_M[k] - 0.5);
    let hi = [FAR_SITE_M[0] + 0.5, FAR_SITE_M[1] + 0.5, FAR_SITE_M[2] + 0.05];
    let box_far = placed_box_mesh(WorldFrameCase::AtOrigin, lo, hi);
    let sphere_near = translated_exactly(&sphere_far, FAR_SITE_M);
    let box_near = translated_exactly(&box_far, FAR_SITE_M);

    let read = |a: &Mesh, b: &Mesh| {
        let solid = intersection_solid(a, b);
        solid
            .volume_m3()
            .unwrap_or_else(|| panic!("a thick sphere/box overlap must be a Solid, got {solid:?}"))
    };
    let v_near = read(&sphere_near, &box_near);
    let v_far = read(&sphere_far, &box_far);

    // Just over half the sphere: bounded by the half-sphere below and the
    // whole sphere above, which guards against a trivially-zero pass.
    let sphere = SPHERE_VOLUME_M3;
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

// ---------------------------------------------------------------------------
// Far-site volume readings. The helpers stay private to this test file so the
// tests compile against production code as it was before this change.
// ---------------------------------------------------------------------------

/// A site 5-10 km out on every axis, under `LARGE_COORD_THRESHOLD_METERS`
/// per axis so nothing upstream recentres it, and a multiple of `2^-3` so a
/// mesh baked through f32 here can be translated back to the origin without
/// changing a single bit of its relative geometry (see
/// [`translated_exactly`]).
const FAR_SITE_M: [f64; 3] = [9000.375, 5000.25, 300.125];

const SPHERE_R_M: f64 = 0.3;
const SPHERE_VOLUME_M3: f64 = 4.0 / 3.0 * std::f64::consts::PI * SPHERE_R_M * SPHERE_R_M * SPHERE_R_M;

/// A UV sphere of radius [`SPHERE_R_M`] at [`FAR_SITE_M`] (20 rings, 25
/// segments, outward), rotated by [`rotate_and_place`] and baked through f32
/// as ingestion does. Rotated and non-integer, so the products in a
/// divergence sum do not stay exact the way the axis-aligned boxes above do.
fn far_sphere() -> Mesh {
    let (centre, r, stacks, slices) = (FAR_SITE_M, SPHERE_R_M, 20usize, 25usize);
    let point = |i: usize, j: usize| -> [f64; 3] {
        let phi = std::f64::consts::PI * i as f64 / stacks as f64;
        let theta = 2.0 * std::f64::consts::PI * j as f64 / slices as f64;
        let p = [r * phi.sin() * theta.cos(), r * phi.sin() * theta.sin(), r * phi.cos()];
        rotate_and_place(p, centre)
    };
    let mut tris: Vec<Tri> = Vec::new();
    for i in 0..stacks {
        for j in 0..slices {
            let (p00, p01) = (point(i, j), point(i, j + 1));
            let (p10, p11) = (point(i + 1, j), point(i + 1, j + 1));
            // The quad's two triangles; the one that degenerates at a pole
            // (two of its corners ARE the pole) is skipped there.
            if i + 1 < stacks {
                tris.push([p00, p10, p11]);
            }
            if i > 0 {
                tris.push([p00, p11, p01]);
            }
        }
    }
    tris_to_mesh(&tris)
}

/// `centre + R·p`, `R` = 0.7 rad about the (1, 2, 3) axis (Rodrigues). A
/// proper rotation, so winding is preserved.
fn rotate_and_place(p: [f64; 3], centre: [f64; 3]) -> [f64; 3] {
    let (ax, ay, az) = (1.0 / 14f64.sqrt(), 2.0 / 14f64.sqrt(), 3.0 / 14f64.sqrt());
    let (s, c) = 0.7f64.sin_cos();
    let t = 1.0 - c;
    let rot = [
        [t * ax * ax + c, t * ax * ay - s * az, t * ax * az + s * ay],
        [t * ax * ay + s * az, t * ay * ay + c, t * ay * az - s * ax],
        [t * ax * az - s * ay, t * ay * az + s * ax, t * az * az + c],
    ];
    std::array::from_fn(|k| rot[k][0] * p[0] + rot[k][1] * p[1] + rot[k][2] * p[2] + centre[k])
}

/// The same mesh moved by `-offset`, bit-exact: every f32 coordinate becomes
/// `(f64::from(x) - offset)`, which is exact when `offset` is a multiple of
/// the f32 ulp at the far magnitude ([`FAR_SITE_M`] is), and the result is
/// below 1 in magnitude so it re-enters f32 unchanged. Two meshes related by
/// this are the SAME geometry; any observable that differs between them is
/// reading the reference frame, not the mesh.
fn translated_exactly(mesh: &Mesh, offset: [f64; 3]) -> Mesh {
    let mut out = mesh.clone();
    for chunk in out.positions.chunks_exact_mut(3) {
        for k in 0..3 {
            chunk[k] = (f64::from(chunk[k]) - offset[k]) as f32;
        }
    }
    out
}

/// Open `mesh` by one f32 ulp (~1 mm at [`FAR_SITE_M`]) at triangle 7's first
/// corner, the way a shared vertex arriving through two placement transforms
/// rounds. Call before [`translated_exactly`] so both twins carry the crack.
fn crack_one_vertex(mesh: &mut Mesh) {
    let i = mesh.indices[7 * 3] as usize * 3;
    mesh.positions[i] = f32::from_bits(mesh.positions[i].to_bits() + 1);
}

/// `mesh_signed_volume` feeds every before/after gate in the void router
/// (the 3 % box reconciliation, the removal bound, and until #4692 a 0.1 %
/// "did the cut change the host" gate), and on native positions are absolute. The far and near
/// meshes are the SAME f32 geometry (translated bit-exactly), so any
/// difference between the readings is the reference point.
///
/// CLOSED is the control: f32 coordinates keep the cross products exact, and
/// a world-origin sum read only ~3e-9 relative off. CRACKED by one f32 ulp
/// (#198779's seam shape), a world-origin sum read 0.1135 against 0.1112
/// (2 %, twenty times the gate); about the mesh's bounding-box centre the two
/// readings agree.
#[test]
fn mesh_signed_volume_reads_the_same_volume_9km_out_as_at_the_origin() {
    let closed_far = far_sphere();
    let mut cracked_far = closed_far.clone();
    crack_one_vertex(&mut cracked_far);
    let analytic = SPHERE_VOLUME_M3;

    for (label, far, tol) in [
        ("closed", &closed_far, 1e-6),
        ("cracked", &cracked_far, 1e-3),
    ] {
        let near = translated_exactly(far, FAR_SITE_M);
        let v_near = mesh_signed_volume(&near);
        let v_far = mesh_signed_volume(far);
        assert!(
            (v_near - analytic).abs() < 0.03 * analytic,
            "{label}: near-origin control must read the sphere's volume: {v_near} vs {analytic}"
        );
        assert!(
            ((v_far - v_near) / v_near).abs() < tol,
            "{label}: the same mesh 9 km out read {v_far} against {v_near} at the origin \
             (relative {:e}): the reading depends on where the model sits",
            (v_far - v_near) / v_near
        );
    }
}
