// SPDX-License-Identifier: MPL-2.0
//! Instancing matrix math for the glTF exporter (row-major f64 4x4).
//!
//! Split out of `gltf.rs` to keep that module under its size ratchet; the logic is
//! unchanged, so instanced-occurrence placement (and the exported bytes) is identical.
//!
//! An occurrence's node matrix must map the shared template's Y-up LOCAL geometry
//! to that occurrence's Y-up BAKED world position, minus the model-wide
//! `scene_center` that the root node carries:
//!
//!   N_k = T(-scene_center) · S · [ T(-rtc) · (M_k · M_ref⁻¹) · T(rtc) ] · S⁻¹ · T(template_origin_yup)
//!
//! where `M = transform · local · canonical` is the per-occurrence world placement
//! from `InstanceMeta` (Z-up, **pre-RTC**), `rtc` is the model RTC/site offset the
//! baker subtracted (Z-up), and `S` is the Z-up→Y-up basis `(x,y,z) → (x, z, -y)`.
//! The `T(-rtc)·…·T(rtc)` conjugation moves the relative transform from the pre-RTC
//! frame `M` lives in into the POST-RTC baked frame the template geometry is in —
//! without it, a rotated occurrence under a non-zero site/georef offset is
//! mis-translated by `(R_rel - I)·rtc` (kilometres at national-grid scale). Everything
//! is f64, recomputed from the f64 `InstanceMeta` (NOT the collator's f32 `rel`), so
//! the absolute-magnitude terms cancel to a small, f32-precise translation before the
//! final downcast even at national-grid coordinates.

use ifc_lite_geometry::InstanceMeta;

/// Z-up→Y-up basis as a row-major 4x4 (linear part only; `(x,y,z) → (x, z, -y)`).
const S_YUP: [f64; 16] = [
    1.0, 0.0, 0.0, 0.0, //
    0.0, 0.0, 1.0, 0.0, //
    0.0, -1.0, 0.0, 0.0, //
    0.0, 0.0, 0.0, 1.0,
];
/// Inverse (transpose, since `S_YUP` is a proper rotation): `(x,y,z) → (x, -z, y)`.
const S_YUP_INV: [f64; 16] = [
    1.0, 0.0, 0.0, 0.0, //
    0.0, 0.0, -1.0, 0.0, //
    0.0, 1.0, 0.0, 0.0, //
    0.0, 0.0, 0.0, 1.0,
];
const IDENTITY16: [f64; 16] = [
    1.0, 0.0, 0.0, 0.0, //
    0.0, 1.0, 0.0, 0.0, //
    0.0, 0.0, 1.0, 0.0, //
    0.0, 0.0, 0.0, 1.0,
];

/// Row-major 4x4 multiply `a · b`.
fn mat4_mul(a: &[f64; 16], b: &[f64; 16]) -> [f64; 16] {
    let mut out = [0.0f64; 16];
    for r in 0..4 {
        for c in 0..4 {
            let mut s = 0.0;
            for k in 0..4 {
                s += a[r * 4 + k] * b[k * 4 + c];
            }
            out[r * 4 + c] = s;
        }
    }
    out
}

/// Row-major translation matrix.
fn mat4_translation(t: [f64; 3]) -> [f64; 16] {
    [
        1.0, 0.0, 0.0, t[0], //
        0.0, 1.0, 0.0, t[1], //
        0.0, 0.0, 1.0, t[2], //
        0.0, 0.0, 0.0, 1.0,
    ]
}

/// Transpose a row-major f64 4x4 into the column-major `[f32; 16]` glTF expects.
fn row_major_f64_to_col_major_f32(m: &[f64; 16]) -> [f32; 16] {
    let mut out = [0.0f32; 16];
    for r in 0..4 {
        for c in 0..4 {
            out[c * 4 + r] = m[r * 4 + c] as f32;
        }
    }
    out
}

/// Inverse of a row-major AFFINE 4x4 (last row `[0,0,0,1]`): invert the upper 3x3
/// (cofactor / determinant) and map the translation by `-R⁻¹·t`. Returns `None` if
/// the 3x3 is singular (degenerate placement) so the caller can fall back to flat.
pub(super) fn affine_inverse(m: &[f64; 16]) -> Option<[f64; 16]> {
    let a = m[0]; let b = m[1]; let c = m[2];
    let d = m[4]; let e = m[5]; let f = m[6];
    let g = m[8]; let h = m[9]; let i = m[10];
    let det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if det.abs() < 1e-18 {
        return None;
    }
    let inv_det = 1.0 / det;
    // Inverse of the 3x3 (row-major) via the transposed cofactor matrix.
    let r = [
        (e * i - f * h) * inv_det,
        (c * h - b * i) * inv_det,
        (b * f - c * e) * inv_det,
        (f * g - d * i) * inv_det,
        (a * i - c * g) * inv_det,
        (c * d - a * f) * inv_det,
        (d * h - e * g) * inv_det,
        (b * g - a * h) * inv_det,
        (a * e - b * d) * inv_det,
    ];
    let (tx, ty, tz) = (m[3], m[7], m[11]);
    // Translation of the inverse: -R⁻¹ · t.
    let it = [
        -(r[0] * tx + r[1] * ty + r[2] * tz),
        -(r[3] * tx + r[4] * ty + r[5] * tz),
        -(r[6] * tx + r[7] * ty + r[8] * tz),
    ];
    Some([
        r[0], r[1], r[2], it[0], //
        r[3], r[4], r[5], it[1], //
        r[6], r[7], r[8], it[2], //
        0.0, 0.0, 0.0, 1.0,
    ])
}

/// Compose an `InstanceMeta`'s world placement `transform · local · canonical`
/// (row-major f64), the same product the collator's `compose_world` builds.
pub(super) fn compose_world_meta(meta: &InstanceMeta) -> [f64; 16] {
    let local = meta.local_transform.unwrap_or(IDENTITY16);
    let canonical = meta.canonical_transform.unwrap_or(IDENTITY16);
    mat4_mul(&meta.transform, &mat4_mul(&local, &canonical))
}

/// Build the column-major glTF node matrix placing a shared template (Y-up local
/// geometry, relative to `template_origin_yup`) at one occurrence's BAKED pose.
/// Recomputed in f64 from the occurrence's `InstanceMeta`, the precomputed template
/// inverse `m_ref_inv` (`affine_inverse(compose_world_meta(template))`, computed once
/// per group), and the model `rtc` offset (Z-up) the baker subtracted.
pub(super) fn occurrence_node_matrix(
    occ: &InstanceMeta,
    m_ref_inv: &[f64; 16],
    rtc_zup: [f64; 3],
    template_origin_yup: [f64; 3],
    scene_center: [f64; 3],
) -> [f32; 16] {
    occurrence_node_matrix_composed(
        compose_world_meta(occ),
        m_ref_inv,
        rtc_zup,
        template_origin_yup,
        scene_center,
    )
}

/// The same, from a world placement already composed.
///
/// `compose_world_meta` is the only thing this derivation reads out of an
/// `InstanceMeta`, so a caller that has to keep one record per mesh can keep the
/// 128-byte product instead of the 424-byte struct. That is what lets the
/// bounded assembler afford instancing at all.
pub(super) fn occurrence_node_matrix_composed(
    m_k: [f64; 16],
    m_ref_inv: &[f64; 16],
    rtc_zup: [f64; 3],
    template_origin_yup: [f64; 3],
    scene_center: [f64; 3],
) -> [f32; 16] {
    // rel maps the template's PRE-RTC world geometry onto occurrence k's.
    let rel_pre = mat4_mul(&m_k, m_ref_inv);
    // Conjugate into the POST-RTC baked frame the geometry actually lives in.
    let rel_baked = mat4_mul(
        &mat4_translation([-rtc_zup[0], -rtc_zup[1], -rtc_zup[2]]),
        &mat4_mul(&rel_pre, &mat4_translation(rtc_zup)),
    );
    // Conjugate Z-up→Y-up (the template was converted by the same S).
    let rel_yup = mat4_mul(&mat4_mul(&S_YUP, &rel_baked), &S_YUP_INV);
    let n = mat4_mul(
        &mat4_translation([-scene_center[0], -scene_center[1], -scene_center[2]]),
        &mat4_mul(&rel_yup, &mat4_translation(template_origin_yup)),
    );
    row_major_f64_to_col_major_f32(&n)
}

#[cfg(test)]
#[path = "matrix_tests.rs"]
mod tests;
