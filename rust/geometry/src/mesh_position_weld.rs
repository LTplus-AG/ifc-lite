// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `Mesh::welded_by_position`'s implementation, split from `mesh.rs` to keep
//! that file under the module-size ratchet. Distinct from `mesh_weld.rs`:
//! this is the position-quantized whole-mesh weld reachable from the public
//! API (`Mesh::welded_by_position`), not the placement-applier weld
//! (`weld_mesh`/`weld_sub_mesh`) that stamps `welded_in_object_frame`.

use super::Mesh;

/// Shared welding implementation backing `Mesh::welded_by_position`.
///
/// The dedupe key is `quantized_position` only. `average_normals=true`
/// accumulates contributing normals into the welded vertex and
/// renormalizes at the end.
pub(super) fn weld_impl(mesh: &Mesh, position_eps: f32, average_normals: bool) -> Mesh {
    use rustc_hash::FxHashMap;

    let n_verts = mesh.positions.len() / 3;
    if n_verts == 0 {
        return Mesh::new();
    }

    let has_normals = mesh.normals.len() == mesh.positions.len();
    let pos_scale = 1.0 / position_eps.max(f32::MIN_POSITIVE);
    let q_pos = |v: f32| -> i64 { (v * pos_scale).round() as i64 };

    // Dedupe key: quantized position only.
    type Key = [i64; 3];
    let mut canonical: FxHashMap<Key, u32> = FxHashMap::default();
    let mut old_to_new: Vec<u32> = Vec::with_capacity(n_verts);
    let mut new_positions: Vec<f32> = Vec::with_capacity(n_verts * 3);
    let mut new_normals: Vec<f32> = Vec::with_capacity(n_verts * 3);
    // For the average-normals path, accumulate the un-normalized sum so
    // a final pass can normalize. The sum buffer is parallel to
    // `new_positions` chunks.
    let mut normal_accum: Vec<(f64, f64, f64)> = Vec::new();
    if average_normals {
        normal_accum.reserve(n_verts);
    }

    for i in 0..n_verts {
        let px = mesh.positions[i * 3];
        let py = mesh.positions[i * 3 + 1];
        let pz = mesh.positions[i * 3 + 2];
        let (nx, ny, nz) = if has_normals {
            (
                mesh.normals[i * 3],
                mesh.normals[i * 3 + 1],
                mesh.normals[i * 3 + 2],
            )
        } else {
            (0.0, 0.0, 0.0)
        };
        let key: Key = [q_pos(px), q_pos(py), q_pos(pz)];

        if let Some(&new_idx) = canonical.get(&key) {
            old_to_new.push(new_idx);
            if average_normals {
                let slot = &mut normal_accum[new_idx as usize];
                slot.0 += nx as f64;
                slot.1 += ny as f64;
                slot.2 += nz as f64;
            }
        } else {
            let new_idx = (new_positions.len() / 3) as u32;
            canonical.insert(key, new_idx);
            old_to_new.push(new_idx);
            new_positions.push(px);
            new_positions.push(py);
            new_positions.push(pz);
            if has_normals {
                new_normals.push(nx);
                new_normals.push(ny);
                new_normals.push(nz);
            }
            if average_normals {
                normal_accum.push((nx as f64, ny as f64, nz as f64));
            }
        }
    }

    // For average-normals path: normalize the accumulated sums and
    // write them back over the first-vertex-wins values stored above.
    if average_normals && has_normals {
        new_normals.clear();
        new_normals.reserve(normal_accum.len() * 3);
        for (sx, sy, sz) in &normal_accum {
            let len_sq = sx * sx + sy * sy + sz * sz;
            if len_sq > 1e-24 {
                let inv = 1.0 / len_sq.sqrt();
                new_normals.push((*sx * inv) as f32);
                new_normals.push((*sy * inv) as f32);
                new_normals.push((*sz * inv) as f32);
            } else {
                // Degenerate accumulation (opposing normals cancelled);
                // fall back to a neutral up-Z so consumers don't see NaN.
                new_normals.push(0.0);
                new_normals.push(0.0);
                new_normals.push(1.0);
            }
        }
    }

    // Re-index triangles, dropping degenerates and out-of-bound input
    // triangles the same way `validate_indices` does so a malformed
    // input mesh weld-then-renders fine instead of panicking later.
    let mut new_indices: Vec<u32> = Vec::with_capacity(mesh.indices.len());
    for chunk in mesh.indices.chunks_exact(3) {
        let i0_raw = chunk[0] as usize;
        let i1_raw = chunk[1] as usize;
        let i2_raw = chunk[2] as usize;
        if i0_raw >= n_verts || i1_raw >= n_verts || i2_raw >= n_verts {
            continue;
        }
        let i0 = old_to_new[i0_raw];
        let i1 = old_to_new[i1_raw];
        let i2 = old_to_new[i2_raw];
        if i0 == i1 || i1 == i2 || i0 == i2 {
            continue;
        }
        new_indices.push(i0);
        new_indices.push(i1);
        new_indices.push(i2);
    }

    // Welding collapses / moves vertices, so carry the placement / frame
    // metadata (origin, rtc, #1474 capture) but drop instance_meta (the welded
    // mesh no longer matches its canonical rep) via `rebuilt_like`.
    mesh.rebuilt_like(new_positions, new_normals, new_indices)
}
