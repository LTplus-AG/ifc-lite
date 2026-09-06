// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #3923: the accept-gate-rejection decision for `apply_boolean_step`'s
//! single-cutter `IfcPolygonalBoundedHalfSpace` branch. Split out of
//! `mod.rs` (module-size ratchet) since it carries its own non-trivial
//! rationale, mirroring how `polygonal_prism.rs` already isolates
//! `subtract_checked`'s #3919 sibling logic.

use super::BooleanClippingProcessor;
use crate::csg::ClippingProcessor;
use crate::Mesh;

/// Outcome of the bounded-prism subtract for a single `IfcPolygonalBoundedHalfSpace`
/// cutter, as decided by [`BooleanClippingProcessor::resolve_single_cutter_subtract`].
pub(super) enum SingleCutterSubtract {
    /// The subtract succeeded and passed every check: use it (still subject
    /// to the caller's `guard_against_full_host_removal`).
    Clipped(Mesh),
    /// An accept-gate rejection inside a multi-cutter SEQUENTIAL chain: keep
    /// this one step's host un-cut rather than risk the unbounded fallback.
    KeepUncut,
    /// No usable bounded result: fall through to the caller's unbounded
    /// `clip_mesh_with_half_space`.
    FallThrough,
}

impl BooleanClippingProcessor {
    /// Subtract `bound_mesh` from `mesh` and decide how `apply_boolean_step`'s
    /// `IfcPolygonalBoundedHalfSpace` branch should react.
    ///
    /// `solo_step` is true when this is the ONLY node the caller's spine walk
    /// deferred to — a genuine single-PBHS-cutter DIFFERENCE (#3923's target
    /// shape, e.g. duplex.ifc's "Party Wall"). It is false when this is one
    /// of several nodes from a longer authored chain that couldn't be
    /// batched at any level and is now being applied one cutter at a time
    /// (House.ifc wall #2152, issue #960).
    ///
    /// `subtract_checked` (the #3919 helper `polygonal_prism.rs` already
    /// uses for the batched-chain path) folds in the accept-gate check: a
    /// gate rejection hands `mesh` back UN-CUT — the identical shape
    /// `subtract_mesh` uses for "nothing to cut here" — which
    /// `difference_result_looks_degenerate` cannot tell apart (an unchanged
    /// mesh is trivially non-degenerate relative to itself). Pre-#3923 this
    /// branch accepted that un-cut host as the final clip result instead of
    /// falling through to its own more-robust `clip_mesh_with_half_space`
    /// fallback.
    ///
    /// But that fallback is only a strict SUPERSET of the bounded cut — it
    /// is exactly correct when the polygon already covers the host's full
    /// projected cross-section (duplex.ifc "Party Wall"), and an OVER-cut
    /// otherwise, removing material a partial cutter's polygon never
    /// intended to touch. A roof/trim cutter that is only ONE of several
    /// sequential steps is rarely full-cross-section, so escalating to the
    /// unbounded clip there is unsafe: measured on House.ifc wall #2152
    /// under `csg_topology_gate`, falling through at its first (innermost)
    /// cutter reads max Z 3686 mm against its 7325 mm bar, while keeping
    /// that one step's un-cut host — an adjacent cutter in the same
    /// sequential chain typically covers the same material — reads 7325 mm,
    /// matching IfcOpenShell. So a gate rejection defers to
    /// [`SingleCutterSubtract::KeepUncut`] when `!solo_step`, and only the
    /// true single-cutter case (no sibling cutter to compensate) escalates
    /// to [`SingleCutterSubtract::FallThrough`]. The pre-existing
    /// empty/kernel-error/degenerate triggers are unaffected by `solo_step`
    /// and always fall through, exactly as before #3923.
    pub(super) fn resolve_single_cutter_subtract(
        &self,
        mesh: &Mesh,
        bound_mesh: &Mesh,
        solo_step: bool,
    ) -> SingleCutterSubtract {
        let clipper = ClippingProcessor::new();
        let mark = clipper.failure_count();
        let checked = Self::subtract_checked(&clipper, mesh, bound_mesh);
        // Distinguish an accept-gate rejection from the pre-existing
        // empty/kernel-error/degenerate triggers BEFORE draining them, so
        // only the #3923 gate check takes the `solo_step` carve-out.
        let gate_rejected = checked.is_none() && clipper.has_accept_gate_rejection_since(mark);
        self.absorb_failures(clipper.take_failures());
        if let Some(clipped) = checked {
            return SingleCutterSubtract::Clipped(clipped);
        }
        if gate_rejected && !solo_step {
            return SingleCutterSubtract::KeepUncut;
        }
        SingleCutterSubtract::FallThrough
    }
}
