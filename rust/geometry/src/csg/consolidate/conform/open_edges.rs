// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Open-edge count for the conform accept bar, split out of `conform.rs` to keep
//! it under the module-size ratchet.

use crate::mesh::Mesh;
use rustc_hash::FxHashMap;

/// [`count_open_boundary_edges`] on an explicit merge grid. The 1 mm default hides
/// the T-junction the cross-bucket conform targets (a 0.1 mm-scale chord deviation
/// merges away), so the conform's accept/reject decision uses 0.1 mm — the same grid
/// the #098 / #217 measurements are taken on.
pub(in crate::csg) fn count_open_boundary_edges_at(mesh: &Mesh, scale: f64) -> usize {
    if mesh.positions.len() < 9 || mesh.indices.len() < 3 {
        return 0;
    }
    let q = |v: f32| (v as f64 * scale).round() as i64;
    let mut vid: FxHashMap<(i64, i64, i64), u32> = FxHashMap::default();
    let mut id_of = |i: usize| -> u32 {
        let k = (
            q(mesh.positions[i * 3]),
            q(mesh.positions[i * 3 + 1]),
            q(mesh.positions[i * 3 + 2]),
        );
        let next = vid.len() as u32;
        *vid.entry(k).or_insert(next)
    };
    let mut bal: FxHashMap<(u32, u32), i32> = FxHashMap::default();
    for tri in mesh.indices.chunks_exact(3) {
        let (a, b, c) = (
            id_of(tri[0] as usize),
            id_of(tri[1] as usize),
            id_of(tri[2] as usize),
        );
        for (x, y) in [(a, b), (b, c), (c, a)] {
            let (key, s) = if x < y { ((x, y), 1) } else { ((y, x), -1) };
            *bal.entry(key).or_insert(0) += s;
        }
    }
    bal.values().filter(|&&v| v != 0).count()
}
