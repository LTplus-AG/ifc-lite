// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::types::mesh::MeshData;

pub(super) const SITE_LOCAL_MESH_COORDINATE_SPACE: &str = "site_local";
pub(super) const MODEL_RTC_MESH_COORDINATE_SPACE: &str = "model_rtc";
pub(super) const RAW_IFC_MESH_COORDINATE_SPACE: &str = "raw_ifc";

/// Epsilon (metres) below which a placement translation is treated as identity.
/// Avoids overriding a detected RTC anchor when `IfcSite` sits at the origin
/// while the geometry itself carries large world coordinates.
const PLACEMENT_IDENTITY_EPSILON: f64 = 1e-9;

#[inline]
pub(super) fn translation_is_nonidentity(t: (f64, f64, f64)) -> bool {
    t.0.abs() > PLACEMENT_IDENTITY_EPSILON
        || t.1.abs() > PLACEMENT_IDENTITY_EPSILON
        || t.2.abs() > PLACEMENT_IDENTITY_EPSILON
}

/// True when a column-major 4x4 matrix's 3×3 rotation block is (within
/// [`PLACEMENT_IDENTITY_EPSILON`]) the identity — i.e. the placement it came
/// from is a pure translation, contributing no rotation of its own.
///
/// A matrix shorter than 16 elements is treated conservatively as NOT
/// identity (callers that gate a "safe to keep" decision on this should keep
/// dropping rather than assume something about a shape they can't read).
///
/// Shared by [`apply_inverse_rotation_in_place`] (skip the no-op rotation
/// pass) and `element.rs`'s instancing/local-bounds guard (#4118: a pure
/// translation site placement never rotates positions, so metadata captured
/// before `convert_mesh_to_site_local` runs is never invalidated by it).
#[inline]
pub(super) fn rotation_is_identity(column_major_matrix: &[f64]) -> bool {
    if column_major_matrix.len() < 16 {
        return false;
    }
    let r00 = column_major_matrix[0];
    let r10 = column_major_matrix[1];
    let r20 = column_major_matrix[2];
    let r01 = column_major_matrix[4];
    let r11 = column_major_matrix[5];
    let r21 = column_major_matrix[6];
    let r02 = column_major_matrix[8];
    let r12 = column_major_matrix[9];
    let r22 = column_major_matrix[10];

    (r00 - 1.0).abs() < PLACEMENT_IDENTITY_EPSILON
        && r10.abs() < PLACEMENT_IDENTITY_EPSILON
        && r20.abs() < PLACEMENT_IDENTITY_EPSILON
        && r01.abs() < PLACEMENT_IDENTITY_EPSILON
        && (r11 - 1.0).abs() < PLACEMENT_IDENTITY_EPSILON
        && r21.abs() < PLACEMENT_IDENTITY_EPSILON
        && r02.abs() < PLACEMENT_IDENTITY_EPSILON
        && r12.abs() < PLACEMENT_IDENTITY_EPSILON
        && (r22 - 1.0).abs() < PLACEMENT_IDENTITY_EPSILON
}

/// #4118: `element.rs` captures a mesh's instancing/local-bounds/local-to-world
/// transforms BEFORE [`convert_mesh_to_site_local`] runs, because those
/// transforms describe the mesh in its OWN frame and `convert_mesh_to_site_local`
/// re-expresses positions/origin in the site-local frame — a captured transform
/// would go stale if that re-expression actually rotated anything.
///
/// It doesn't, for a pure-translation site placement: `rotation_is_identity`
/// is exactly the condition under which `apply_inverse_rotation_in_place`
/// already no-ops on positions/normals/origin. So only an ACTUALLY rotating
/// site placement invalidates the captured transforms — `site_local_rotation`
/// being `Some` is not enough on its own, since it is `Some` for every
/// `site_local`-tier model (translation-only included).
#[inline]
pub(crate) fn site_local_rotation_invalidates_captured_transforms(
    site_local_rotation: Option<&Vec<f64>>,
) -> bool {
    site_local_rotation.is_some_and(|m| !rotation_is_identity(m))
}

/// Apply the inverse of the site placement's 3×3 rotation to in-place `f32`
/// triplets (positions or normals). Translation is handled separately via the
/// router's `rtc_offset`; this only rotates vertices into the site-local axis
/// frame when that frame is non-identity.
fn apply_inverse_rotation_in_place(values: &mut [f32], column_major_matrix: &[f64]) {
    if values.len() < 3 || column_major_matrix.len() < 16 {
        return;
    }
    if rotation_is_identity(column_major_matrix) {
        return;
    }

    let r00 = column_major_matrix[0];
    let r10 = column_major_matrix[1];
    let r20 = column_major_matrix[2];
    let r01 = column_major_matrix[4];
    let r11 = column_major_matrix[5];
    let r21 = column_major_matrix[6];
    let r02 = column_major_matrix[8];
    let r12 = column_major_matrix[9];
    let r22 = column_major_matrix[10];

    for chunk in values.chunks_exact_mut(3) {
        let x = chunk[0] as f64;
        let y = chunk[1] as f64;
        let z = chunk[2] as f64;
        chunk[0] = (r00 * x + r10 * y + r20 * z) as f32;
        chunk[1] = (r01 * x + r11 * y + r21 * z) as f32;
        chunk[2] = (r02 * x + r12 * y + r22 * z) as f32;
    }
}

/// Rotate a mesh into the site-local axis frame. Only runs for the
/// `site_local` coordinate-space tier; translation alignment happens upstream
/// via the router's RTC subtraction.
///
/// Exposed so the streaming server can apply the same rotation to meshes it
/// produces outside this crate's parallel loop.
pub fn convert_mesh_to_site_local(mesh: &mut MeshData, site_transform: Option<&Vec<f64>>) {
    let Some(site_transform) = site_transform else {
        return;
    };

    apply_inverse_rotation_in_place(&mut mesh.positions, site_transform);
    apply_inverse_rotation_in_place(&mut mesh.normals, site_transform);
    // Positions are stored RELATIVE to `mesh.origin`, so the world point is
    // `origin + position`. The site-local inverse rotation acts on the world
    // point, so the origin must be rotated by the SAME inverse rotation (in f64)
    // — otherwise the element would be rotated about the wrong centre.
    apply_inverse_rotation_point_f64(&mut mesh.origin, site_transform);
}

/// Inverse-rotate a single f64 point in place by `column_major_matrix` (the same
/// Rᵀ used by `apply_inverse_rotation_in_place`). Used for the per-mesh origin.
fn apply_inverse_rotation_point_f64(p: &mut [f64; 3], column_major_matrix: &[f64]) {
    if column_major_matrix.len() < 16 || (p[0] == 0.0 && p[1] == 0.0 && p[2] == 0.0) {
        return;
    }
    let (r00, r10, r20) = (
        column_major_matrix[0],
        column_major_matrix[1],
        column_major_matrix[2],
    );
    let (r01, r11, r21) = (
        column_major_matrix[4],
        column_major_matrix[5],
        column_major_matrix[6],
    );
    let (r02, r12, r22) = (
        column_major_matrix[8],
        column_major_matrix[9],
        column_major_matrix[10],
    );
    let (x, y, z) = (p[0], p[1], p[2]);
    p[0] = r00 * x + r10 * y + r20 * z;
    p[1] = r01 * x + r11 * y + r21 * z;
    p[2] = r02 * x + r12 * y + r22 * z;
}

#[cfg(test)]
mod tests {
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

    #[test]
    fn short_matrix_is_conservatively_not_identity() {
        assert!(!rotation_is_identity(&[1.0, 0.0, 0.0]));
        assert!(!rotation_is_identity(&[]));
    }
}
