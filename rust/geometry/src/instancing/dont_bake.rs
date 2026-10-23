// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #1623 Phase 2 don't-bake finalize helpers.
//!
//! Split out of `collate.rs` to keep that module under its size ratchet; the
//! logic is unchanged, so instanced-occurrence placement (and every
//! reconstructed byte) is identical. These three functions let the browser
//! don't-bake path record and, if needed, recover a world placement WITHOUT
//! ever materializing the occurrence's own baked vertices — see each fn doc.

use super::collate::{compose_world, mat4_to_row_major_f32, to_post_rtc};
use crate::mesh::{InstanceMeta, Mesh};
use nalgebra::Matrix4;

/// Compose an occurrence's full PRE-RTC world transform `transform·local·canonical`
/// as a row-major `[f64; 16]`. Public so the processing crate's don't-bake finalize
/// (#1623 Phase 2) can record the SAME world placement `collate_refs` computes for a
/// baked occurrence — without materializing the occurrence's vertices.
pub fn compose_instance_world_row_major(meta: &InstanceMeta) -> [f64; 16] {
    let m = compose_world(meta);
    let mut out = [0.0f64; 16];
    for r in 0..4 {
        for c in 0..4 {
            out[r * 4 + c] = m[(r, c)];
        }
    }
    out
}

/// Template-relative instance transform `rel = post_rtc(M_k) · post_rtc(M_ref)⁻¹`
/// as a row-major `[f32; 16]`, or `None` when `M_ref` is singular. `m_k` / `m_ref`
/// are PRE-RTC row-major world transforms (see [`compose_instance_world_row_major`]);
/// `rtc` is the model offset. This is EXACTLY `collate_refs`' per-occurrence `rel`,
/// exposed for the don't-bake finalize where the occurrence carries no geometry to
/// group — the template's baked world geometry placed by `rel` reproduces the
/// occurrence's world geometry (bounded by `verify_recomposition`). #1623 Phase 2.
pub fn instance_rel_row_major_f32(
    m_k: &[f64; 16],
    m_ref: &[f64; 16],
    rtc: [f64; 3],
) -> Option<[f32; 16]> {
    let mk = to_post_rtc(Matrix4::from_row_slice(m_k), rtc);
    let mref = to_post_rtc(Matrix4::from_row_slice(m_ref), rtc);
    let mref_inv = mref.try_inverse()?;
    Some(mat4_to_row_major_f32(&(mk * mref_inv)))
}

/// Bake a SOURCE-coords `Mesh` at a PRE-RTC row-major world transform into absolute
/// POST-RTC world geometry `(positions, normals, indices)` — the #1623 Phase 2
/// finalize fallback for a don't-bake instance whose template occurrence never
/// materialized (an orphan; effectively unreachable for the eligible single-solid
/// type-instanced set, but kept so geometry is NEVER silently lost). The affine part
/// transforms positions; the inverse-transpose of the linear part transforms normals
/// (renormalized). Geometrically equal to the baked flat occurrence (same triangles);
/// the registry source is pre-weld, so vertices are unwelded — that changes only the
/// vertex count, not the rendered surface. Source positions are relative to the
/// source's f64 `origin`, which a raw national-grid item keeps (#7690).
pub fn bake_source_at_world(
    source: &Mesh,
    world_row_major: &[f64; 16],
    rtc: [f64; 3],
) -> (Vec<f32>, Vec<f32>, Vec<u32>) {
    let m = to_post_rtc(Matrix4::from_row_slice(world_row_major), rtc);
    let vcount = source.positions.len() / 3;
    let mut positions = Vec::with_capacity(source.positions.len());
    for v in 0..vcount {
        let p = m * nalgebra::Vector4::new(
            source.positions[v * 3] as f64 + source.origin[0],
            source.positions[v * 3 + 1] as f64 + source.origin[1],
            source.positions[v * 3 + 2] as f64 + source.origin[2],
            1.0,
        );
        positions.push((p.x / p.w) as f32);
        positions.push((p.y / p.w) as f32);
        positions.push((p.z / p.w) as f32);
    }
    let mut normals = source.normals[..source.normals.len() / 3 * 3].to_vec();
    crate::math::normals::transform_normals_in_place(&mut normals, &m);
    (positions, normals, source.indices.clone())
}
