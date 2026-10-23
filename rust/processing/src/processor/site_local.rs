// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::mesh_frame::MeshCoordinateSpace;
use ifc_lite_geometry::math::mat4;
use crate::types::mesh::MeshData;
/// The rotation-removal condition, spelled once beside the frame it belongs
/// to. Re-exported here because this module's converter and `element.rs`'s
/// guard are its other two readers.
pub(super) use crate::mesh_frame::rotation_is_identity;

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
    let site = site_transform
        .filter(|_| mesh_coordinate_space == MeshCoordinateSpace::SiteLocal)
        .filter(|m| m.len() >= 16 && !rotation_is_identity(m))
        .and_then(|m| <&[f64; 16]>::try_from(&m[..16]).ok())
        .unwrap_or(&mat4::IDENTITY);
    let t = [-origin_shift[0], -origin_shift[1], -origin_shift[2]];
    // `Rᵀ · T(-rtc)`: linear block `Rᵀ`, translation `Rᵀ · (-rtc)`, which is
    // `transform_vector` on the column-major site array.
    let rt = mat4::transform_vector(site, t);
    #[rustfmt::skip]
    let m = [
        site[0], site[1], site[2], rt[0],
        site[4], site[5], site[6], rt[1],
        site[8], site[9], site[10], rt[2],
        0.0,     0.0,     0.0,     1.0,
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

    let Ok(m) = <&[f64; 16]>::try_from(&column_major_matrix[..16]) else {
        return;
    };
    for chunk in values.chunks_exact_mut(3) {
        let p = mat4::transform_vector(m, [chunk[0] as f64, chunk[1] as f64, chunk[2] as f64]);
        chunk[0] = p[0] as f32;
        chunk[1] = p[1] as f32;
        chunk[2] = p[2] as f32;
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
    if let Ok(m) = <&[f64; 16]>::try_from(&column_major_matrix[..16]) {
        *p = mat4::transform_vector(m, *p);
    }
}

#[cfg(test)]
#[path = "site_local_tests.rs"]
mod tests;
