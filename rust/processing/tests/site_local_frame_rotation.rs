// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Direct unit coverage for `convert_mesh_to_site_local` — the public
//! site-local frame conversion the streaming server calls on meshes it
//! produces outside this crate's parallel loop.
//!
//! `site_rotation.rs` drives the same conversion through `process_geometry`,
//! but its fixture shares two symmetries with the code under test, and each
//! one hides a whole arm of it. Both were confirmed by mutation against the
//! full `ifc-lite-processing` suite:
//!
//! 1. **The per-mesh `origin` is `[0, 0, 0]`.** The fixture's coordinates are
//!    small, so no RTC rebase ever moves a mesh off its origin, and
//!    `apply_inverse_rotation_point_f64` early-returns on the all-zero point
//!    every single time. Replacing that function's body with an immediate
//!    `return` — deleting the origin rotation the module's own comment calls
//!    load-bearing ("otherwise the element would be rotated about the wrong
//!    centre") — left the entire suite green.
//! 2. **The only site rotation exercised is a yaw about Z.** A yaw leaves
//!    `r02 = r12 = r20 = r21 = 0` and `r22 = 1`, so the four z-coupled matrix
//!    entries are all zero and the transpose that distinguishes `R` from `Rᵀ`
//!    is unobservable on them. Swapping `column_major_matrix[2]` with
//!    `column_major_matrix[8]` — reading the z-coupled terms off the wrong
//!    side of the diagonal — also left the entire suite green.
//!
//! Each test here builds its expectation from the OTHER direction: a chosen
//! site-local point is rotated FORWARD by a hand-composed `R` to make the
//! input, and the conversion must give the chosen point back. Nothing here
//! reuses the production indexing, so a mutation to it cannot be mirrored
//! into the expectation.

use ifc_lite_processing::{convert_mesh_to_site_local, MeshData};

/// Column-major 4x4 from a 3x3 given row-wise, plus a translation.
/// `r[i][j]` is row `i`, column `j`; column-major storage puts (row r, col c)
/// at index `c * 4 + r`.
fn column_major(r: [[f64; 3]; 3], t: [f64; 3]) -> Vec<f64> {
    let mut m = vec![0.0f64; 16];
    for (c, col) in m.chunks_exact_mut(4).enumerate().take(3) {
        for (row, cell) in col.iter_mut().enumerate().take(3) {
            *cell = r[row][c];
        }
    }
    m[12] = t[0];
    m[13] = t[1];
    m[14] = t[2];
    m[15] = 1.0;
    m
}

/// Multiply two row-major 3x3s.
fn mul3(a: [[f64; 3]; 3], b: [[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut out = [[0.0f64; 3]; 3];
    for (i, row) in out.iter_mut().enumerate() {
        for (j, cell) in row.iter_mut().enumerate() {
            *cell = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    out
}

fn rot_z(deg: f64) -> [[f64; 3]; 3] {
    let (s, c) = deg.to_radians().sin_cos();
    [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]]
}

fn rot_x(deg: f64) -> [[f64; 3]; 3] {
    let (s, c) = deg.to_radians().sin_cos();
    [[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]]
}

/// Apply a row-major 3x3 to a point.
fn apply(r: [[f64; 3]; 3], p: [f64; 3]) -> [f64; 3] {
    [
        r[0][0] * p[0] + r[0][1] * p[1] + r[0][2] * p[2],
        r[1][0] * p[0] + r[1][1] * p[1] + r[1][2] * p[2],
        r[2][0] * p[0] + r[2][1] * p[1] + r[2][2] * p[2],
    ]
}

/// The site-local points this file wants back out of the conversion.
/// Deliberately asymmetric: no two components equal, none zero, and the set
/// is not closed under any axis swap or sign flip.
const WANT: [[f64; 3]; 3] = [[1.5, -2.25, 3.75], [-4.5, 6.25, -0.5], [8.0, 0.75, -5.5]];

/// A per-mesh origin far from zero and from the site translation, so the
/// "world point = origin + position" split is genuinely loaded on both halves.
const ORIGIN: [f64; 3] = [123.5, -47.25, 61.75];

/// Build the mesh whose world points (`origin + position`) are `WANT`
/// forward-rotated by `r`, with `origin` itself carrying `ORIGIN` rotated the
/// same way. Positions are then whatever is left over — that is exactly the
/// invariant the conversion has to preserve.
fn mesh_in_world(r: [[f64; 3]; 3]) -> MeshData {
    let rotated_origin = apply(r, ORIGIN);
    let mut positions = Vec::new();
    let mut normals = Vec::new();
    for want in WANT {
        let world = apply(r, want);
        positions.push((world[0] - rotated_origin[0]) as f32);
        positions.push((world[1] - rotated_origin[1]) as f32);
        positions.push((world[2] - rotated_origin[2]) as f32);
        // A distinct unit normal per vertex, likewise forward-rotated.
        let n = apply(r, unit(want));
        normals.push(n[0] as f32);
        normals.push(n[1] as f32);
        normals.push(n[2] as f32);
    }
    MeshData::new(
        1,
        "IfcWall".to_string(),
        positions,
        normals,
        vec![0, 1, 2],
        [1.0, 1.0, 1.0, 1.0],
    )
    .with_origin(rotated_origin)
}

fn unit(p: [f64; 3]) -> [f64; 3] {
    let l = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
    [p[0] / l, p[1] / l, p[2] / l]
}

fn assert_close(got: [f64; 3], want: [f64; 3], eps: f64, what: &str) {
    for i in 0..3 {
        assert!(
            (got[i] - want[i]).abs() < eps,
            "{what}: axis {i} got {} want {} (full got {got:?}, want {want:?})",
            got[i],
            want[i]
        );
    }
}

/// Check that every world point (`origin + position`) of the converted mesh is
/// back at its chosen site-local value, and every normal back at its own.
fn assert_recovers_want(mesh: &MeshData, what: &str) {
    assert_eq!(mesh.positions.len(), WANT.len() * 3, "{what}: vertex count");
    for (i, want) in WANT.iter().enumerate() {
        let p = &mesh.positions[i * 3..i * 3 + 3];
        let world = [
            p[0] as f64 + mesh.origin[0],
            p[1] as f64 + mesh.origin[1],
            p[2] as f64 + mesh.origin[2],
        ];
        // f32 storage at coordinate magnitude ~130 (the origin) costs ~1e-5.
        assert_close(world, *want, 2e-4, &format!("{what}: vertex {i}"));

        let n = &mesh.normals[i * 3..i * 3 + 3];
        assert_close(
            [n[0] as f64, n[1] as f64, n[2] as f64],
            unit(*want),
            1e-5,
            &format!("{what}: normal {i}"),
        );
    }
}

/// A yaw about Z with a NON-ZERO per-mesh origin. `site_rotation.rs` covers
/// the yaw, but only ever with `origin == [0, 0, 0]`; this is the case that
/// separates "rotate the vertices" from "rotate the element about the site
/// origin".
#[test]
fn a_non_zero_mesh_origin_is_inverse_rotated_with_the_positions() {
    let r = rot_z(30.0);
    let site = column_major(r, [10.0, 20.0, 4.5]);
    let mut mesh = mesh_in_world(r);

    // The fixture must not be vacuous: the mesh really is off-origin, and its
    // origin really is rotated away from ORIGIN.
    assert_ne!(mesh.origin, [0.0, 0.0, 0.0], "origin must be non-zero");
    assert_ne!(mesh.origin, ORIGIN, "origin must start rotated");

    convert_mesh_to_site_local(&mut mesh, Some(&site));

    assert_close(mesh.origin, ORIGIN, 1e-9, "origin returns to the site-local frame");
    assert_recovers_want(&mesh, "yaw with non-zero origin");
}

/// An out-of-plane site rotation, so all nine 3x3 entries are non-zero and
/// pairwise distinct. A yaw-only fixture zeroes `r02`, `r12`, `r20`, `r21`
/// and pins `r22 = 1`, which makes the transpose in the inverse rotation
/// unobservable on the z-coupled half of the matrix.
#[test]
fn an_out_of_plane_site_rotation_exercises_the_z_coupled_matrix_entries() {
    // ZXZ Euler angles: a single Rz·Rx leaves r[2][0] exactly zero, which is
    // one of the very entries this test exists to load. Three factors put
    // every entry genuinely off zero and pairwise apart (asserted below).
    let r = mul3(mul3(rot_z(25.0), rot_x(45.0)), rot_z(50.0));

    // Guard the premise. A yaw-only matrix has four zero entries and a 1 on
    // the diagonal, which is exactly why reading a z-coupled term off the
    // wrong side of the diagonal is invisible there. Here every entry must be
    // off zero AND no two may share a magnitude, so ANY index swap between
    // them changes the result by far more than the tolerances below.
    let flat: Vec<f64> = r.iter().flatten().copied().collect();
    for (k, v) in flat.iter().enumerate() {
        assert!(
            v.abs() > 0.05,
            "r[{}][{}] = {v} is too close to zero to distinguish a transpose",
            k / 3,
            k % 3
        );
    }
    for a in 0..flat.len() {
        for b in (a + 1)..flat.len() {
            assert!(
                (flat[a].abs() - flat[b].abs()).abs() > 0.05,
                "entries {a} and {b} share a magnitude ({}, {}) -- swapping them would be invisible",
                flat[a],
                flat[b]
            );
        }
    }

    let site = column_major(r, [-500.0, 250.0, 12.5]);
    let mut mesh = mesh_in_world(r);
    convert_mesh_to_site_local(&mut mesh, Some(&site));

    assert_close(mesh.origin, ORIGIN, 1e-9, "origin returns to the site-local frame");
    assert_recovers_want(&mesh, "yaw + pitch");
}

/// No site transform at all: the mesh must come through untouched, including
/// its origin. Guards the `None` arm against a mutation that rotates anyway.
#[test]
fn no_site_transform_leaves_the_mesh_alone() {
    let r = rot_z(30.0);
    let before = mesh_in_world(r);
    let mut mesh = mesh_in_world(r);
    convert_mesh_to_site_local(&mut mesh, None);
    assert_eq!(mesh.positions, before.positions);
    assert_eq!(mesh.normals, before.normals);
    assert_eq!(mesh.origin, before.origin);
}

/// An identity rotation with a non-zero translation: the rotation arm
/// fast-outs, and the origin must NOT be shifted by the translation — that
/// is the RTC subtraction's job, upstream. A mutation that folded the
/// translation column in here would move every mesh twice.
#[test]
fn an_identity_rotation_with_a_translation_does_not_move_the_origin() {
    let identity = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let site = column_major(identity, [10.0, 20.0, 4.5]);
    let before = mesh_in_world(identity);
    let mut mesh = mesh_in_world(identity);
    convert_mesh_to_site_local(&mut mesh, Some(&site));
    assert_eq!(mesh.origin, before.origin, "translation is handled upstream, not here");
    assert_eq!(mesh.positions, before.positions);
    assert_eq!(mesh.normals, before.normals);
}
