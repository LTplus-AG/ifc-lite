// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Intra-mesh vertex weld + index dedup, applied at the mesh SOURCE.
//!
//! The faceted-brep mesher emits geometry per `IfcFace` with no cross-face
//! vertex sharing, so a closed shell duplicates every shared corner once per
//! incident face (~3-6x). That is the direct cause of the ~8x-larger GLBs the
//! reference-extractor comparison flagged on structural (faceted-brep-heavy)
//! models, and it inflates every downstream mesh (render, export, analysis).
//! This weld collapses vertices that share an identical f32 position AND a
//! coinciding (quantized) normal into one, then remaps indices.
//!
//! It runs once, at the single per-element mesh funnel `build_mesh_data`
//! (`ifc_lite_processing::element`), so every element — voided or not, faceted
//! brep or swept solid — arrives welded in its `MeshData`. Because it keys on
//! the quantized normal, coincident positions carrying DISTINCT normals (a
//! crease / cube corner) stay split, so flat shading is preserved (a cube keeps
//! its 24 vertices). World triangles and the world AABB are preserved exactly
//! (welded vertices sit at identical positions; triangle count and winding are
//! unchanged).
//!
//! ## Per-vertex attributes
//!
//! `MeshData`'s only per-vertex-parallel arrays are `positions`, `normals`, and
//! (for textured meshes, #961) `uvs`. The weld carries the UVs through the same
//! remap so they stay 1:1 with the welded positions, AND folds the (quantized)
//! UV into the merge key: two vertices at the same position + normal but
//! DIFFERENT UVs are a legitimate texture SEAM and must stay split, or the
//! texture mapping tears. An untextured mesh (`uvs == None`) contributes a
//! constant `(0, 0)` UV, so its key is effectively position + normal and it gets
//! the full weld benefit (steel faceted breps unaffected).
//!
//! Deterministic and cross-arch (native == wasm32): first-seen order over the
//! original vertex array, integer keys (f32 position bits + a quantized normal +
//! a quantized UV), no float comparison, FMA-free.

use rustc_hash::FxHashMap;
use std::cell::RefCell;

/// Normal quantization grid: components are multiplied by this and rounded to an
/// integer before keying. The shared grid also used by [`crate::facet_weld`]'s
/// `NORMAL_QUANT` and the `consolidate_coplanar` grid, so the weld merges
/// exactly the f32-jittered coplanar normals while keeping any real crease
/// (normals that differ by more than ~1e-3 in a component) split.
use crate::grid::NORMAL_QUANT_F32 as NORMAL_QUANT;

/// UV quantization grid (~0.001 texel-fraction resolution). Coarse enough to
/// merge f32 UV jitter on a shared corner, far finer than any real texture seam
/// (a seam jumps the UV by a large fraction of the atlas), so seams stay split.
const UV_QUANT: f32 = 1.0e3;

/// Vertex identity key: exact position bits + quantized normal + quantized UV.
type VKey = (u32, u32, u32, i32, i32, i32, i32, i32);

#[inline]
fn vkey(p: &[f32], n: &[f32], uv: [f32; 2]) -> VKey {
    (
        p[0].to_bits(),
        p[1].to_bits(),
        p[2].to_bits(),
        (n[0] * NORMAL_QUANT).round() as i32,
        (n[1] * NORMAL_QUANT).round() as i32,
        (n[2] * NORMAL_QUANT).round() as i32,
        (uv[0] * UV_QUANT).round() as i32,
        (uv[1] * UV_QUANT).round() as i32,
    )
}

/// Per-worker reusable scratch for [`weld_indexed`]'s INTERNAL buffers, cleared
/// (never freed) between meshes. The output buffers (`out_pos`/`out_nrm`/…) still
/// allocate (they escape to the caller); only the transient `map`/`remap`/
/// `first_vert` — allocated and dropped per element by the pre-pool code — are
/// pooled. BYTE-IDENTICAL: `map` is only `.get()`/`.insert()`-ed, never iterated
/// (so its bucket count / residual capacity can't reach the output); `remap` is
/// fully overwritten; `first_vert` is refilled by push in first-seen order and
/// iterated in push order. A cleared, reused buffer replays the identical fill.
#[derive(Default)]
struct WeldScratch {
    map: FxHashMap<VKey, u32>,
    remap: Vec<u32>,
    first_vert: Vec<u32>,
}

thread_local! {
    /// One scratch per rayon worker (and the main / wasm single thread): a
    /// `thread_local!`, not the shared worker-slot pattern, since these LEAF buffers
    /// never cross a crate boundary, need no lock, and work when
    /// `rayon::current_thread_index()` is `None`. Re-entrancy is TAKE / put-back (the
    /// `RefCell` borrow is never held across the hash pass), so a re-entrant call
    /// mints a fresh scratch rather than panicking — though `weld_indexed` runs no
    /// rayon and cannot re-enter on the same thread.
    static WELD_SCRATCH: RefCell<Option<WeldScratch>> = const { RefCell::new(None) };
}

/// Weld `positions`/`normals` (3 floats per vertex, equal length), optional
/// `uvs` (2 floats per vertex), and remap `indices`.
///
/// Returns `Some((positions, normals, uvs, indices))` ONLY when at least two
/// vertices actually merged; `uvs` is `Some` iff the input `uvs` was, always
/// 1:1 with the welded positions. Returns `None` when nothing changes — a mesh
/// that is already welded / all-crease (a swept solid, an indexed mesher, a
/// flat-shaded cube), OR a malformed input (normals not matching positions,
/// empty, a UV array not 2-per-vertex, or an out-of-range index). In every
/// `None` case the identity remap would reproduce the input byte-for-byte, so
/// the caller keeps its ORIGINAL buffers and skips the copy: no per-element
/// reallocation on the (common) already-welded path, and a malformed input
/// stays invalid-but-present rather than panicking or being re-associated.
///
/// Because the decision is purely "did any key collide", the funnel stays
/// uniform — no per-geometry-type branching. The weld is idempotent: welding a
/// welded mesh returns `None`.
pub fn weld_indexed(
    positions: &[f32],
    normals: &[f32],
    uvs: Option<&[f32]>,
    indices: &[u32],
) -> Option<(Vec<f32>, Vec<f32>, Option<Vec<f32>>, Vec<u32>)> {
    let nverts = positions.len() / 3;
    let uv_len_ok = uvs.is_none_or(|u| u.len() == nverts * 2);
    if normals.len() != positions.len()
        || nverts == 0
        || !uv_len_ok
        || indices.iter().any(|&i| i as usize >= nverts)
    {
        return None; // malformed: caller keeps the (unvalidated) originals
    }

    // Take this worker's warm scratch (or mint one). The `.with` borrow is momentary
    // at both ends, never held across the hash pass (re-entrancy-safe); the scratch
    // is handed back on the single return path below. Disjoint `&mut` field bindings.
    let mut scratch = WELD_SCRATCH.with(|c| c.borrow_mut().take()).unwrap_or_default();
    let WeldScratch { map, remap, first_vert } = &mut scratch;

    // Single hash pass: assign each distinct key a first-seen id, record the source
    // vertex that minted it, and fill the remap. `first_vert` doubles as the merge
    // detector — same length as `nverts` ⇒ nothing collided, the remap is identity.
    // Clear (retain capacity) before use so no stale data leaks in; `remap` is resized
    // to all-zero (every slot is overwritten by `remap[v] = id` below).
    map.clear();
    map.reserve(nverts);
    remap.clear();
    remap.resize(nverts, 0u32);
    first_vert.clear();
    for v in 0..nverts {
        let p = &positions[v * 3..v * 3 + 3];
        let n = &normals[v * 3..v * 3 + 3];
        let uv = match uvs {
            Some(u) => [u[v * 2], u[v * 2 + 1]],
            None => [0.0, 0.0],
        };
        let id = match map.get(&vkey(p, n, uv)) {
            Some(&id) => id,
            None => {
                let id = first_vert.len() as u32;
                first_vert.push(v as u32);
                map.insert(vkey(p, n, uv), id);
                id
            }
        };
        remap[v] = id;
    }

    let unique = first_vert.len();
    let out = if unique == nverts {
        // Nothing merged: the identity remap reproduces the input exactly.
        None
    } else {
        // Merges happened: gather the first-seen vertex per id (byte-identical to
        // extending on first insert above) and remap the indices.
        let mut out_pos: Vec<f32> = Vec::with_capacity(unique * 3);
        let mut out_nrm: Vec<f32> = Vec::with_capacity(unique * 3);
        let mut out_uv: Vec<f32> =
            Vec::with_capacity(if uvs.is_some() { unique * 2 } else { 0 });
        for &fv in first_vert.iter() {
            let fv = fv as usize;
            out_pos.extend_from_slice(&positions[fv * 3..fv * 3 + 3]);
            out_nrm.extend_from_slice(&normals[fv * 3..fv * 3 + 3]);
            if let Some(u) = uvs {
                out_uv.extend_from_slice(&u[fv * 2..fv * 2 + 2]);
            }
        }
        let out_idx: Vec<u32> = indices.iter().map(|&i| remap[i as usize]).collect();
        Some((out_pos, out_nrm, uvs.map(|_| out_uv), out_idx))
    };
    // Field borrows have ended (NLL); hand the now-warm scratch back to this worker.
    WELD_SCRATCH.with(|c| *c.borrow_mut() = Some(scratch));
    out
}

#[cfg(test)]
#[path = "mesh_weld_tests.rs"]
mod tests;
