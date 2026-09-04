// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The two union entry points, moved out of `csg/mod.rs` (which sits at its
//! module-size budget) so the pair-vs-batch split the #3440 audit needs is
//! visible in one place: `union_pair` does the work and records nothing,
//! `union_mesh` and `union_meshes` each audit — and, under `csg_topology_gate`
//! (step 2), gate — exactly the mesh they return, and only when a boolean
//! actually ran: an empty operand short-circuits both of them past the audit.

use super::{record_csg_op, ClippingProcessor};
use crate::diagnostics::{BoolFailureReason, BoolOp};
use crate::error::Result;
use crate::mesh::Mesh;

/// What [`ClippingProcessor::union_pair`] handed back, so its callers can tell
/// a boolean RESULT from a mesh no boolean produced.
///
/// The #3440 audit and both accept gates speak about kernel output. Three
/// different things come out of `union_pair` looking like a union: an operand
/// passed through because the other was empty, the plain merge the
/// kernel-failure path returns (already recorded as `KernelOutputInvalid`),
/// and an actual kernel result. Only the last is a boolean's work, and the
/// returned `Mesh` alone cannot say which it is.
enum UnionOutcome {
    /// The exact kernel produced this mesh and it passed `validate_mesh`. The
    /// audit and the gates speak about it.
    Kernel(Mesh),
    /// No boolean produced this mesh: an operand handed straight back, or the
    /// merge that replaced a discarded kernel result. Not audited, not gated.
    PassThrough(Mesh),
}

impl ClippingProcessor {
    /// Union two meshes together using CSG boolean operations on the
    /// pure-Rust exact kernel.
    ///
    /// Empty operands are handled silently — they have a unique correct answer.
    /// "Silently" includes the #3440 audit, and so does the kernel-failure
    /// merge: both come back as [`UnionOutcome::PassThrough`], which this does
    /// not audit. Auditing a mesh no boolean produced blames this union for
    /// topology it did not create, and under `csg_manifold_gate` that lands a
    /// spurious `NonManifoldRejected` in both the public failure list and the
    /// census the flip decision is read off — on top of the
    /// `KernelOutputInvalid` the same incident already recorded.
    pub fn union_mesh(&self, mesh_a: &Mesh, mesh_b: &Mesh) -> Result<Mesh> {
        match self.union_pair(mesh_a, mesh_b)? {
            UnionOutcome::PassThrough(mesh) => Ok(mesh),
            UnionOutcome::Kernel(mesh) => Ok(self.audit_and_gate_union(mesh, || {
                let mut merged = mesh_a.clone();
                merged.merge(mesh_b);
                merged
            })),
        }
    }

    /// [`Self::union_mesh`] minus the #3440 audit, so `union_meshes` can drive
    /// it in a loop and audit only the mesh it hands back.
    ///
    /// Returns WHICH of the two kinds of mesh it produced, because that is the
    /// fact the audit turns on and this is the only place that knows it. The
    /// caller cannot re-derive it: "was an operand empty" misses the
    /// kernel-failure merge, and inspecting the returned mesh cannot tell a
    /// merge from a kernel result at all.
    fn union_pair(&self, mesh_a: &Mesh, mesh_b: &Mesh) -> Result<UnionOutcome> {
        record_csg_op(1, mesh_a.triangle_count(), mesh_b.triangle_count());
        if mesh_a.is_empty() {
            return Ok(UnionOutcome::PassThrough(mesh_b.clone()));
        }
        if mesh_b.is_empty() {
            return Ok(UnionOutcome::PassThrough(mesh_a.clone()));
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
            return Ok(UnionOutcome::PassThrough(merged));
        }
        Ok(UnionOutcome::Kernel(result))
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
        // Did a BOOLEAN produce the mesh this is about to hand back? Only the
        // LAST fold step decides that: an earlier merge fallback is an operand
        // to the step after it, and that step's kernel output is a kernel
        // output. `false` also covers "no pair ever met", where `result` is a
        // pass-through clone of the caller's own mesh.
        let mut returned_by_kernel = false;
        for mesh in meshes {
            if mesh.is_empty() {
                continue;
            }
            if !found_first {
                result = mesh.clone();
                found_first = true;
                continue;
            }
            match self.union_pair(&result, mesh)? {
                UnionOutcome::Kernel(m) => {
                    result = m;
                    returned_by_kernel = true;
                }
                UnionOutcome::PassThrough(m) => {
                    result = m;
                    returned_by_kernel = false;
                }
            }
        }
        // Audit only a mesh a boolean actually produced. Blaming a union that
        // never ran — or one whose result was already discarded and recorded as
        // `KernelOutputInvalid` — for the topology of the merge that replaced it
        // is the same noise as auditing an intermediate the caller never sees.
        //
        // Under either gate feature, a rejected fold has no single operand
        // pair to fall back to — `result` folded however many meshes ran —
        // so the fallback is the plain merge of every non-empty input, the
        // N-way generalisation of `union_pair`'s own 2-way fallback above.
        if returned_by_kernel {
            result = self.audit_and_gate_union(result, || {
                let mut merged = Mesh::new();
                for mesh in meshes.iter().filter(|m| !m.is_empty()) {
                    merged.merge(mesh);
                }
                merged
            });
        }
        Ok(result)
    }

    /// Both callers reach this only with a [`UnionOutcome::Kernel`] mesh, which
    /// `union_pair` has already run `validate_mesh` over. The check is repeated
    /// anyway rather than asserted away: the closure predicates index
    /// `positions` straight through `indices`, so an out-of-bounds index here
    /// would abort the process rather than be recorded, and that is too sharp
    /// an edge to leave resting on a caller's discipline. It is diagnostic-only
    /// either way — a mesh that failed it is still the legacy return value.
    ///
    /// #3440 steps 2 and 3: also the ONE place union gates. Each gate inside
    /// `accept_gates_reject` records on its own hit, so when one does this
    /// returns `fallback()` WITHOUT also calling `record_topology_tear` —
    /// recording both would double-count the same tear as two unrelated
    /// incidents. Without either gate feature `accept_gates_reject` is the
    /// zero-cost always-`false` stub, so this is exactly the step-1 behaviour
    /// above, unchanged.
    fn audit_and_gate_union(&self, mesh: Mesh, fallback: impl FnOnce() -> Mesh) -> Mesh {
        if !self.validate_mesh(&mesh) {
            return mesh;
        }
        if self.accept_gates_reject(BoolOp::Union, &mesh) {
            return fallback();
        }
        self.record_topology_tear(BoolOp::Union, &mesh);
        mesh
    }
}
