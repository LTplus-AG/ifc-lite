// SPDX-License-Identifier: MPL-2.0
//! Unit tests for the from-bytes Z-up -> Y-up frame conversion in `frame.rs`.
//!
//! Split out per the repo convention for modules whose bulk is test code (see
//! `geom.rs` / `geom_tests.rs`).

use super::*;


/// Two distinct triangles exercise every index in the frame conversion.
const TRIS: [u32; 6] = [0, 1, 2, 1, 2, 3];

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

// #4056: an independent geometric invariant catches an incorrect reversal in
// either conversion, even when both implementations make the same mistake.
fn assert_faces_agree_with_normals(positions: &[f32], normals: &[f32], indices: &[u32]) {
    for tri in indices.chunks_exact(3) {
        let p = |i: usize| &positions[tri[i] as usize * 3..][..3];
        let a = p(0);
        let b = p(1);
        let c = p(2);
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let cross = [u[1]*v[2] - u[2]*v[1], u[2]*v[0] - u[0]*v[2], u[0]*v[1] - u[1]*v[0]];
        let n = &normals[tri[0] as usize * 3..][..3];
        let dot = cross[0]*n[0] + cross[1]*n[1] + cross[2]*n[2];
        assert!(dot > 0.0, "face must agree with its normal: {dot}");
    }
}

#[test]
fn frame_paths_preserve_face_normal_agreement_4056() {
    let positions = cube_corner_positions();
    let normals = [0.0, 0.0, 1.0].repeat(4);
    assert_faces_agree_with_normals(&positions, &normals, &TRIS);
    let mut scratch = YUpScratch::new();
    to_yup_into(&mut scratch, &positions, &normals, &TRIS, [0.0; 3]);
    assert_faces_agree_with_normals(&scratch.positions, &scratch.normals, &scratch.indices);
    assert_eq!(scratch.indices, TRIS);

    let mut positions = positions;
    let mut normals = normals;
    let mut indices = TRIS;
    to_yup_in_place(&mut positions, &mut normals, &mut indices, &mut [0.0; 3]);
    assert_faces_agree_with_normals(&positions, &normals, &indices);
    assert_eq!(indices, TRIS);
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
    assert_eq!(scratch.indices, TRIS);
}

#[test]
fn trailing_partial_triangle_is_left_alone() {
    // A frame rotation leaves every index unchanged, including a partial tail.
    let positions = cube_corner_positions();
    let normals = vec![0.0f32; positions.len()];

    let mut scratch = YUpScratch::new();
    let indices: Vec<u32> = vec![0, 1, 2, 3];
    to_yup_into(&mut scratch, &positions, &normals, &indices, [0.0, 0.0, 0.0]);
    assert_eq!(scratch.indices, vec![0, 1, 2, 3], "streaming path");

    let mut ip = positions.clone();
    let mut in_ = normals.clone();
    let mut ii: [u32; 4] = [0, 1, 2, 3];
    let mut io = [0.0f64; 3];
    to_yup_in_place(&mut ip, &mut in_, &mut ii, &mut io);
    assert_eq!(ii, [0, 1, 2, 3], "in-place path");
}

/// IFC Z is up; glTF Y is up. A rotation about the IFC up-axis has to come out
/// as the same rotation about the glTF up-axis.
///
/// Converting only the translation column, or getting `C_inv`'s signs
/// backwards, both yield something that still looks like a rotation and turns
/// the model the wrong way. No bounding box catches that, which is why the
/// assertion is on the matrix entries rather than on an extent.
#[test]
fn a_rotation_about_ifc_up_becomes_the_same_rotation_about_gltf_up() {
    // 90 degrees about Z, column-major.
    let mut m = [0.0f64; 16];
    m[1] = 1.0;
    m[4] = -1.0;
    m[10] = 1.0;
    m[15] = 1.0;
    let y = yup_matrix4(&m);
    let at = |r: usize, c: usize| y[c * 4 + r];
    // 90 degrees about Y: X goes to -Z, Z goes to X, Y is fixed.
    assert!(at(0, 0).abs() < 1e-12, "{y:?}");
    assert!((at(2, 0) + 1.0).abs() < 1e-12, "{y:?}");
    assert!((at(0, 2) - 1.0).abs() < 1e-12, "{y:?}");
    assert!((at(1, 1) - 1.0).abs() < 1e-12, "{y:?}");
}

/// A proper rotation must not come back as a mirror.
#[test]
fn the_matrix_conversion_preserves_handedness() {
    let mut m = [0.0f64; 16];
    // From the angle, so the input is exactly a rotation. Hard-coding rounded
    // sines gives a determinant of 0.999996 and a test that fails on its own
    // fixture rather than on the code.
    let angle = 66.97_f64.to_radians(); // as ISSUE_129 carries
    let (s, c) = angle.sin_cos();
    m[0] = c;
    m[1] = s;
    m[4] = -s;
    m[5] = c;
    m[10] = 1.0;
    m[15] = 1.0;
    let y = yup_matrix4(&m);
    let at = |r: usize, cc: usize| y[cc * 4 + r];
    let det = at(0, 0) * (at(1, 1) * at(2, 2) - at(1, 2) * at(2, 1))
        - at(0, 1) * (at(1, 0) * at(2, 2) - at(1, 2) * at(2, 0))
        + at(0, 2) * (at(1, 0) * at(2, 1) - at(1, 1) * at(2, 0));
    assert!((det - 1.0).abs() < 1e-9, "determinant {det}, expected +1");
}

/// The bottom row must survive untouched.
///
/// It is not part of the basis change, and no current caller reads it, which is
/// exactly why it was wrong: the first consumer to compose or invert this
/// matrix would have inherited `(-r10, -r12, r11, -ty)` with nothing to say so.
/// Asserted on a matrix whose rotation part is non-symmetric, so a row/column
/// mix-up cannot hide behind a coincidence.
#[test]
fn the_bottom_row_is_left_alone() {
    let angle = 0.7_f64;
    let (s, c) = angle.sin_cos();
    let mut m = [0.0f64; 16];
    m[0] = c;
    m[1] = s;
    m[4] = -s;
    m[5] = c;
    m[10] = 1.0;
    m[12] = 1_661_267.2;
    m[13] = 8_178_640.5;
    m[14] = -14.1;
    m[15] = 1.0;
    let y = yup_matrix4(&m);
    // Column-major: the bottom row is entries 3, 7, 11, 15.
    assert_eq!([y[3], y[7], y[11], y[15]], [0.0, 0.0, 0.0, 1.0], "{y:?}");
}

/// #4056: preserving winding during the frame rotation must not erase an
/// actual reflection carried by an element placement.
#[test]
fn frame_change_preserves_a_reflected_placement_4056() {
    let m = [-1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0,
             0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
    let y = yup_matrix4(&m);
    assert_eq!(y, m, "an X reflection remains an X reflection after changing up-axis");
    assert_eq!(y[0] * y[5] * y[10], -1.0);
}
