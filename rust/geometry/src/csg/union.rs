// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The two union entry points, moved out of `csg/mod.rs` (which sits at its
//! module-size budget) so the pair-vs-batch split the #3440 audit needs is
//! visible in one place: `union_pair` does the work and records nothing,
//! `union_mesh` and `union_meshes` each audit exactly the mesh they return.

use super::{record_csg_op, ClippingProcessor};
use crate::diagnostics::{BoolFailureReason, BoolOp};
use crate::error::Result;
use crate::mesh::Mesh;

impl ClippingProcessor {
    /// Union two meshes together using CSG boolean operations on the
    /// pure-Rust exact kernel.
    ///
    /// Empty operands are handled silently — they have a unique correct answer.
    pub fn union_mesh(&self, mesh_a: &Mesh, mesh_b: &Mesh) -> Result<Mesh> {
        self.union_pair(mesh_a, mesh_b)
            .inspect(|m| self.audit_returned_union(m))
    }

    /// [`Self::union_mesh`] minus the #3440 audit, so `union_meshes` can drive
    /// it in a loop and audit only the mesh it hands back.
    fn union_pair(&self, mesh_a: &Mesh, mesh_b: &Mesh) -> Result<Mesh> {
        record_csg_op(1, mesh_a.triangle_count(), mesh_b.triangle_count());
        if mesh_a.is_empty() {
            return Ok(mesh_b.clone());
        }
        if mesh_b.is_empty() {
            return Ok(mesh_a.clone());
        }

        // Pure-Rust exact kernel. On an empty/invalid kernel result
        // fall back to a plain merge (overlap not removed) + record the failure,
        // preserving the legacy never-Err contract.
        let raw_u = crate::kernel::mesh_bridge::union(mesh_a, mesh_b);
        let result = Self::consolidate_coplanar(raw_u);
        if result.is_empty() || !self.validate_mesh(&result) {
            self.record_failure(BoolOp::Union, BoolFailureReason::KernelOutputInvalid);
            let mut merged = mesh_a.clone();
            merged.merge(mesh_b);
            return Ok(merged);
        }
        Ok(result)
    }

    /// Union multiple meshes together
    ///
    /// Convenience method that sequentially unions all non-empty meshes.
    /// Skips empty meshes to avoid unnecessary CSG operations. The #3440
    /// audit runs ONCE, on the mesh handed back — driving `union_mesh` here
    /// would record a tear per intermediate the caller never sees.
    pub fn union_meshes(&self, meshes: &[Mesh]) -> Result<Mesh> {
        if meshes.is_empty() {
            return Ok(Mesh::new());
        }
        if meshes.len() == 1 {
            return Ok(meshes[0].clone());
        }
        // Start with first non-empty mesh
        let mut result = Mesh::new();
        let mut found_first = false;
        let mut unioned = false;
        for mesh in meshes {
            if mesh.is_empty() {
                continue;
            }
            if !found_first {
                result = mesh.clone();
                found_first = true;
                continue;
            }
            result = self.union_pair(&result, mesh)?;
            unioned = true;
        }
        // No pair ever met: `result` is a pass-through clone of the caller's
        // own mesh, and blaming a union that never ran for its topology is
        // the same noise as auditing an intermediate.
        //
        // `validate_mesh` again, because this is the one audit site whose mesh
        // has not just come through that check: every other one sits directly
        // under it, but `union_pair`'s merge fallback returns WITHOUT it, and
        // `directed_closed` indexes `positions` straight from `indices`, so a
        // caller mesh with an out-of-bounds index would abort the process
        // rather than be recorded.
        if unioned {
            self.audit_returned_union(&result);
        }
        Ok(result)
    }

    /// The pair fallback can return a plain merge of its operands.  Unlike a
    /// kernel result, that merge has not necessarily passed `validate_mesh`;
    /// check it before the closure predicates, which index positions through
    /// the mesh's untrusted indices.  This is diagnostic-only: the malformed
    /// result remains the legacy return value and the existing invalid-output
    /// record from `union_pair` remains the only failure record added there.
    fn audit_returned_union(&self, mesh: &Mesh) {
        if self.validate_mesh(mesh) {
            self.record_topology_tear(BoolOp::Union, mesh);
        }
    }
}
