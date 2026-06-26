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

/// Apply the inverse of the site placement's 3×3 rotation to in-place `f32`
/// triplets (positions or normals). Translation is handled separately via the
/// router's `rtc_offset`; this only rotates vertices into the site-local axis
/// frame when that frame is non-identity.
fn apply_inverse_rotation_in_place(values: &mut [f32], column_major_matrix: &[f64]) {
    if values.len() < 3 || column_major_matrix.len() < 16 {
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

    let is_identity = (r00 - 1.0).abs() < PLACEMENT_IDENTITY_EPSILON
        && r10.abs() < PLACEMENT_IDENTITY_EPSILON
        && r20.abs() < PLACEMENT_IDENTITY_EPSILON
        && r01.abs() < PLACEMENT_IDENTITY_EPSILON
        && (r11 - 1.0).abs() < PLACEMENT_IDENTITY_EPSILON
        && r21.abs() < PLACEMENT_IDENTITY_EPSILON
        && r02.abs() < PLACEMENT_IDENTITY_EPSILON
        && r12.abs() < PLACEMENT_IDENTITY_EPSILON
        && (r22 - 1.0).abs() < PLACEMENT_IDENTITY_EPSILON;
    if is_identity {
        return;
    }

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
