// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::mesh_frame::{MeshCoordinateSpace, PLACEMENT_IDENTITY_EPSILON};
use crate::types::mesh::MeshData;
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

/// #1474: `element_mesh_build.rs` captures a mesh's local-bounds and
/// local-to-world transform BEFORE [`convert_mesh_to_site_local`] runs, because
/// those describe the mesh in its OWN frame and `convert_mesh_to_site_local`
/// re-expresses positions/origin in the site-local frame — a captured transform
/// would go stale if that re-expression actually rotated anything.
///
/// It doesn't, for a pure-translation site placement: `rotation_is_identity`
/// is exactly the condition under which `apply_inverse_rotation_in_place`
/// already no-ops on positions/normals/origin. So only an ACTUALLY rotating
/// site placement invalidates the captured transforms — `site_local_rotation`
/// being `Some` is not enough on its own, since it is `Some` for every
/// `site_local`-tier model (translation-only included).
///
/// This no longer gates INSTANCING metadata (#4118 part B). That consumer got a
/// way to express the same staleness as a frame rather than lose the data:
/// [`native_to_baked`] hands the collator the basis the bake happened in, and
/// the collator conjugates both its reconstruction check and its emitted
/// relative transform by it. The local-bounds/local-to-world consumers (the
/// zero-copy mesh getters and the demesher) have no such basis argument, so
/// they still drop.
#[inline]
pub(crate) fn site_local_rotation_invalidates_captured_transforms(
    site_local_rotation: Option<&Vec<f64>>,
) -> bool {
    site_local_rotation.is_some_and(|m| !rotation_is_identity(m))
}

/// The row-major 4x4 mapping a NATIVE-frame point (IFC Z-up, pre-RTC — the
/// frame `InstanceMeta.transform` and every captured `local_to_world` describe)
/// onto the BAKED point this pipeline actually writes into `MeshData`, for the
/// given coordinate-space tier.
///
/// One function, next to the converter that creates the divergence, so a
/// consumer of baked vertices never re-derives the tier taxonomy by hand.
/// What it encodes:
///
/// * the router subtracts the model RTC offset while baking, so every tier
///   carries `T(-origin_shift)`;
/// * `site_local` ALSO runs [`convert_mesh_to_site_local`], which applies the
///   site placement's inverse rotation `Rᵀ` to positions, normals and the f64
///   origin — and in that tier the RTC offset IS the site translation (the
///   three-tier selection in `processor::mod` takes it straight off the site
///   matrix), so a baked point is exactly `Rᵀ · (P − t_site)`;
/// * `model_rtc` and `raw_ifc` remove no rotation, so they are
///   `T(-origin_shift)` alone. `raw_ifc` selects `origin_shift = (0,0,0)`,
///   which makes that the identity that tier is documented to be. The
///   translation is still applied unconditionally, so a caller handing in a
///   non-zero shift under some other tier string gets the frame its vertices
///   are actually in rather than a silent identity.
///
/// `Rᵀ` is applied under exactly [`rotation_is_identity`]'s condition, because
/// that is the condition [`apply_inverse_rotation_in_place`] itself no-ops
/// under: the two must agree, or this basis describes a bake that did not
/// happen.
///
/// Row-major, to match the glTF exporter's matrix module, which composes its
/// Z-up→Y-up swap on top of this.
pub fn native_to_baked(
    mesh_coordinate_space: MeshCoordinateSpace,
    site_transform: Option<&[f64]>,
    origin_shift: [f64; 3],
) -> [f64; 16] {
    // Linear part: `Rᵀ` in the site_local tier — the ROWS of the row-major
    // result are the COLUMNS of the column-major site matrix — identity
    // everywhere else.
    let rot = site_transform
        .filter(|_| mesh_coordinate_space == MeshCoordinateSpace::SiteLocal)
        .filter(|m| m.len() >= 16 && !rotation_is_identity(m))
        .map(|m| [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]])
        .unwrap_or([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
    let t = [-origin_shift[0], -origin_shift[1], -origin_shift[2]];
    // `Rᵀ · T(-rtc)`: linear block `Rᵀ`, translation `Rᵀ · (-rtc)`.
    #[rustfmt::skip]
    let m = [
        rot[0], rot[1], rot[2], rot[0] * t[0] + rot[1] * t[1] + rot[2] * t[2],
        rot[3], rot[4], rot[5], rot[3] * t[0] + rot[4] * t[1] + rot[5] * t[2],
        rot[6], rot[7], rot[8], rot[6] * t[0] + rot[7] * t[1] + rot[8] * t[2],
        0.0,    0.0,    0.0,    1.0,
    ];
    m
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
/// `pub` only as public API surface: the claim that the streaming server calls
/// it to rotate meshes produced outside this crate's parallel loop was stale —
/// a repo-wide search finds no caller outside this crate and its own integration
/// tests. Kept `pub` because removing a re-exported item is a breaking change
/// (#4192), not because anything downstream is known to need it.
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
    if column_major_matrix.len() < 16
        || rotation_is_identity(column_major_matrix)
        || (p[0] == 0.0 && p[1] == 0.0 && p[2] == 0.0)
    {
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
#[path = "site_local_tests.rs"]
mod tests;
