// SPDX-License-Identifier: MPL-2.0
//! Tests for [`super`], split out to keep the module under the size ratchet.
//!
//! Included by `matrix.rs` with `#[path]`, which is the house pattern for a
//! module whose bulk is `#[cfg(test)]`.
#[test]
fn occurrence_matrix_reconstructs_rotated_instance_under_national_grid_rtc() {
    // A ROTATED occurrence at NATIONAL-GRID coordinates: the node matrix is built
    // from the same InstanceMeta the baker would carry; reconstructing the
    // occurrence from the template's baked-local geometry must land on the
    // occurrence's own baked geometry to sub-millimetre, even though the relative
    // transform's absolute terms are ~1e5 m. (A pre-RTC `rel` applied to post-RTC
    // geometry — the bug — misplaces this by ~(R-I)·rtc, i.e. hundreds of metres.)
    use ifc_lite_geometry::InstanceMeta;

    // Row-major helpers.
    let translate = |t: [f64; 3]| -> [f64; 16] {
        [1., 0., 0., t[0], 0., 1., 0., t[1], 0., 0., 1., t[2], 0., 0., 0., 1.]
    };
    // Rotation about Z (Z-up): (x,y) rotate, z fixed.
    let rot_z = |deg: f64| -> [f64; 16] {
        let (s, c) = (deg.to_radians().sin(), deg.to_radians().cos());
        [c, -s, 0., 0., s, c, 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]
    };
    let apply = |m: &[f64; 16], p: [f64; 3]| -> [f64; 3] {
        [
            m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
            m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
            m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
        ]
    };

    // Placements (Z-up, pre-RTC): template upright, occurrence rotated 37° about Z.
    let m_ref = super::mat4_mul(&translate([10., 20., 5.]), &rot_z(0.0));
    let m_k = super::mat4_mul(&translate([60., 35., 5.]), &rot_z(37.0));
    // National-grid RTC the baker subtracts (e.g. Dutch RD-ish easting/northing).
    let rtc = [155_000.0_f64, 463_000.0, 0.0];

    // Canonical (rep-local) geometry — a few non-degenerate points.
    let canonical = [
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 2.0, 0.0],
        [0.5, 0.5, 1.5],
        [2.0, 0.3, 0.7],
    ];
    // Baked = placement·canonical - rtc, in Z-up.
    let bake = |m: &[f64; 16]| -> Vec<[f64; 3]> {
        canonical
            .iter()
            .map(|&x| {
                let w = apply(m, x);
                [w[0] - rtc[0], w[1] - rtc[1], w[2] - rtc[2]]
            })
            .collect()
    };
    let tmpl_baked = bake(&m_ref);
    let occ_baked = bake(&m_k);

    // Template origin = centroid of its baked geometry; local = baked - origin.
    let n = canonical.len() as f64;
    let origin_z = {
        let mut o = [0.0; 3];
        for p in &tmpl_baked {
            for k in 0..3 {
                o[k] += p[k] / n;
            }
        }
        o
    };
    // Convert template origin + local, and the occurrence's baked truth, to Y-up.
    let origin_yup = crate::frame::yup_f64(origin_z);
    let tmpl_local_yup: Vec<[f64; 3]> = tmpl_baked
        .iter()
        .map(|p| crate::frame::yup_f64([p[0] - origin_z[0], p[1] - origin_z[1], p[2] - origin_z[2]]))
        .collect();
    let occ_world_yup: Vec<[f64; 3]> = occ_baked.iter().map(|p| crate::frame::yup_f64(*p)).collect();

    // scene_center = centre of the combined baked Y-up AABB.
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for p in tmpl_baked.iter().chain(occ_baked.iter()) {
        let y = crate::frame::yup_f64(*p);
        for k in 0..3 {
            lo[k] = lo[k].min(y[k]);
            hi[k] = hi[k].max(y[k]);
        }
    }
    let scene_center = [(lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5, (lo[2] + hi[2]) * 0.5];

    let meta = |transform: [f64; 16]| InstanceMeta {
        transform,
        local_transform: None,
        canonical_transform: None,
        rep_identity: 42,
        instanceable: true,
    };
    let m_ref_inv = super::affine_inverse(&super::compose_world_meta(&meta(m_ref)))
        .expect("template placement invertible");
    let node = super::occurrence_node_matrix(&meta(m_k), &m_ref_inv, rtc, origin_yup, scene_center);

    // Reconstruct: world = scene_center(root) + node(col-major) · template_local.
    let mut max_err = 0.0f64;
    for (lv, truth) in tmpl_local_yup.iter().zip(&occ_world_yup) {
        let (x, y, z) = (lv[0], lv[1], lv[2]);
        let world = [
            scene_center[0] + node[0] as f64 * x + node[4] as f64 * y + node[8] as f64 * z + node[12] as f64,
            scene_center[1] + node[1] as f64 * x + node[5] as f64 * y + node[9] as f64 * z + node[13] as f64,
            scene_center[2] + node[2] as f64 * x + node[6] as f64 * y + node[10] as f64 * z + node[14] as f64,
        ];
        for k in 0..3 {
            max_err = max_err.max((world[k] - truth[k]).abs());
        }
    }
    assert!(
        max_err < 1e-3,
        "rotated instance under national-grid RTC mis-reconstructed by {max_err} m"
    );
}

#[test]
fn affine_inverse_rejects_singular_placement() {
    // Zero scale on X collapses the upper 3x3, so there is no affine inverse and the
    // caller must fall back to the flat (non-instanced) path.
    let m = [
        0.0, 0.0, 0.0, 5.0, //
        0.0, 1.0, 0.0, 0.0, //
        0.0, 0.0, 1.0, 0.0, //
        0.0, 0.0, 0.0, 1.0,
    ];
    assert!(super::affine_inverse(&m).is_none());
}

#[test]
fn compose_world_meta_applies_canonical_then_local_then_transform() {
    use ifc_lite_geometry::InstanceMeta;
    // Non-commuting factors so the ORDER is observable: canonical shifts +x, local
    // rotates 90° about z, transform shifts +x again. A point at the origin must go
    // origin -(canonical)-> (1,0,0) -(local rot)-> (0,1,0) -(transform)-> (10,1,0).
    let rot_z90 = [
        0.0, -1.0, 0.0, 0.0, //
        1.0, 0.0, 0.0, 0.0, //
        0.0, 0.0, 1.0, 0.0, //
        0.0, 0.0, 0.0, 1.0,
    ];
    let translate = |t: [f64; 3]| {
        [
            1.0, 0.0, 0.0, t[0], //
            0.0, 1.0, 0.0, t[1], //
            0.0, 0.0, 1.0, t[2], //
            0.0, 0.0, 0.0, 1.0,
        ]
    };
    let meta = InstanceMeta {
        transform: translate([10.0, 0.0, 0.0]),
        local_transform: Some(rot_z90),
        canonical_transform: Some(translate([1.0, 0.0, 0.0])),
        rep_identity: 1,
        instanceable: true,
    };
    let m = super::compose_world_meta(&meta);
    // Row-major apply to the origin: the translation column is (m[3], m[7], m[11]).
    let world = [m[3], m[7], m[11]];
    let want = [10.0, 1.0, 0.0];
    for k in 0..3 {
        assert!((world[k] - want[k]).abs() < 1e-9, "axis {k}: {} != {}", world[k], want[k]);
    }
}

#[test]
fn zero_rtc_places_non_identity_occurrence() {
    use ifc_lite_geometry::InstanceMeta;
    // With rtc = 0 (the baker subtracted no offset) the conjugation is a no-op, but the
    // node must STILL place a NON-identity occurrence correctly. Reconstructing the
    // template's local geometry through the node has to land on the occurrence's own
    // Y-up world geometry — this catches translation / rotation / matrix-layout errors
    // an identity-in/identity-out check cannot.
    let rot_z = |deg: f64| -> [f64; 16] {
        let (s, c) = (deg.to_radians().sin(), deg.to_radians().cos());
        [c, -s, 0., 0., s, c, 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]
    };
    let translate = |t: [f64; 3]| {
        [1., 0., 0., t[0], 0., 1., 0., t[1], 0., 0., 1., t[2], 0., 0., 0., 1.]
    };
    let apply = |m: &[f64; 16], p: [f64; 3]| {
        [
            m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
            m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
            m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
        ]
    };
    let meta = |transform: [f64; 16]| InstanceMeta {
        transform,
        local_transform: None,
        canonical_transform: None,
        rep_identity: 3,
        instanceable: true,
    };

    // Template at identity placement (baked geometry = canonical, origin 0); occurrence
    // rotated 25° about Z and translated. rtc / origin / scene_center all zero.
    let m_ref = super::compose_world_meta(&meta(super::IDENTITY16));
    let m_ref_inv = super::affine_inverse(&m_ref).expect("identity invertible");
    let m_k = super::compose_world_meta(&meta(
        super::mat4_mul(&translate([7.0, -3.0, 2.0]), &rot_z(25.0)),
    ));
    let node = super::occurrence_node_matrix(&meta(m_k), &m_ref_inv, [0.0; 3], [0.0; 3], [0.0; 3]);

    let canonical = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.3, 0.4, 0.5]];
    let mut max_err = 0.0f64;
    for &p in &canonical {
        // Template local (Y-up): identity template at origin 0, so just the Y-up point.
        let lv = crate::frame::yup_f64(p);
        // Truth: the occurrence's own baked (rtc = 0) geometry, in Y-up.
        let truth = crate::frame::yup_f64(apply(&m_k, p));
        let world = [
            node[0] as f64 * lv[0] + node[4] as f64 * lv[1] + node[8] as f64 * lv[2] + node[12] as f64,
            node[1] as f64 * lv[0] + node[5] as f64 * lv[1] + node[9] as f64 * lv[2] + node[13] as f64,
            node[2] as f64 * lv[0] + node[6] as f64 * lv[1] + node[10] as f64 * lv[2] + node[14] as f64,
        ];
        for k in 0..3 {
            max_err = max_err.max((world[k] - truth[k]).abs());
        }
    }
    // The node matrix is downcast to f32, so the bound is f32 precision, not f64.
    assert!(max_err < 1e-4, "zero-rtc non-identity occurrence mis-placed by {max_err}");
}
