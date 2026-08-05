// SPDX-License-Identifier: MPL-2.0
//! Unit tests for the from-bytes Z-up -> Y-up frame conversion in `frame.rs`.
//!
//! Split out per the repo convention for modules whose bulk is test code (see
//! `geom.rs` / `geom_tests.rs`).

use super::*;


/// Two triangles whose index triples are all distinct, so an unswapped
/// pass-through is distinguishable from a correctly reversed winding.
const TRIS: [u32; 6] = [0, 1, 2, 1, 2, 3];
/// Per triangle `[a, b, c]` the 2nd/3rd entries swap: `[a, c, b]`.
const TRIS_REVERSED: [u32; 6] = [0, 2, 1, 1, 3, 2];

fn cube_corner_positions() -> Vec<f32> {
    vec![
        0.0, 0.0, 0.0, // v0
        1.0, 0.0, 0.0, // v1
        0.0, 1.0, 0.0, // v2
        0.0, 0.0, 1.0, // v3
    ]
}

#[test]
fn yup_swaps_and_negates_the_expected_axes() {
    // `(x, y, z) -> (x, z, -y)`. Distinct non-zero components in every slot,
    // so neither a dropped negation nor a wrong axis pair can hide.
    assert_eq!(yup_f32([1.0, 2.0, 3.0]), [1.0, 3.0, -2.0]);
    assert_eq!(yup_f64([1.0, 2.0, 3.0]), [1.0, 3.0, -2.0]);
}

/// The module header declares reversed triangle winding a load-bearing part
/// of the Z-up→Y-up contract ("mirrors `MeshDataJs::new`, keeps front
/// faces"). Nothing pinned it: deleting the swap from BOTH `to_yup_into` and
/// `to_yup_in_place` AND from `obj.rs`'s hand-written copy left the whole
/// crate suite green (82/82). glTF materials are emitted `doubleSided: true`
/// unconditionally, so no renderer-facing assertion can ever fail on
/// winding, and the `*_is_byte_identical` tests compare the exporter against
/// itself — a bug applied consistently is invisible to them by construction.
///
/// So pin each copy DIRECTLY against a literal, rather than against another
/// copy: an equivalence test between two implementations of the same
/// conversion cannot see a mutation applied symmetrically to both.
#[test]
fn to_yup_into_reverses_triangle_winding() {
    let mut scratch = YUpScratch::new();
    let positions = cube_corner_positions();
    let normals = vec![0.0f32; positions.len()];
    to_yup_into(&mut scratch, &positions, &normals, &TRIS, [0.0, 0.0, 0.0]);
    assert_eq!(scratch.indices, TRIS_REVERSED, "streaming path must reverse winding");
}

#[test]
fn to_yup_in_place_reverses_triangle_winding() {
    let mut positions = cube_corner_positions();
    let mut normals = vec![0.0f32; positions.len()];
    let mut indices = TRIS;
    let mut origin = [0.0f64; 3];
    to_yup_in_place(&mut positions, &mut normals, &mut indices, &mut origin);
    assert_eq!(indices, TRIS_REVERSED, "in-place path must reverse winding");
}

/// The two frame paths are documented as producing identical output; the
/// in-place one exists purely to skip a copy. Pin that equivalence across
/// ALL four outputs, on a fixture with a non-zero origin and asymmetric
/// coordinates so a swapped or unnegated axis cannot survive.
#[test]
fn to_yup_into_and_in_place_agree_on_every_output() {
    let positions = vec![1.0f32, 2.0, 3.0, -4.0, 5.0, -6.0, 7.0, -8.0, 9.0, 0.5, 0.25, -0.125];
    let normals = vec![0.0f32, 1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, -1.0, 0.0, 0.0];
    let origin = [10.0f64, -20.0, 30.0];

    let mut scratch = YUpScratch::new();
    to_yup_into(&mut scratch, &positions, &normals, &TRIS, origin);

    let mut ip = positions.clone();
    let mut in_ = normals.clone();
    let mut ii = TRIS;
    let mut io = origin;
    to_yup_in_place(&mut ip, &mut in_, &mut ii, &mut io);

    assert_eq!(scratch.positions, ip);
    assert_eq!(scratch.normals, in_);
    assert_eq!(scratch.indices, ii.to_vec());
    assert_eq!(scratch.origin, io);
    // The fixture must actually exercise the conversion: an all-zero or
    // symmetric input would make this equivalence hold vacuously.
    assert_ne!(scratch.positions, positions, "fixture must not be a fixed point of the swap");
    assert_ne!(scratch.origin, origin, "origin fixture must not be a fixed point");
}

#[test]
fn to_yup_into_clears_previous_contents_when_reused() {
    // The scratch is reused across meshes; a missing `clear()` would append
    // the second mesh onto the first. Both meshes are the same size, so only
    // an explicit length check catches it.
    let mut scratch = YUpScratch::new();
    let positions = cube_corner_positions();
    let normals = vec![0.0f32; positions.len()];
    to_yup_into(&mut scratch, &positions, &normals, &TRIS, [0.0, 0.0, 0.0]);
    to_yup_into(&mut scratch, &positions, &normals, &TRIS, [0.0, 0.0, 0.0]);
    assert_eq!(scratch.positions.len(), positions.len());
    assert_eq!(scratch.normals.len(), normals.len());
    assert_eq!(scratch.indices, TRIS_REVERSED);
}

#[test]
fn trailing_partial_triangle_is_left_alone() {
    // `tri_end` rounds down to a whole triangle; a stray index must not be
    // swapped into the previous triangle. Kills `% 3` -> `% 2`.
    //
    // Both paths compute `tri_end` independently, so both are asserted — the
    // whole point of this file is that pinning one copy of a duplicated
    // calculation says nothing about the other.
    let positions = cube_corner_positions();
    let normals = vec![0.0f32; positions.len()];

    let mut scratch = YUpScratch::new();
    let indices: Vec<u32> = vec![0, 1, 2, 3];
    to_yup_into(&mut scratch, &positions, &normals, &indices, [0.0, 0.0, 0.0]);
    assert_eq!(scratch.indices, vec![0, 2, 1, 3], "streaming path");

    let mut ip = positions.clone();
    let mut in_ = normals.clone();
    let mut ii: [u32; 4] = [0, 1, 2, 3];
    let mut io = [0.0f64; 3];
    to_yup_in_place(&mut ip, &mut in_, &mut ii, &mut io);
    assert_eq!(ii, [0, 2, 1, 3], "in-place path");
}
