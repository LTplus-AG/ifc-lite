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
//!   N_k = T(-scene_center) · B · (M_k · M_ref⁻¹) · B⁻¹ · T(template_origin_yup)
//!
//! where `M = transform · local · canonical` is the per-occurrence world placement
//! from `InstanceMeta` (Z-up, **pre-RTC**) and `B = S · Rᵀ · T(-rtc)` is everything
//! that happened to the vertices after `M` was captured: the model RTC/site offset
//! the baker subtracted (`rtc`, Z-up), the site placement's inverse rotation `Rᵀ`
//! the `site_local` tier baked in on top of it, and the Z-up→Y-up basis
//! `S: (x,y,z) → (x, z, -y)` the assembler applied. Conjugating by `B` moves the
//! relative transform from the pre-RTC native frame `M` lives in into the baked
//! frame the template geometry is actually in — without the `T(-rtc)` factor a
//! rotated occurrence under a non-zero site/georef offset is mis-translated by
//! `(R_rel - I)·rtc` (kilometres at national-grid scale), and without `Rᵀ` a
//! translated sibling under a yawed site is mis-translated by `(I - Rᵀ)·d`
//! (metres at building scale, #4118). Everything
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

/// The basis the baked template geometry lives in relative to the frame
/// `InstanceMeta` (hence a collator `rel`) is expressed in:
/// `S_YUP · native_to_baked(tier)`.
///
/// Three conversions separate them, and this function owns none of the
/// knowledge about the last two. The assembler converts every visible mesh's
/// baked positions Z-up→Y-up before collation — that is `S_YUP`, and it is an
/// export-crate fact. Everything the BAKER did is
/// `ifc_lite_processing::native_to_baked`: the model RTC offset it subtracted,
/// and (in the `site_local` tier only) the site placement's inverse rotation
/// `Rᵀ` that `convert_mesh_to_site_local` applied afterwards. Both of those
/// terms matter and neither is optional — the RTC one leaves a residual of
/// `(R_rel - I) · rtc`, hundreds of kilometres for a rotated sibling at
/// national-grid magnitude, and the `Rᵀ` one leaves `(I - Rᵀ)·d`, metres for a
/// 6 m sibling under a 34 degree site yaw, which is what made a rotated site
/// instance nothing at all (#4118).
///
/// `site_zup` is `site_restore`'s already-tier-filtered site placement: `Some`
/// exactly when the model is `site_local`, `None` otherwise.
///
/// Used at BOTH sites that need it — `build_gltf` hands it to
/// `collate_refs_in_basis` as the `baked_basis`, and
/// [`occurrence_node_matrix_composed`] conjugates `rel` by it to build the
/// shipped node matrix — so the frame the check verifies in is the frame the
/// export actually places in, by construction rather than by two copies agreeing.
pub(super) fn baked_basis_yup(rtc_zup: [f64; 3], site_zup: Option<&[f64]>) -> [f64; 16] {
    mat4_mul(
        &S_YUP,
        &ifc_lite_processing::native_to_baked(
            site_zup.map_or(
                ifc_lite_processing::MeshCoordinateSpace::RawIfc,
                |_| ifc_lite_processing::MeshCoordinateSpace::SiteLocal,
            ),
            site_zup,
            rtc_zup,
        ),
    )
}

/// The inverse of [`baked_basis_yup`], built without a general inversion.
///
/// `B = S_YUP · Rᵀ · T(-rtc)`, so `B⁻¹ = T(rtc) · R · S_YUP⁻¹`. `R` is recovered
/// by transposing `native_to_baked`'s 3x3 block, which is exact: the block is
/// the transpose of an `IfcAxis2Placement3D` rotation, orthonormal by
/// construction, and the length-unit scale the router applies touches only a
/// placement's translation column. That transpose-is-the-inverse identity is
/// not a new assumption here — it is the one `apply_inverse_rotation_in_place`
/// uses to un-rotate the vertices in the first place.
fn baked_basis_yup_inverse(rtc_zup: [f64; 3], site_zup: Option<&[f64]>) -> [f64; 16] {
    let b = ifc_lite_processing::native_to_baked(
        site_zup.map_or(
            ifc_lite_processing::MeshCoordinateSpace::RawIfc,
            |_| ifc_lite_processing::MeshCoordinateSpace::SiteLocal,
        ),
        site_zup,
        rtc_zup,
    );
    #[rustfmt::skip]
    let r = [
        b[0], b[4], b[8],  0.0,
        b[1], b[5], b[9],  0.0,
        b[2], b[6], b[10], 0.0,
        0.0,  0.0,  0.0,   1.0,
    ];
    mat4_mul(&mat4_translation(rtc_zup), &mat4_mul(&r, &S_YUP_INV))
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
    site_zup: Option<&[f64]>,
    template_origin_yup: [f64; 3],
    scene_center: [f64; 3],
) -> [f32; 16] {
    occurrence_node_matrix_composed(
        compose_world_meta(occ),
        m_ref_inv,
        rtc_zup,
        site_zup,
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
    site_zup: Option<&[f64]>,
    template_origin_yup: [f64; 3],
    scene_center: [f64; 3],
) -> [f32; 16] {
    // rel maps the template's PRE-RTC world geometry onto occurrence k's.
    let rel_pre = mat4_mul(&m_k, m_ref_inv);
    // Conjugate `rel` into the frame the BAKED template geometry lives in:
    // POST-RTC (the offset the baker subtracted), site-local-rotated where the
    // baker rotated it, and Y-up (the conversion the assembler applied).
    // `B · rel · B⁻¹` with `B = S_YUP · Rᵀ · T(-rtc)`, which is the same `B` the
    // collator is handed as its `baked_basis` — shared through
    // [`baked_basis_yup`] so the two cannot drift apart.
    //
    // This is NOT bit-identical to computing the conjugations separately
    // (`S · (Rᵀ · (T(-rtc) · rel · T(rtc)) · R) · S⁻¹`), and the earlier claim
    // that it was is wrong. Folding `S` in is exact — `S_YUP` is a signed
    // permutation, so multiplying by it only moves and negates entries — but
    // folding the TRANSLATIONS re-associates real additions, and f64 addition is
    // not associative: a reviewer measured a max delta of 9.3e-10 m across
    // 20,000 georeferenced cases. `Rᵀ` is a third factor of the same kind and
    // does not change the argument: it is an orthonormal 3x3, so it neither
    // grows the magnitudes being added nor introduces a new cancellation, and
    // the re-association delta stays at that scale. It IS harmless here for two
    // independent reasons, both worth stating because neither is obvious: the
    // result is cast to f32 below (a ~1e-9 m difference at building scale is far
    // under one f32 ULP, so the emitted bytes are unchanged), and the collator
    // tolerance this basis feeds floors at 1e-6 m, a thousand times wider.
    // Anything that changes either — an f64 node matrix, a tighter tolerance —
    // makes the delta visible and this note is the warning.
    let rel_yup = mat4_mul(
        &mat4_mul(&baked_basis_yup(rtc_zup, site_zup), &rel_pre),
        &baked_basis_yup_inverse(rtc_zup, site_zup),
    );
    let n = mat4_mul(
        &mat4_translation([-scene_center[0], -scene_center[1], -scene_center[2]]),
        &mat4_mul(&rel_yup, &mat4_translation(template_origin_yup)),
    );
    row_major_f64_to_col_major_f32(&n)
}

#[cfg(test)]
#[path = "matrix_tests.rs"]
mod tests;
