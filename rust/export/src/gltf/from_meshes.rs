// SPDX-License-Identifier: MPL-2.0
//! The **from-meshes** GLB path: assemble a GLB from already-produced meshes (the
//! viewer's `MeshData`, flattened) with no re-meshing, plus its fail-closed wrapper.
//!
//! Split out of `gltf.rs` to keep that module under its size ratchet; the logic is
//! unchanged, so the emitted bytes are identical.

use super::{build_gltf, pack_glb, Chunker, GltfStats, MeshView};
use crate::error::ExportError;

/// Fail-closed [`export_glb_from_meshes`]: validates that the per-mesh
/// `vertex_counts` / `index_counts` (and normals) are fully backed by the flattened
/// buffers BEFORE assembling. If a declared vertex/index count runs past the end of
/// `positions` / `indices`, an `index_counts` entry is missing, or `normals` is empty or
/// too short to cover every emitted vertex, returns [`ExportError::MalformedMeshInput`]
/// instead of silently dropping the un-backed meshes (which the infallible variant does —
/// a valid GLB missing part of the model, reported as success). Prefer this at any
/// boundary where the counts and buffers come from separate sources (the wasm FFI).
#[allow(clippy::too_many_arguments)]
pub fn try_export_glb_from_meshes(
    positions: &[f32],
    normals: &[f32],
    indices: &[u32],
    vertex_counts: &[u32],
    index_counts: &[u32],
    colors: &[f32],
    origins: &[f64],
    express_ids: &[u32],
    include_metadata: bool,
    lit: bool,
    emissive: bool,
) -> Result<(Vec<u8>, GltfStats), ExportError> {
    // Sum the declared counts and check they fit the flattened buffers. `u64` sums so a
    // caller passing absurd counts can't overflow `usize` on wasm32 before the compare.
    let n = vertex_counts.len();
    let vsum: u64 = vertex_counts.iter().map(|&c| c as u64).sum();
    let isum: u64 = index_counts.iter().take(n).map(|&c| c as u64).sum();
    if vsum * 3 > positions.len() as u64 {
        return Err(ExportError::MalformedMeshInput {
            detail: format!(
                "vertex_counts sum to {vsum} vertices ({} position floats) but `positions` has {}",
                vsum * 3,
                positions.len()
            ),
        });
    }
    // Parallel-array contract: each declared mesh needs its own `index_counts` entry.
    // With fewer entries the assembler reads a missing count as 0 indices, so those
    // meshes fail `view_ok` and vanish from a "successful" GLB.
    if index_counts.len() < n {
        return Err(ExportError::MalformedMeshInput {
            detail: format!(
                "`index_counts` has {} entries but `vertex_counts` declares {n} meshes",
                index_counts.len()
            ),
        });
    }
    // Normals must cover EVERY emitted vertex. Empty (or short) normals make the
    // under-covered meshes fall back to an empty normal slice, silently failing the
    // `view_ok` `normals.len() == positions.len()` gate — with empty normals that drops
    // the WHOLE model into a valid-but-empty GLB.
    if (normals.len() as u64) < vsum * 3 {
        return Err(ExportError::MalformedMeshInput {
            detail: format!(
                "`normals` has {} floats but the meshes need {} (vertex_counts sum to {vsum})",
                normals.len(),
                vsum * 3
            ),
        });
    }
    if isum > indices.len() as u64 {
        return Err(ExportError::MalformedMeshInput {
            detail: format!(
                "index_counts sum to {isum} but `indices` has {}",
                indices.len()
            ),
        });
    }
    // Every count is backed and every mesh's normals/indices are present, so the
    // infallible assembler's malformed-input `break` is unreachable and no mesh is dropped.
    Ok(export_glb_from_meshes(
        positions, normals, indices, vertex_counts, index_counts, colors, origins,
        express_ids, include_metadata, lit, emissive,
    ))
}

/// Assemble a GLB from already-produced meshes (the viewer's MeshData — **no re-meshing**).
/// Per mesh `i`: `vertex_counts[i]` vertices + `index_counts[i]` indices, taken in order
/// from the concatenated `positions`/`normals`/`indices`; `colors` is RGBA per mesh,
/// `origins` is xyz per mesh, `express_ids` labels each mesh. Indices are per-mesh LOCAL.
/// Callers pass exactly the meshes they want emitted (visibility filtering is theirs).
///
/// NOTE: on malformed input — a `vertex_counts`/`index_counts` entry that runs past the
/// end of the flattened buffers — this stops at the first un-backed mesh and returns the
/// valid prefix, so a caller bug ships a GLB missing the model's tail as "success". Use
/// [`try_export_glb_from_meshes`] to turn that into [`ExportError::MalformedMeshInput`].
#[allow(clippy::too_many_arguments)]
// The index `i` walks several parallel count/offset arrays in lockstep; a
// range loop is the clearest expression and avoids zipping ragged slices.
#[allow(clippy::needless_range_loop)]
pub fn export_glb_from_meshes(
    positions: &[f32],
    normals: &[f32],
    indices: &[u32],
    vertex_counts: &[u32],
    index_counts: &[u32],
    colors: &[f32],
    origins: &[f64],
    express_ids: &[u32],
    include_metadata: bool,
    lit: bool,
    emissive: bool,
) -> (Vec<u8>, GltfStats) {
    let n = vertex_counts.len();
    // The viewer's `MeshData` arrives pre-welded from the mesh source
    // (`ifc_lite_processing::element::build_mesh_data` welds every element via
    // `ifc_lite_geometry::mesh_weld::weld_indexed`), so this path no longer
    // re-welds — it slices each mesh's block straight into a borrowing
    // `MeshView`. Views borrow the caller's buffers, which outlive the call.
    let mut views: Vec<MeshView> = Vec::with_capacity(n);
    let mut vbase = 0usize; // running vertex offset
    let mut ibase = 0usize; // running index offset
    for i in 0..n {
        let vc = vertex_counts[i] as usize;
        let ic = index_counts.get(i).copied().unwrap_or(0) as usize;
        if (vbase + vc) * 3 > positions.len() || ibase + ic > indices.len() {
            break; // malformed counts — stop rather than panic
        }
        let pslice = &positions[vbase * 3..(vbase + vc) * 3];
        let nslice: &[f32] = if normals.len() >= (vbase + vc) * 3 {
            &normals[vbase * 3..(vbase + vc) * 3]
        } else {
            &[]
        };
        let islice = &indices[ibase..ibase + ic];
        let color = [
            colors.get(i * 4).copied().unwrap_or(0.8),
            colors.get(i * 4 + 1).copied().unwrap_or(0.8),
            colors.get(i * 4 + 2).copied().unwrap_or(0.8),
            colors.get(i * 4 + 3).copied().unwrap_or(1.0),
        ];
        let origin = [
            origins.get(i * 3).copied().unwrap_or(0.0),
            origins.get(i * 3 + 1).copied().unwrap_or(0.0),
            origins.get(i * 3 + 2).copied().unwrap_or(0.0),
        ];
        views.push(MeshView {
            express_id: express_ids.get(i).copied().unwrap_or(0),
            ifc_type: "",
            global_id: None,
            positions: pslice,
            normals: nslice,
            indices: islice,
            color,
            origin,
            // The viewer's MeshData drops the instancing side-channel across the
            // worker boundary (it is `#[serde(skip)]`), so this path is always flat.
            instance: None,
        });
        vbase += vc;
        ibase += ic;
    }
    // From-meshes geometry is already absolute Y-up and never instances (no
    // side-channel), so there is no RTC frame to compensate. Quantization is a
    // from-bytes feature; the viewer path stays f32.
    let mut ch = Chunker::new(12, usize::MAX, None);
    let (gltf, stats) =
        build_gltf(
            &views,
            include_metadata,
            None,
            lit,
            emissive,
            [0.0, 0.0, 0.0],
            // No `ProcessingResult` reaches this path, so there is no site
            // placement available to restore.
            //
            // Not the same as "there is nothing to restore". The viewer's own
            // `MeshData` comes through the same pipeline and, for a translated
            // site, *is* site-local, so a GLB exported from the viewer stays in
            // that frame. Fixing that needs the API to carry `site_transform`,
            // which is a change to its signature rather than to this line.
            None,
            false,
            &mut ch,
        );
    let json = serde_json::to_vec(&gltf).expect("glTF JSON serializes");
    (pack_glb(&json, &ch.pos, &ch.norm, &ch.idx), stats)
}
