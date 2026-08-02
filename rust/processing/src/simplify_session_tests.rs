// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `simplify_session` unit tests, split into this sibling `_tests.rs` file
//! (declared from `lib.rs`) to keep `simplify_session.rs` inside its
//! `module_size_ratchet` budget; `_tests.rs` files are exempt from that
//! ratchet (see `module_size_ratchet.rs`'s `is_exempt`).

use crate::simplify_math::zup_to_yup;
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
fn yup_frame_round_trips_and_restores_winding() {
    // Same box as the identity test, but presented the way the wasm
    // boundary hands meshes to JS: positions/origin swapped to Y-up,
    // winding reversed, matrix conjugated.
    let (positions_z, _, indices_z) = box_soup([0.0, 0.0, 0.0], [2.0, 3.0, 4.0]);
    let mut positions_y = Vec::with_capacity(positions_z.len());
    for c in positions_z.chunks_exact(3) {
        let p = zup_to_yup([c[0] as f64, c[1] as f64, c[2] as f64]);
        positions_y.extend_from_slice(&[p[0] as f32, p[1] as f32, p[2] as f32]);
    }
    let mut indices_y = indices_z.clone();
    for tri in indices_y.chunks_exact_mut(3) {
        tri.swap(1, 2);
    }
    let normals_y = vec![0.0; positions_y.len()];
    let rec = SimplifyRecordInput {
        positions: &positions_y,
        normals: &normals_y,
        indices: &indices_y,
        origin: [0.0; 3],
        // Identity conjugates to identity.
        local_to_world: Some(IDENTITY),
    };
    let out = simplify_element(&[rec], 5, [0.0; 3], 1.0, true).unwrap();

    // IFC-local output must be back in Z-up: extents match the Z-up box.
    let (mut lmin, mut lmax) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for c in out.local_positions.chunks_exact(3) {
        for k in 0..3 {
            lmin[k] = lmin[k].min(c[k]);
            lmax[k] = lmax[k].max(c[k]);
        }
    }
    assert!((lmax[0] - 2.0).abs() < 1e-6);
    assert!((lmax[1] - 3.0).abs() < 1e-6);
    assert!((lmax[2] - 4.0).abs() < 1e-6);

    // Render output stays in the caller's Y-up frame: the Z-up box
    // [0,2]x[0,3]x[0,4] swaps to x[0,2], y[0,4], z[-3,0]; positions are
    // relative to render_origin, so reconstruct world = origin + p.
    let (mut rmin, mut rmax) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for c in out.render_positions.chunks_exact(3) {
        for k in 0..3 {
            let w = c[k] as f64 + out.render_origin[k];
            rmin[k] = rmin[k].min(w);
            rmax[k] = rmax[k].max(w);
        }
    }
    assert!((rmax[0] - 2.0).abs() < 1e-5);
    assert!((rmax[1] - 4.0).abs() < 1e-5);
    assert!((rmin[2] - -3.0).abs() < 1e-5);
    assert!(rmax[2].abs() < 1e-5);
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
