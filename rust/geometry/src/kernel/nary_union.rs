// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared N-ary arrangement and an explicit coordinate-preserving candidate.

use super::{mesh_to_tris, orient_outward, tris_to_mesh};
use crate::kernel::{
    arrangement::{union_all, Tri},
    budget,
    plane_weld::promote_operands_mutually,
};
use crate::Mesh;

/// Retain the existing mutually reconciled N-ary union. Cutter consumers
/// validate this result before deciding whether another candidate is needed.
pub fn union_many(meshes: &[&Mesh]) -> Mesh {
    arrange(meshes, true)
}

/// Omit cross-operand promotion, preserving the supplied coordinates apart
/// from the kernel's existing snap and f32 emission. Used only by consumers
/// that validate the union through their actual subtraction (#3925).
pub(crate) fn union_many_preserving_coordinates(meshes: &[&Mesh]) -> Mesh {
    arrange(meshes, false)
}

fn arrange(meshes: &[&Mesh], reconcile: bool) -> Mesh {
    budget::begin();
    if budget::tripped() {
        return Mesh::new();
    }
    let mut operands: Vec<Vec<Tri>> = meshes.iter().map(|m| mesh_to_tris(m)).collect();
    if reconcile {
        promote_operands_mutually(&mut operands);
    }
    let operands: Vec<Vec<Tri>> = operands.into_iter().map(orient_outward).collect();
    let refs: Vec<&[Tri]> = operands.iter().map(Vec::as_slice).collect();
    let (out, _) = union_all(&refs);
    if budget::tripped() {
        Mesh::new()
    } else {
        tris_to_mesh(&out)
    }
}

#[cfg(test)]
#[path = "nary_union_tests.rs"]
mod tests;
