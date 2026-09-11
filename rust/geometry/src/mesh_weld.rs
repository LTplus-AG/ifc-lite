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
//! It runs AT LEAST once per element, in the OBJECT frame, at the last moment
//! before the placement is baked in: [`weld_mesh`] from `apply_placement` and
//! [`weld_sub_mesh`] from `apply_submesh_placement`. Every element — voided or
//! not, faceted brep or swept solid, single-item or per-style sub-meshes —
//! therefore arrives welded in its `MeshData`. Some are welded a SECOND time,
//! post-bake, by [`weld`] called from `build_mesh_data`; its doc says which and
//! why. Because it keys on the quantized
//! normal, coincident positions carrying DISTINCT normals (a crease / cube
//! corner) stay split, so flat shading is preserved (a cube keeps its 24
//! vertices). Triangles and the AABB are preserved exactly (welded vertices sit
//! at identical positions; triangle count and winding are unchanged).
//!
//! ## Why the object frame, and not after the bake (#4103)
//!
//! The position part of the key is the raw f32 BIT PATTERN, so what the weld
//! merges depends on the magnitude of the coordinates it is handed. An f32 ULP
//! is ~6e-8 m at 0.5 m and ~2e-6 m at 30 m, so welding baked world coordinates
//! silently applies an epsilon that grows with the element's distance from the
//! origin, and welding the same source geometry at two different placements
//! merges two different sets of vertices.
//!
//! That broke a contract the pipeline depends on. Every occurrence of one
//! `IfcRepresentationMap` is a clone of ONE cached source mesh
//! (`router::mapped_item`), and every direct-solid `rep_identity` is a hash of
//! the mesh BEFORE placement (`router::processing::direct_rep_identity`), so
//! occurrences of one representation are meant to be bit-identical. A post-bake
//! weld rewrote each of them differently, and `instancing::collate_refs` refuses
//! a group whose members disagree on vertex count, so nothing ever collated:
//! ten armchairs sharing one `IfcRepresentationMap` shipped as ten full meshes
//! with vertex counts spread over 0.9%, and a cached Parquet artifact came out
//! three times the size of its own IFC.
//!
//! In the object frame the key no longer depends on the element's PLACEMENT, so
//! occurrences that differ only by where they were put weld identically.
//! Placement is rigid, so nothing that merges here would have failed to merge
//! after the bake for a geometric reason; only the accidental collisions go
//! away, and those were never intended.
//!
//! ## What this does NOT fix, measured
//!
//! Three things survive, all narrower than the bug above but none zero.
//!
//! A per-occurrence `IfcMappedItem` MappingTarget is baked in by
//! `router::mapped_item` BEFORE the mesh reaches `apply_placement`, so the weld
//! still sees target-transformed coordinates. Occurrences of one
//! `IfcRepresentationMap` whose targets differ by enough to move the f32
//! exponent still weld to different vertex counts, and `collate_refs` still
//! refuses that group. Measured on the `issue_4103_shared_map_buffer_identity`
//! fixture with the offsets moved from the placement into the target: 8/8/8
//! vertices when the placement varies (fixed), 8/4/4 when the target varies
//! (unfixed). Closing that means welding the cached source once, before the
//! target bake, and suppressing this weld for a mesh already welded — a
//! different change.
//!
//! The invariant this weld establishes — no two vertices sharing a (position
//! bits, quantized normal) key — holds in the frame the weld RAN in, not
//! necessarily in the world buffer that ships. A rigid placement can map two
//! vertices that are distinct in the object frame onto one f32 world position;
//! main merged those post-bake and this deliberately does not, because doing so
//! is exactly the placement-dependence being removed. Measured across the six
//! ara3d models: 104 of 15,211 shipped meshes carry at least one such duplicate
//! key, 494 of 1,093,616 vertices (0.68% and 0.045%); AC20-FZK-Haus has none.
//! A post-bake weld to remove them would reintroduce #4103.
//!
//! Welding is not the only stage that can make two occurrences disagree. Anything
//! that edits INDICES after the bake can too, and two do: `degenerate::clean`
//! compares a triangle height computed from f32 world positions against an
//! ABSOLUTE threshold, and `mesh_orient`'s adjacency grid is 10 um, which is
//! finer than the f32 world grid at 128 m and beyond (one ULP there is 1.5e-5 m).
//! Either can drop or reorient a different triangle in one occurrence than in
//! another, and `instancing::group` rejects a group whose members' index buffers
//! differ, which is the #4103 symptom reached by another route. UNMEASURED: this
//! was reasoned from the thresholds, not observed, and the fixture here uses
//! half-unit squares that cannot exercise it. Recorded so the next person
//! investigating a stubborn collation rejection does not assume the weld is the
//! only candidate.
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
        let id = *map.entry(vkey(p, n, uv)).or_insert_with(|| {
            let id = first_vert.len() as u32;
            first_vert.push(v as u32);
            id
        });
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

/// Weld a mesh's vertices in place, carrying `uvs` through the same remap and
/// returning them still 1:1 with the welded positions.
///
/// The one body behind every entry point here. It welds in whatever frame the
/// CALLER hands it, which is the decision the caller owns: see the module doc
/// for why the object frame is the right one for shared geometry, and what a
/// world-frame weld does to it.
///
/// Computes the normals first when a processor left them absent or short. The
/// key carries the quantized normal so a crease stays split, and `weld_indexed`
/// REFUSES a mesh whose normals do not match its positions 1:1 while signalling
/// that refusal with the same `None` it returns for "nothing collided" — so
/// without this, a silently skipped weld is indistinguishable from an
/// already-welded one, on every model. `calculate_normals` accumulates from the
/// triangle winding, so it needs only positions and indices and is happy in any
/// frame; `transform_mesh_world` then rotates the result into world space with
/// the positions. `build_mesh_data`'s call already guarantees 1:1 normals; the
/// two placement appliers do NOT, which is where this earns its keep.
///
/// `None` from `weld_indexed` leaves the mesh and the UVs untouched, with no
/// reallocation.
///
/// ## What legitimately calls this AFTER the bake
///
/// `element::build_mesh_data`, for geometry with no cross-occurrence identity to
/// protect (`instance_meta` absent). Two populations arrive there, and they are
/// not the same:
///
/// - Geometry BORN after the placement bake, which no earlier weld could have
///   reached: CSG void-cut output, layer slices, the #858 palette-split parts.
///   This is the weld that collapses the kernel's per-face output for them.
/// - Geometry already welded in the object frame that merely lost its
///   `instance_meta` on the way there — a void host (welded in `apply_placement`,
///   then cut, then nulled at `voids::process_element_with_voids`), a multi-item
///   element (`processing.rs` keeps the metadata only for a single instanceable
///   item), a textured face-set sub-mesh. For these it is a SECOND weld: cheap
///   when nothing new collides, but it CAN merge world-frame coincidences the
///   object frame kept apart, so their shipped buffers are placement-dependent in
///   the way the module doc describes. Accepted because none of them is shared.
///
/// Shared geometry must not reach that call site. `build_mesh_data` keeps it out
/// on `instance_meta`; #4122 is about recording the answer instead of inferring
/// it.
pub fn weld(mesh: &mut crate::Mesh, uvs: Option<Vec<f32>>) -> Option<Vec<f32>> {
    if mesh.normals.len() != mesh.positions.len() {
        crate::csg::calculate_normals(mesh);
    }
    match weld_indexed(&mesh.positions, &mesh.normals, uvs.as_deref(), &mesh.indices) {
        Some((positions, normals, welded_uvs, indices)) => {
            mesh.positions = positions;
            mesh.normals = normals;
            mesh.indices = indices;
            welded_uvs
        }
        None => uvs,
    }
}

/// Weld a `Mesh`'s source vertices in place, from `apply_placement`, where the
/// vertices are still in the object frame. See the module doc for why that is
/// the frame that matters.
///
/// Stamps `welded_in_object_frame` regardless of whether `weld` actually
/// merged anything: "already welded" and "nothing collided" both leave the
/// buffers valid for `build_mesh_data`'s guard (#4122), and `weld_indexed`'s
/// `None` is exactly the "no merge needed" signal, not a refusal to run.
pub(crate) fn weld_mesh(mesh: &mut crate::Mesh) {
    weld(mesh, None);
    mesh.welded_in_object_frame = true;
}

/// [`weld_mesh`] for a `SubMesh`, carrying its UVs through the same remap so they
/// stay 1:1 with the welded positions. The quantized UV is part of the key, so a
/// texture seam's coincident corners stay split (#961).
pub(crate) fn weld_sub_mesh(sub: &mut crate::SubMesh) {
    sub.uvs = weld(&mut sub.mesh, sub.uvs.take());
    sub.mesh.welded_in_object_frame = true;
}

#[cfg(test)]
#[path = "mesh_weld_tests.rs"]
mod tests;
