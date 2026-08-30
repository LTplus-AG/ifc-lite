// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Step 1 of #3440: record (never gate) when a mesh `validate_mesh` already
//! accepted fails the closure audit `validate_mesh` has no way to observe.
//! Split out of `csg/mod.rs` to keep the call sites there a one-line addition
//! each (module-size ratchet).

use super::ClippingProcessor;
use crate::diagnostics::{BoolFailureReason, BoolOp};
use crate::mesh::Mesh;
use crate::router::voids::prism_cut::closure_checks::{closed_or_hairline, directed_closed};

/// Message carried by the [`BoolFailureReason::KernelError`] record this
/// module emits.
///
/// Deliberately NOT a new `BoolFailureReason` variant: `BoolFailureReason` is
/// re-exported from the crate root and is not `#[non_exhaustive]`, so adding a
/// variant is a major break for `ifc-lite-geometry` (cargo-semver-checks
/// `enum_variant_added`) — a heavy price for a counter that changes no
/// geometry. `KernelError` is the crate's free-form catch-all and nothing else
/// in the crate emits it, so today every `KernelError` record IS an
/// open-topology accept.
///
/// This string is the CRATE-INTERNAL discriminator only. It reaches no
/// consumer: `BoolFailureReason::label()` maps every `KernelError(_)` to the
/// constant `"KernelError"`, and every export boundary carries the label, not
/// the payload (`router::diagnostics::first_failure_label`, `failuresByReason`,
/// the wasm console breakdown). So a downstream consumer telling this record
/// apart has "KernelError" and nothing else, which holds only while this
/// module stays the sole emitter. Step 2 of #3440, which makes the check gate,
/// is where a dedicated public variant earns its major and gives consumers
/// something stable to match on.
pub(crate) const OPEN_TOPOLOGY_MESSAGE: &str =
    "open topology: accepted result passed validate_mesh but failed the directed-edge closure audit (#3440 step 1 — informational, non-gating)";

impl ClippingProcessor {
    /// Run the shared closure audit on a mesh `validate_mesh` already
    /// accepted and, on a torn result, record a failure carrying
    /// [`OPEN_TOPOLOGY_MESSAGE`]. Does NOT change what the caller returns — the mesh already
    /// chosen is unaffected either way; this only adds a diagnostic record.
    ///
    /// The predicate is the analytic prism-cut path's REJECTION gate verbatim
    /// (`prism_cut.rs:2674`, `:2913`): `directed_closed` OR the hairline
    /// tolerance. `directed_closed` alone would record every T-junction
    /// subdivision mismatch, which `prism_cut.rs` documents as something
    /// "tessellated hosts routinely carry" and accepts at every gate — a census
    /// dominated by a class this crate already ruled benign cannot decide the
    /// step-2 flip set, and it would inflate the user-facing failure count.
    ///
    /// Call it on the mesh the op is about to RETURN, never on an
    /// intermediate: a record about a mesh the caller never sees is noise the
    /// census cannot correct for. In `subtract_mesh_many` that means once
    /// after the last chunk, so a rejected group (which returns the host
    /// un-cut before reaching it) still records nothing, as its contract says,
    /// and a group whose early chunk was torn but whose result is closed
    /// leaves no record contradicting the mesh handed back. `union_meshes`
    /// unions pair-by-pair for the same reason: it drives the un-audited
    /// `union_pair` and audits only the mesh it hands back.
    pub(crate) fn record_topology_tear(&self, op: BoolOp, mesh: &Mesh) {
        if !mesh.is_empty() && !directed_closed(mesh) && !closed_or_hairline(mesh) {
            self.record_failure(
                op,
                BoolFailureReason::KernelError(OPEN_TOPOLOGY_MESSAGE.to_string()),
            );
        }
    }
}
