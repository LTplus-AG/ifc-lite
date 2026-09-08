// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `simplify_session` unit tests, split into this sibling `_tests.rs` file
//! (declared from `lib.rs`) to keep `simplify_session.rs` inside its
//! `module_size_ratchet` budget; `_tests.rs` files are exempt from that
//! ratchet (see `module_size_ratchet.rs`'s `is_exempt`).

use crate::simplify_math::{
    conjugate_yup_to_zup, invert_affine_row_major, matmul_row_major, zup_to_yup,
};
use crate::simplify_session::*;

/// Indexed 12-tri box between min/max, IFC Z-up frame, zero normals.
/// Plain indexed box (8 corners, 12 tris) — clustering/cavity behaviour is
/// covered in the geometry crate's own tests; here only the frame math
/// matters.
fn box_soup(min: [f32; 3], max: [f32; 3]) -> (Vec<f32>, Vec<f32>, Vec<u32>) {
    let (x0, y0, z0) = (min[0], min[1], min[2]);
    let (x1, y1, z1) = (max[0], max[1], max[2]);
    let positions = vec![
        x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, // bottom ring
        x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, // top ring
    ];
    let normals = vec![0.0; positions.len()];
    let indices = vec![
        0, 2, 1, 0, 3, 2, // bottom
        4, 5, 6, 4, 6, 7, // top
        0, 1, 5, 0, 5, 4, // front
        2, 3, 7, 2, 7, 6, // back
        3, 0, 4, 3, 4, 7, // left
        1, 2, 6, 1, 6, 5, // right
    ];
    (positions, normals, indices)
}

const IDENTITY: [f64; 16] = [
    1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
];

#[test]
fn identity_placement_round_trips_local_positions() {
    let (positions, normals, indices) = box_soup([0.0, 0.0, 0.0], [2.0, 3.0, 4.0]);
    let rec = SimplifyRecordInput {
        positions: &positions,
        normals: &normals,
        indices: &indices,
        origin: [0.0; 3],
        local_to_world: Some(IDENTITY),
    };
    // Level 5 (boxify) gives a deterministic 12-tri result.
    let out = simplify_element(&[rec], 5, [0.0; 3], 1.0, false).unwrap();
    assert_eq!(out.render_indices.len() / 3, 12);
    assert_eq!(out.local_positions.len(), out.render_positions.len());
    // Identity placement + unit scale: local == world AABB corners.
    let (mut lmin, mut lmax) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for c in out.local_positions.chunks_exact(3) {
        for k in 0..3 {
            lmin[k] = lmin[k].min(c[k]);
            lmax[k] = lmax[k].max(c[k]);
        }
    }
    for (k, v) in lmin.iter().enumerate() {
        assert!(v.abs() < 1e-6, "min axis {k}: {v}");
    }
    assert!((lmax[0] - 2.0).abs() < 1e-6);
    assert!((lmax[1] - 3.0).abs() < 1e-6);
    assert!((lmax[2] - 4.0).abs() < 1e-6);
}

#[test]
fn placement_translation_rtc_and_units_are_inverted() {
    // Element placed at (10, 20, 30) m, model RTC shift (1000, 0, 0) m,
    // file units mm (unit_scale 0.001). The viewer-held positions are in
    // the RTC-SHIFTED world: true_world - rtc.
    let l2w = [
        1.0, 0.0, 0.0, 10.0, 0.0, 1.0, 0.0, 20.0, 0.0, 0.0, 1.0, 30.0, 0.0, 0.0, 0.0, 1.0,
    ];
    let rtc = [1000.0, 0.0, 0.0];
    // Object-space box [0,1]m => true world [10..11, 20..21, 30..31],
    // shifted world [-990..-989, 20..21, 30..31].
    let (positions, normals, indices) = box_soup([-990.0, 20.0, 30.0], [-989.0, 21.0, 31.0]);
    let rec = SimplifyRecordInput {
        positions: &positions,
        normals: &normals,
        indices: &indices,
        origin: [0.0; 3],
        local_to_world: Some(l2w),
    };
    let out = simplify_element(&[rec], 5, rtc, 0.001, false).unwrap();
    // Expect object-space box [0..1]m = [0..1000] file mm.
    let (mut lmin, mut lmax) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for c in out.local_positions.chunks_exact(3) {
        for k in 0..3 {
            lmin[k] = lmin[k].min(c[k]);
            lmax[k] = lmax[k].max(c[k]);
        }
    }
    for k in 0..3 {
        assert!(lmin[k].abs() < 1e-3, "min axis {k}: {}", lmin[k]);
        assert!((lmax[k] - 1000.0).abs() < 1e-3, "max axis {k}: {}", lmax[k]);
    }
}

#[test]
fn yup_frame_round_trips_with_preserved_winding() {
    // Same box as the identity test, but presented the way the wasm
    // boundary hands meshes to JS: positions/origin swapped to Y-up,
    // winding preserved, matrix conjugated.
    let (positions_z, _, indices_z) = box_soup([0.0, 0.0, 0.0], [2.0, 3.0, 4.0]);
    let mut positions_y = Vec::with_capacity(positions_z.len());
    for c in positions_z.chunks_exact(3) {
        let p = zup_to_yup([c[0] as f64, c[1] as f64, c[2] as f64]);
        positions_y.extend_from_slice(&[p[0] as f32, p[1] as f32, p[2] as f32]);
    }
    let indices_y = indices_z.clone();
    let normals_y = vec![0.0; positions_y.len()];
    // A non-zero per-mesh origin with three distinct components, so the
    // `yup_to_zup(rec.origin)` swap is observable: with `origin: [0; 3]`
    // (or any origin whose components coincide) dropping the swap moves
    // nothing, and `let origin = rec.origin;` passes unnoticed.
    let origin_z = [1.0, 2.0, 3.0];
    let origin_y = zup_to_yup(origin_z);
    let rec = SimplifyRecordInput {
        positions: &positions_y,
        normals: &normals_y,
        indices: &indices_y,
        origin: origin_y,
        // Identity conjugates to identity.
        local_to_world: Some(IDENTITY),
    };
    let out = simplify_element(&[rec], 5, [0.0; 3], 1.0, true).unwrap();

    // IFC-local output must be back in Z-up: the Z-up box [0,2]x[0,3]x[0,4]
    // offset by the Z-up origin (1,2,3) => [1,3]x[2,5]x[3,7]. Skipping the
    // origin swap would place it at [1,3]x[3,6]x[2,6] instead.
    let (mut lmin, mut lmax) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for c in out.local_positions.chunks_exact(3) {
        for k in 0..3 {
            lmin[k] = lmin[k].min(c[k]);
            lmax[k] = lmax[k].max(c[k]);
        }
    }
    let expect_lmin = [1.0, 2.0, 3.0];
    let expect_lmax = [3.0, 5.0, 7.0];
    for k in 0..3 {
        assert!(
            (lmin[k] - expect_lmin[k]).abs() < 1e-6,
            "local min axis {k}: {} != {}",
            lmin[k],
            expect_lmin[k]
        );
        assert!(
            (lmax[k] - expect_lmax[k]).abs() < 1e-6,
            "local max axis {k}: {} != {}",
            lmax[k],
            expect_lmax[k]
        );
    }

    // Render output stays in the caller's Y-up frame: the Z-up world box
    // [1,3]x[2,5]x[3,7] swaps to x[1,3], y[3,7], z[-5,-2]; positions are
    // relative to render_origin, so reconstruct world = origin + p.
    let (mut rmin, mut rmax) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for c in out.render_positions.chunks_exact(3) {
        for k in 0..3 {
            let w = c[k] as f64 + out.render_origin[k];
            rmin[k] = rmin[k].min(w);
            rmax[k] = rmax[k].max(w);
        }
    }
    let expect_rmin = [1.0, 3.0, -5.0];
    let expect_rmax = [3.0, 7.0, -2.0];
    for k in 0..3 {
        assert!(
            (rmin[k] - expect_rmin[k]).abs() < 1e-5,
            "render min axis {k}: {} != {}",
            rmin[k],
            expect_rmin[k]
        );
        assert!(
            (rmax[k] - expect_rmax[k]).abs() < 1e-5,
            "render max axis {k}: {} != {}",
            rmax[k],
            expect_rmax[k]
        );
    }
}

#[test]
fn conjugate_yup_to_zup_recovers_a_non_identity_matrix() {
    // `yup_frame_round_trips_with_preserved_winding` only exercises
    // `conjugate_yup_to_zup` through the identity matrix, where
    // `S * I * S^T == S^T * I * S == I` for any orthogonal `S` — so a
    // mutation swapping the multiplication order (`S * M' * S^T` instead
    // of the documented `S^T * M' * S`) is invisible there. Pin it with a
    // translation whose x/y/z are distinct, so the two orders diverge.
    let m = [
        1.0, 0.0, 0.0, 10.0, 0.0, 1.0, 0.0, 20.0, 0.0, 0.0, 1.0, 30.0, 0.0, 0.0, 0.0, 1.0,
    ];
    // Forward boundary conjugation `M' = S * M * S^T`
    // (`zero_copy::mesh::swap_zup_to_yup_mat4`'s convention), built from
    // the same S/S^T this module documents in `conjugate_yup_to_zup`.
    #[rustfmt::skip]
    let s: [f64; 16] = [
        1.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        0.0, -1.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ];
    #[rustfmt::skip]
    let st: [f64; 16] = [
        1.0, 0.0, 0.0, 0.0,
        0.0, 0.0, -1.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ];
    let m_prime = matmul_row_major(&matmul_row_major(&s, &m), &st);
    let recovered = conjugate_yup_to_zup(&m_prime);
    for (i, (a, b)) in recovered.iter().zip(m.iter()).enumerate() {
        assert!((a - b).abs() < 1e-9, "index {i}: {recovered:?} != {m:?}");
    }
}

#[test]
fn invert_affine_row_major_inverts_a_rotated_placement() {
    // Every existing `local_to_world` fixture in this file uses an identity
    // (diagonal) linear block, so the cofactor cross terms in
    // `invert_affine_row_major`'s determinant (e.g. `a[3] * a[7] - a[4] *
    // a[6]`) are always `0 * 0`, and a sign flip there is invisible —
    // worse, even a pure axis-aligned 90-degree rotation keeps one row a
    // unit vector and re-zeroes the same cross term. Use a fully generic
    // invertible linear block (every entry nonzero and distinct) so the
    // determinant's cofactor expansion is actually exercised, and check
    // the round trip `M * M^-1 == I` directly rather than re-deriving the
    // expected inverse by hand.
    #[rustfmt::skip]
    let m: [f64; 16] = [
        2.0, 1.0, 3.0, 5.0,
        4.0, 5.0, 1.0, 7.0,
        2.0, 3.0, 6.0, 9.0,
        0.0, 0.0, 0.0, 1.0,
    ];
    let inv = invert_affine_row_major(&m).expect("rotation matrix is non-singular");
    let round_trip = matmul_row_major(&m, &inv);
    #[rustfmt::skip]
    let identity: [f64; 16] = [
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ];
    for (i, (a, b)) in round_trip.iter().zip(identity.iter()).enumerate() {
        assert!((a - b).abs() < 1e-9, "index {i}: {round_trip:?} != identity");
    }
}

#[test]
fn invalid_unit_scale_is_skipped() {
    let (positions, normals, indices) = box_soup([0.0; 3], [1.0; 3]);
    for bad_scale in [0.0, -0.001, f64::NAN, f64::INFINITY] {
        let rec = SimplifyRecordInput {
            positions: &positions,
            normals: &normals,
            indices: &indices,
            origin: [0.0; 3],
            local_to_world: Some(IDENTITY),
        };
        assert_eq!(
            simplify_element(&[rec], 5, [0.0; 3], bad_scale, false).unwrap_err(),
            SimplifySkip::InvalidUnitScale,
            "unit_scale {bad_scale} must skip, not silently become metres"
        );
    }
}

#[test]
fn missing_placement_is_skipped() {
    let (positions, normals, indices) = box_soup([0.0; 3], [1.0; 3]);
    let rec = SimplifyRecordInput {
        positions: &positions,
        normals: &normals,
        indices: &indices,
        origin: [0.0; 3],
        local_to_world: None,
    };
    assert_eq!(
        simplify_element(&[rec], 1, [0.0; 3], 1.0, false).unwrap_err(),
        SimplifySkip::MissingPlacement
    );
}

#[test]
fn multiple_records_merge_with_distinct_origins() {
    // Two submeshes of one element, stored with different per-mesh
    // origins but describing adjacent world boxes.
    let (p1, n1, i1) = box_soup([0.0; 3], [1.0, 1.0, 1.0]);
    let (p2, n2, i2) = box_soup([0.0; 3], [1.0, 1.0, 1.0]);
    let recs = [
        SimplifyRecordInput {
            positions: &p1,
            normals: &n1,
            indices: &i1,
            origin: [0.0, 0.0, 0.0],
            local_to_world: Some(IDENTITY),
        },
        SimplifyRecordInput {
            positions: &p2,
            normals: &n2,
            indices: &i2,
            origin: [5.0, 0.0, 0.0], // world box [5..6]
            local_to_world: Some(IDENTITY),
        },
    ];
    let out = simplify_element(&recs, 5, [0.0; 3], 1.0, false).unwrap();
    let (mut lmin, mut lmax) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for c in out.local_positions.chunks_exact(3) {
        for k in 0..3 {
            lmin[k] = lmin[k].min(c[k]);
            lmax[k] = lmax[k].max(c[k]);
        }
    }
    assert!(lmin[0].abs() < 1e-6);
    assert!(
        (lmax[0] - 6.0).abs() < 1e-6,
        "merged AABB spans both submeshes"
    );
}

/// #4056: exercise actual clustering and box replacement, not merely an
/// untouched low-triangle mesh. A frame rotation must not change IFC-local
/// triangles, and both render winding and recomputed normals remain outward.
#[test]
fn issue_4056_simplify_cluster_and_box_preserve_winding_in_both_frames() {
    let (corners, _, triangles) = box_soup([-1.0; 3], [1.0; 3]);
    let mut facets: Vec<[[f32; 3]; 3]> = triangles.chunks_exact(3).map(|tri| {
        std::array::from_fn(|i| std::array::from_fn(|k| corners[tri[i] as usize * 3 + k]))
    }).collect();
    // Midpoint subdivision preserves each face's outward winding exactly.
    for _ in 0..3 {
        facets = facets.into_iter().flat_map(|[a, b, c]| {
            let ab = std::array::from_fn(|k| (a[k] + b[k]) * 0.5);
            let bc = std::array::from_fn(|k| (b[k] + c[k]) * 0.5);
            let ca = std::array::from_fn(|k| (c[k] + a[k]) * 0.5);
            [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]]
        }).collect();
    }
    let positions_z: Vec<f32> = facets.into_iter().flatten().flatten().collect();
    let indices: Vec<u32> = (0..positions_z.len() as u32 / 3).collect();
    let positions_y: Vec<f32> = positions_z.chunks_exact(3)
        .flat_map(|p| [p[0], p[2], -p[1]]).collect();
    for level in [1, 4, 5] {
        let make = |positions| SimplifyRecordInput {
            positions, normals: &[], indices: &indices,
            origin: [0.0; 3], local_to_world: Some(IDENTITY),
        };
        let z = simplify_element(&[make(&positions_z)], level, [0.0; 3], 1.0, false).unwrap();
        let y = simplify_element(&[make(&positions_y)], level, [0.0; 3], 1.0, true).unwrap();
        assert!(z.tris_after < z.tris_before, "level {level} must actually simplify");
        assert_eq!(y.local_positions, z.local_positions, "level {level}: IFC-local frame");
        assert_eq!(y.local_indices, z.local_indices, "level {level}: exported IFC winding");
        assert_eq!(y.render_indices, z.render_indices, "level {level}: proper rotation preserves winding");
        assert_eq!(y.local_indices, y.render_indices);
        assert_outward_faces(&y.render_positions, &y.render_normals, &y.render_indices);
        // Identity placement: local positions form the same closed outward
        // shell. Positive signed volume detects reversed IFC export winding.
        let volume6: f64 = y.local_indices.chunks_exact(3).map(|t| {
            let p = |i: u32| &y.local_positions[i as usize * 3..i as usize * 3 + 3];
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            a[0] * (b[1] * c[2] - b[2] * c[1])
                + a[1] * (b[2] * c[0] - b[0] * c[2])
                + a[2] * (b[0] * c[1] - b[1] * c[0])
        }).sum();
        assert!(volume6 > 0.0, "level {level}: IFC-local shell must face outward");
    }
}

fn assert_outward_faces(positions: &[f32], normals: &[f32], indices: &[u32]) {
    let mut checked = 0;
    for tri in indices.chunks_exact(3) {
        let p = |i: u32| &positions[i as usize * 3..i as usize * 3 + 3];
        let (a, b, c) = (p(tri[0]), p(tri[1]), p(tri[2]));
        let u: [f32; 3] = std::array::from_fn(|k| b[k] - a[k]);
        let v: [f32; 3] = std::array::from_fn(|k| c[k] - a[k]);
        let cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        if cross.iter().all(|x| *x == 0.0) { continue; }
        let dot: f32 = (0..3).map(|k| cross[k] * (a[k] + b[k] + c[k])).sum();
        assert!(dot > 0.0, "render face must point away from the centred box");
        let normal_dot: f32 = (0..3).map(|k| cross[k] * tri.iter()
            .map(|i| normals[*i as usize * 3 + k]).sum::<f32>()).sum();
        assert!(normal_dot > 0.0, "face winding must agree with recomputed normals");
        checked += 1;
    }
    assert!(checked >= 12, "non-vacuous closed-shell orientation witness");
}
