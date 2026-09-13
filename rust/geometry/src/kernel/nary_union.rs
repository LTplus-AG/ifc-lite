// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared N-ary arrangement and an explicit coordinate-preserving candidate.

use super::{mesh_to_tris, orient_outward, tris_to_mesh};
use crate::csg::ClippingProcessor;
use crate::kernel::{
    arrangement::{union_all, Tri},
    budget,
    plane_weld::promote_operands_mutually,
};
use crate::router::voids::prism_cut::closure_checks::directed_closed;
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

/// #3917: only a 3-operand union has a measured order-dependence (the
/// #3916-committed 882-configuration sweep is 7x7 corners x 3 `dz` x 6
/// orderings of exactly 3 operands; #3917's traced mechanism is specific to
/// `promote_operands_mutually` welding a THIRD operand against two already
/// reconciled with each other). Retrying every ordering is only attempted at
/// this exact N, so a 2- or 4+-operand union is completely unaffected by this
/// function existing.
const REORDER_SEARCH_OPERAND_COUNT: usize = 3;

/// #3917: cap the retry search to operand sets this small (total triangles
/// across all 3 operands), so a large real N-ary cutter union never pays for
/// up to 5 extra `arrange` attempts. `1_536` is generously above the 12
/// triangles-per-box, 36-triangle-total pinned #3913/#3917 fixture this
/// mechanism targets (simple box/prism cutters), while still bounding the
/// worst case: a large union already costs more than this search is worth,
/// and #3917's own measurements never exercised operands anywhere near this
/// size.
const MAX_REORDER_SEARCH_TRIS: usize = 1_536;

/// All 6 permutations of 3 array POSITIONS, applied to whatever order the
/// caller supplied. Because permuting a caller's own 3-element array through
/// every bijection of its OWN positions reaches every arrangement of the 3
/// physical operands regardless of what the caller's original order was
/// (permutation composition over a fixed 3-element set is the same group
/// whichever element you start from), this set is the caller-order-agnostic
/// version of `kernel::issue_3913_sweep_tests::ORDERINGS` — same 6 orderings,
/// expressed relative to the input array rather than to a fixed physical
/// labelling.
const REORDER_POSITIONS: [[usize; 3]; 6] = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
];

/// #3917: whether `mesh`, taken through the SAME `consolidate_coplanar` pass
/// every real `union_many` caller already applies (`mesh_bridge_tests`'s own
/// module doc names `consolidate_coplanar(union_many(..))` as the standing
/// combination; `coaxial_union3d.rs` and `coaxial_union.rs` both call it
/// immediately after `union_many`), comes back closed.
///
/// This is NOT redundant with checking `mesh` itself: #3914's investigation
/// on this exact code path measured a raw `union_many` output that was
/// already closed (0 unmatched edges) and had `consolidate_coplanar`
/// introduce the tear — plane-bucket boundary straddle, a different
/// mechanism to this issue's, but the SAME lesson: whether a candidate
/// ordering is actually good is only decidable after the same
/// post-processing a real caller runs, not on the raw kernel output alone.
fn survives_consolidation_closed(mesh: &Mesh) -> bool {
    if mesh.is_empty() {
        return false;
    }
    let consolidated = ClippingProcessor::consolidate_coplanar(mesh.clone());
    !consolidated.is_empty() && directed_closed(&consolidated)
}

fn arrange(meshes: &[&Mesh], reconcile: bool) -> Mesh {
    // One public union is one budgeted boolean operation. Retries below are
    // candidates for that same operation, so they must share its counter.
    budget::begin();
    if budget::tripped() {
        return Mesh::new();
    }
    let out = arrange_once(meshes, reconcile);
    if budget::tripped() {
        return out;
    }
    if !reconcile || meshes.len() != REORDER_SEARCH_OPERAND_COUNT {
        return out;
    }
    let total_tris: usize = meshes.iter().map(|m| m.indices.len() / 3).sum();
    if total_tris > MAX_REORDER_SEARCH_TRIS {
        return out;
    }
    // #3917: `promote_operands_mutually` walks operands in ARRAY order, and
    // which operand is welded first decides which pair of planes reconcile
    // before the third is touched (see that function's doc) — so which
    // physical operand the CALLER placed at index 0 can be the difference
    // between a closed union and a torn one, even though a closed result is
    // reachable for the same 3 physical operands under a different order.
    // Exhaustive measurement on issue #3917 ruled out replacing the walk
    // order with any single geometric sort key (position, centroid,
    // AABB-overlap, degree, centroid distance): every key tried either fails
    // to reproduce the ordering that reconciles a given configuration, or
    // reaches determinism only by giving up quality the current order
    // occasionally achieves. So this does not try to PREDICT the right
    // order — it recognises the wrong one the same way #3440's prism-cut
    // self-check already does in production (`directed_closed`, the
    // DIRECTED quantized closed-surface audit — strictly stronger than an
    // undirected 2-manifold check), and only then retries.
    //
    // Left untouched when `out` is already closed: this changes NOTHING for
    // a configuration this code already gets right (the #3916 sweep's other
    // 746 of 882 configurations included), so it carries none of the
    // triangulation-invariance / golden-fixture risk a change that always
    // re-picks among candidates would.
    if survives_consolidation_closed(&out) {
        return out;
    }
    for order in REORDER_POSITIONS.into_iter().skip(1) {
        let permuted = [meshes[order[0]], meshes[order[1]], meshes[order[2]]];
        let candidate = arrange_once(&permuted, reconcile);
        if survives_consolidation_closed(&candidate) {
            return candidate;
        }
    }
    // No ordering of these 3 operands reconciles: the tear is not an
    // ordering artefact (#3917's own diagnosis found orderings that DO
    // reconcile this issue's pinned fixtures; a configuration where none of
    // the 6 does is outside what this function can fix). Return the
    // caller's own order, unchanged, exactly as before this function
    // existed.
    out
}

fn arrange_once(meshes: &[&Mesh], reconcile: bool) -> Mesh {
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
