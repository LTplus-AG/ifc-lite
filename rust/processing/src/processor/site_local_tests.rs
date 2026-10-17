// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for [`super`], split out to keep `site_local.rs` under the module-size
//! ratchet. Included with `#[path]`, the house pattern for a module whose bulk
//! is `#[cfg(test)]` (see the export crate's `gltf/matrix_tests.rs`).

use super::*;

/// Column-major 4x4 identity with an arbitrary non-zero translation:
/// exactly the matrix a translation-only `IfcSite` placement resolves to.
fn translation_only_matrix(t: (f64, f64, f64)) -> Vec<f64> {
    #[rustfmt::skip]
    let m = vec![
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        t.0, t.1, t.2, 1.0,
    ];
    m
}

/// Column-major 4x4 with a 30 degree yaw about Z (matches
/// `site_rotation.rs`'s `ROTATED_SITE_PLACEMENT` fixture) plus a translation.
fn yawed_matrix(t: (f64, f64, f64)) -> Vec<f64> {
    let c = 30f64.to_radians().cos();
    let s = 30f64.to_radians().sin();
    #[rustfmt::skip]
    let m = vec![
        c,    s,   0.0, 0.0,
        -s,   c,   0.0, 0.0,
        0.0,  0.0, 1.0, 0.0,
        t.0, t.1, t.2, 1.0,
    ];
    m
}

#[test]
fn identity_matrix_is_identity() {
    assert!(rotation_is_identity(&translation_only_matrix((0.0, 0.0, 0.0))));
}

/// #4118: a pure-translation `IfcSite` placement (the common case for a
/// model imported with a site offset but no yaw) must classify as an
/// identity rotation — this is the condition under which
/// `apply_inverse_rotation_in_place` already no-ops on positions/normals,
/// so metadata captured before it runs is never invalidated.
#[test]
fn translation_only_matrix_is_identity_rotation() {
    assert!(rotation_is_identity(&translation_only_matrix((10.0, 20.0, 0.0))));
    assert!(rotation_is_identity(&translation_only_matrix((-500.5, 12345.6, 7.0))));
}

#[test]
fn yawed_matrix_is_not_identity_rotation() {
    assert!(!rotation_is_identity(&yawed_matrix((10.0, 20.0, 0.0))));
    // Even a yaw with zero translation must not be classified as identity.
    assert!(!rotation_is_identity(&yawed_matrix((0.0, 0.0, 0.0))));
}

/// #4118 step 1: [`native_to_baked`] is a SECOND implementation of what
/// [`convert_mesh_to_site_local`] (plus the router's RTC subtraction) does
/// to a vertex. Nothing else stops the two drifting apart, and a basis that
/// describes a bake the baker did not perform is exactly the failure mode
/// that makes the collator reject every group while every other test stays
/// green. Run both over one 30 degree fixture and compare per vertex.
#[test]
fn native_to_baked_matches_convert_mesh_to_site_local_per_vertex() {
    let rtc = [1_200.0_f64, -340.0, 12.5];
    let site = yawed_matrix((rtc[0], rtc[1], rtc[2]));

    // Native (pre-RTC, Z-up) world points, as the router would have them
    // before it subtracts the RTC offset.
    let native: Vec<[f64; 3]> = vec![
        [1_207.0, -333.5, 15.0],
        [1_199.25, -341.0, 12.5],
        [1_215.5, -300.0, 30.25],
    ];
    // What the router hands the converter: origin + relative f32 positions,
    // already RTC-subtracted.
    let origin = [
        native[0][0] - rtc[0],
        native[0][1] - rtc[1],
        native[0][2] - rtc[2],
    ];
    let mut positions: Vec<f32> = Vec::new();
    for p in &native {
        positions.push((p[0] - rtc[0] - origin[0]) as f32);
        positions.push((p[1] - rtc[1] - origin[1]) as f32);
        positions.push((p[2] - rtc[2] - origin[2]) as f32);
    }
    let mut mesh = MeshData::new(1, "IfcWall".to_string(), positions, vec![], vec![], [0.0; 4]);
    mesh.origin = origin;
    convert_mesh_to_site_local(&mut mesh, Some(&site));

    let b = native_to_baked(
        MeshCoordinateSpace::SiteLocal,
        Some(&site),
        [rtc[0], rtc[1], rtc[2]],
    );
    for (v, p) in native.iter().enumerate() {
        let want = [
            b[0] * p[0] + b[1] * p[1] + b[2] * p[2] + b[3],
            b[4] * p[0] + b[5] * p[1] + b[6] * p[2] + b[7],
            b[8] * p[0] + b[9] * p[1] + b[10] * p[2] + b[11],
        ];
        let got = [
            mesh.origin[0] + mesh.positions[v * 3] as f64,
            mesh.origin[1] + mesh.positions[v * 3 + 1] as f64,
            mesh.origin[2] + mesh.positions[v * 3 + 2] as f64,
        ];
        for k in 0..3 {
            assert!(
                (want[k] - got[k]).abs() < 1e-4,
                "vertex {v} axis {k}: native_to_baked says {} but \
                 convert_mesh_to_site_local produced {} (delta {})",
                want[k],
                got[k],
                want[k] - got[k],
            );
        }
    }
}

/// The two tiers that remove no rotation must come back as the pure
/// translation the router applied — not as the site rotation, which would
/// silently rotate the basis for a model whose vertices were never rotated.
#[test]
fn non_site_local_tiers_carry_only_the_rtc_translation() {
    let site = yawed_matrix((7.0, 8.0, 9.0));
    for space in [
        MeshCoordinateSpace::ModelRtc,
        MeshCoordinateSpace::RawIfc,
    ] {
        let b = native_to_baked(space, Some(&site), [7.0, 8.0, 9.0]);
        #[rustfmt::skip]
        let want = [
            1.0, 0.0, 0.0, -7.0,
            0.0, 1.0, 0.0, -8.0,
            0.0, 0.0, 1.0, -9.0,
            0.0, 0.0, 0.0, 1.0,
        ];
        assert_eq!(b, want, "{space:?} must not pick up the site rotation");
    }
    // A translation-only site placement is `site_local` but rotates nothing
    // (#4176), so its basis is a pure translation too.
    let b = native_to_baked(
        MeshCoordinateSpace::SiteLocal,
        Some(&translation_only_matrix((7.0, 8.0, 9.0))),
        [7.0, 8.0, 9.0],
    );
    assert_eq!(&b[0..3], &[1.0, 0.0, 0.0]);
    assert_eq!(b[3], -7.0);
}

#[test]
fn short_matrix_is_conservatively_not_identity() {
    assert!(!rotation_is_identity(&[1.0, 0.0, 0.0]));
    assert!(!rotation_is_identity(&[]));
}

/// #4118 follow-up: `apply_inverse_rotation_point_f64` must treat the SAME
/// matrix as `rotation_is_identity` does. A near-identity matrix (a yaw far
/// below [`PLACEMENT_IDENTITY_EPSILON`]) is classified as identity by
/// `rotation_is_identity`, so `apply_inverse_rotation_in_place` already
/// no-ops on positions/normals for it — `mesh.origin` must no-op too, or a
/// captured local-to-world transform (valid under the identity
/// classification) goes stale relative to the origin `convert_mesh_to_site_local`
/// actually wrote.
#[test]
fn near_identity_matrix_does_not_perturb_origin() {
    let yaw = 1e-10_f64;
    let c = yaw.cos();
    let s = yaw.sin();
    #[rustfmt::skip]
    let m = vec![
        c,    s,   0.0, 0.0,
        -s,   c,   0.0, 0.0,
        0.0,  0.0, 1.0, 0.0,
        0.0,  0.0, 0.0, 1.0,
    ];
    assert!(rotation_is_identity(&m), "fixture must classify as identity");

    let mut origin = [10_000_000.0_f64, 0.0, 0.0];
    apply_inverse_rotation_point_f64(&mut origin, &m);
    assert_eq!(
        origin,
        [10_000_000.0, 0.0, 0.0],
        "an identity-classified rotation must not move the origin at all — \
         it moved by {:?}",
        [origin[0] - 10_000_000.0, origin[1], origin[2]],
    );
}

/// The shared `math::mat4::transform_vector` (#7772) must keep the spelled-out
/// `Rᵀ·v` of the column-major site array, bit for bit, in all three places this
/// module applies it: the baked basis, the f32 vertex rotation and the f64 origin.
#[test]
fn rotation_helpers_equal_the_expanded_transpose_product_bit_for_bit() {
    let site = yawed_matrix((1.0e7 + 0.123, -2.0e6 + 0.456, 31.5));
    let rtc = [1.0e7 + 0.25, -2.0e6 + 0.5, 3.0];
    let (r00, r10, r20) = (site[0], site[1], site[2]);
    let (r01, r11, r21) = (site[4], site[5], site[6]);
    let (r02, r12, r22) = (site[8], site[9], site[10]);
    let expand = |x: f64, y: f64, z: f64| {
        [r00 * x + r10 * y + r20 * z, r01 * x + r11 * y + r21 * z, r02 * x + r12 * y + r22 * z]
    };
    let bits = |v: &[f64]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();

    let b = native_to_baked(MeshCoordinateSpace::SiteLocal, Some(&site), rtc);
    let t = expand(-rtc[0], -rtc[1], -rtc[2]);
    assert_eq!(bits(&[b[3], b[7], b[11]]), bits(&t));
    assert_eq!(bits(&b[0..3]), bits(&[site[0], site[1], site[2]]));

    let mut f32s = vec![1.5f32, -2.25, 3.125, 100.0, 0.1, -7.7];
    let want: Vec<f32> = f32s
        .chunks_exact(3)
        .flat_map(|c| expand(c[0] as f64, c[1] as f64, c[2] as f64).map(|v| v as f32))
        .collect();
    apply_inverse_rotation_in_place(&mut f32s, &site);
    assert_eq!(f32s.iter().map(|v| v.to_bits()).collect::<Vec<_>>(), want.iter().map(|v| v.to_bits()).collect::<Vec<_>>());

    let mut p = [1.0e7 + 0.1, -3.0, 0.7];
    let want = expand(p[0], p[1], p[2]);
    apply_inverse_rotation_point_f64(&mut p, &site);
    assert_eq!(bits(&p), bits(&want));
}
