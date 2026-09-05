// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! N-ary arrangement and bounded near-coplanar repair (#3925).
//!
//! A weld moves input geometry. It is a repair candidate, not a preprocessing
//! step entitled to change an already closed union. Cutter consumers whose
//! volume bound assumes the supplied solid must use the coordinate-preserving
//! entry point: even a closed repaired union can over-cut a thin covering.

use super::{mesh_to_tris, orient_outward, tris_to_mesh};
use crate::kernel::{arrangement::{union_all, Tri}, budget, plane_weld::promote_operands_mutually};
use crate::{ClippingProcessor, Mesh};
use rustc_hash::FxHashMap;

/// Union all operands in one shared arrangement. Preserve a closed original
/// result; otherwise try one bounded near-coplanar reconciliation and accept it
/// only when its consolidated, emitted mesh passes the directed-edge audit.
/// Empty input or exhaustion during the original arrangement returns empty.
/// An unsuccessful repair leaves the completed original result unchanged.
pub fn union_many(meshes: &[&Mesh]) -> Mesh {
    let plain = union_many_preserving_coordinates(meshes);
    if budget::tripped() || meshes.len() < 2 || closed_after_consolidation(&plain) {
        return plain;
    }
    // One attempt, charged to the same operation and element budgets. Never
    // reset the counters to hide repair work or accept a partial arrangement.
    let repaired = arrange(meshes, true);
    if !budget::tripped() && closed_after_consolidation(&repaired) {
        repaired
    } else {
        plain
    }
}

/// Preserve the supplied geometry apart from the kernel's existing snap and
/// f32 emission. No cross-operand plane promotion. The 3D cutter path relies
/// on this contract when it accepts a union without an over-cut volume bound.
pub(crate) fn union_many_preserving_coordinates(meshes: &[&Mesh]) -> Mesh {
    budget::begin();
    arrange(meshes, false)
}

/// A coordinate-moving candidate for a bounded cutter consumer to validate
/// through its actual subtraction. It is not accepted merely by existing.
pub(crate) fn union_many_reconciled(meshes: &[&Mesh]) -> Mesh {
    budget::begin();
    arrange(meshes, true)
}

fn arrange(meshes: &[&Mesh], reconcile: bool) -> Mesh {
    if budget::tripped() { return Mesh::new(); }
    let mut operands: Vec<Vec<Tri>> = meshes.iter().map(|m| mesh_to_tris(m)).collect();
    if reconcile {
        promote_operands_mutually(&mut operands);
    }
    let operands: Vec<Vec<Tri>> = operands.into_iter().map(orient_outward).collect();
    let refs: Vec<&[Tri]> = operands.iter().map(Vec::as_slice).collect();
    let (out, _) = union_all(&refs);
    if budget::tripped() { Mesh::new() } else { tris_to_mesh(&out) }
}

fn closed_after_consolidation(mesh: &Mesh) -> bool {
    closed_boundary(&ClippingProcessor::consolidate_coplanar(mesh.clone()))
}

/// The existing N-ary regression audit's 1e-4 CALLER-UNIT position grid,
/// evaluated without allocating a welded copy or averaging its normals.
/// This certifies directed edge incidence at that resolution, not exact f32
/// closure, self-intersection freedom, volume, or equivalence of cutter extent.
fn closed_boundary(mesh: &Mesh) -> bool {
    let key = |i: u32| -> Option<[i64; 3]> {
        let p = (i as usize).checked_mul(3)?;
        let mut key = [0; 3];
        for (axis, value) in key.iter_mut().enumerate() {
            let q = (*mesh.positions.get(p.checked_add(axis)?)? * 10000.0).round();
            if !q.is_finite() || q.abs() >= i64::MAX as f32 { return None; }
            *value = q as i64;
        }
        Some(key)
    };
    let mut edges = FxHashMap::default();
    if !mesh.indices.len().is_multiple_of(3) { return false; }
    for t in mesh.indices.chunks_exact(3) {
        let (Some(a), Some(b), Some(c)) = (key(t[0]), key(t[1]), key(t[2])) else { return false; };
        for (a, b) in [(a, b), (b, c), (c, a)] {
            if a == b { return false; }
            let (edge, dir) = if a < b { ((a, b), 0) } else { ((b, a), 1) };
            edges.entry(edge).or_insert([0usize; 2])[dir] += 1;
        }
    }
    !edges.is_empty() && edges.values().all(|v| *v == [1, 1])
}

#[cfg(test)]
#[path = "nary_union_tests.rs"]
mod tests;
