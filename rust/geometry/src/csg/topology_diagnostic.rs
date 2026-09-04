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
use crate::router::voids::prism_cut::closure_checks::{
    closed_or_hairline, directed_closed, edge_multiplicity_defects,
};

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

    /// #3440 step 2: the feature-gated accept/reject signal `record_topology_tear`
    /// (above) deliberately withholds. Same predicate, same call-site
    /// discipline (the mesh the op is about to RETURN, never an intermediate),
    /// but on a torn mesh this records the dedicated
    /// [`BoolFailureReason::OpenTopologyRejected`] and returns `true` so the
    /// caller discards the kernel result and falls back exactly like an
    /// existing `KernelOutputInvalid` — the four call sites already have that
    /// fallback wired (`host_mesh.clone()` / `Mesh::new()` / the plain merge),
    /// this just adds one more condition that reaches it.
    ///
    /// Gated behind the crate's own `csg_topology_gate` feature — NOT
    /// `debug_geometry` / `csg_capture` / `observability`. Those three are
    /// already live in production (the native server enables `observability`
    /// via `ifc-lite-processing`; see `geometry/Cargo.toml`), so wiring a
    /// behaviour change through any of them would flip real hosts today. This
    /// feature is enabled by nothing downstream — no crate in the workspace
    /// turns it on — so it exists solely for `cargo test/build --features
    /// csg_topology_gate` runs the census/CI can opt into deliberately.
    ///
    /// Off the default build path ENTIRELY, not merely a runtime flag checked
    /// after the kernel work: the `#[cfg(not(...))]` twin below is the only
    /// body compiled in without the feature, and it never touches `mesh` —
    /// zero cost, not "flag checked, still computed".
    #[cfg(feature = "csg_topology_gate")]
    pub(crate) fn topology_gate_reject(&self, op: BoolOp, mesh: &Mesh) -> bool {
        if mesh.is_empty() || directed_closed(mesh) || closed_or_hairline(mesh) {
            return false;
        }
        self.record_failure(op, BoolFailureReason::OpenTopologyRejected);
        true
    }

    /// Default-build twin of the above: always `false`, no closure predicate
    /// ever runs. See that function's doc for why this is a SEPARATE `cfg`
    /// body rather than one function with an internal `if cfg!(...)`.
    #[cfg(not(feature = "csg_topology_gate"))]
    #[inline(always)]
    pub(crate) fn topology_gate_reject(&self, _op: BoolOp, _mesh: &Mesh) -> bool {
        false
    }
    /// #3440 step 3: the ALWAYS-ON half of the accept gate.
    ///
    /// `topology_gate_reject` above stays behind `csg_topology_gate` because
    /// its predicate reads OPEN edges, and a tessellated host routinely
    /// carries those from T-junction subdivision alone — flipping it on would
    /// reroute a population this crate has documented as largely benign
    /// (`prism_cut.rs` accepts exactly that class at every one of its own
    /// gates). This one reads a strictly different defect class:
    /// [`edge_multiplicity_defects`], the per-edge UNSIGNED use count that a
    /// signed closure tally cannot represent at all.
    ///
    /// That distinction is the whole reason this can gate by default. A
    /// T-junction leaves edges used ONCE, which this predicate ignores. An
    /// edge used four times, or twice the same way round, is not something a
    /// differently-subdivided shared boundary can produce — it is a doubled
    /// skin, a fin, or a flipped neighbour. Neither `validate_mesh` (finite +
    /// in-bounds) nor `directed_closed` (signed, so 2-forward/2-reverse
    /// cancels to zero) can observe it, which is precisely the silent-accept
    /// this issue is about.
    ///
    /// Same call-site discipline as its siblings: run it on the mesh the op is
    /// about to RETURN, never an intermediate. On a hit it records
    /// [`BoolFailureReason::NonManifoldRejected`] and returns `true`, so the
    /// caller discards the kernel result and falls back exactly like an
    /// existing `KernelOutputInvalid` — un-cut host, empty mesh, or plain
    /// merge, whichever that site already does. Never an `Err`: the element
    /// keeps its geometry, it just keeps the UN-cut version, with a diagnostic
    /// saying so.
    pub(crate) fn manifold_gate_reject(&self, op: BoolOp, mesh: &Mesh) -> bool {
        if mesh.is_empty() {
            return false;
        }
        let defects = edge_multiplicity_defects(mesh);
        if defects.is_clean() {
            return false;
        }
        self.record_failure(
            op,
            BoolFailureReason::NonManifoldRejected {
                over_used: defects.over_used,
                same_direction: defects.same_direction,
            },
        );
        true
    }
}
