// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Emit complete candidates and apply the established mesh-quality preference.
use super::{
    buckets::Buckets,
    complete_conformed_candidate,
    conform::{build_seam_map, conform_plans, count_open_boundary_edges_at, emit_plans},
    count_open_boundary_edges, count_spike_triangles,
    plans::Planned,
    source_boundary,
    supported_cells,
};
use crate::mesh::Mesh;
use nalgebra::Vector3;

// Phase C — today's output first. An already-watertight host pays nothing for
// the conform: phase B and the second triangulation are pure cost when there
// is no tear to close, and the accept bar below would reject them anyway.
//
// The bar is ALL-OR-NOTHING, and that is measured, not cautious: on the #098
// reveal wall conforming lowers the per-cut open-edge count on EVERY one of the
// seven sequential cuts (227 -> 144 on the last), yet each partially-conformed
// intermediate feeds the next kernel cut and the FINAL wall came out at 282
// unpaired edges against 42 for today's output. A partial conform trades a
// T-junction for a subdivided edge whose true neighbour across it did NOT get
// the same vertex; only a fully-closed host proves every insertion landed on a
// real seam. With the bar at zero that wall improves to 22 and dental_clinic
// #217 goes watertight (6 -> 0).
//
// Measured on the 0.1 mm grid, not the 1 mm default: a chorded seam deviates by
// ~µm, merges away at 1 mm, and would read as "closed" — which accepts a
// conform that is in fact still torn (that is exactly the 282 above).
// The seam map is built ONLY when today's output is torn. Recording every
// bucket's kept corners unconditionally cost +61% geometry time on
// ISSUE_129 (1014 -> 1634 ms) for a map that ~85% of hosts never consult.
pub(super) fn emit(planned: &mut Planned, buckets: &Buckets, supported: &supported_cells::Supported) -> Option<Mesh> {
    let Planned { plans, supported_bids, retained_cells } = planned;
    let (mut output, base_complete) = emit_plans(plans, false);
    supported_cells::append_mesh(&mut output, retained_cells);
    // A region that failed to triangulate is skipped, so an incomplete baseline
    // can be missing a whole closed component while still reading as watertight.
    // Consolidation's standing contract is "never worse than the raw kernel
    // output", so hand back the raw mesh rather than a known-lossy consolidation.
    if !base_complete {
        return None;
    }
    if count_open_boundary_edges_at(&output, 1.0e4) > 0 {
        let mut accepted = false;
        let seam = build_seam_map(plans);
        if conform_plans(plans, &seam) {
            // Preserve the original edges of retained cells and healthy folds.
            for plan in plans.iter_mut() {
                if supported_bids.contains(&plan.bid) { plan.raw_conformed = None; }
            }
            // `complete` is part of the bar, not a detail: a region that fails
            // to triangulate is skipped, and if it was its own closed component
            // the remainder still balances — so a watertight-LOOKING candidate
            // can be missing a whole surface. Reject unless every region landed.
            let raw_conformed = plans.iter().any(|plan| plan.raw_conformed.is_some());
            let (mut candidate, complete) = emit_plans(plans, true);
            supported_cells::append_mesh(&mut candidate, retained_cells);
            if let Some(candidate) =
                complete_conformed_candidate(candidate, complete, raw_conformed)
            {
                output = candidate;
                accepted = true;
            } else if raw_conformed {
                // Preserve the established region-only conform when a new raw
                // split does not pair exactly. This is the #3913 N-ary sweep
                // safety valve: raw additions may improve the 0.1 mm metric
                // while introducing an exact-coordinate tear.
                for plan in plans.iter_mut() {
                    plan.raw_conformed = None;
                }
                let (mut candidate, complete) = emit_plans(plans, true);
                supported_cells::append_mesh(&mut candidate, retained_cells);
                if let Some(candidate) =
                    complete_conformed_candidate(candidate, complete, false)
                {
                    output = candidate;
                    accepted = true;
                }
            }
        }
        // The established retries keep their output. Only a failed conform
        // tries the certified original source-boundary partition.
        if !accepted {
            if let Some(candidate) = source_boundary::build(plans, buckets) {
                let source_indices = candidate.indices.len();
                if let Some(candidate) = complete_conformed_candidate(candidate, true, true) {
                    // Cleanup must not erase a certified boundary or a whole
                    // closed component while leaving the remainder paired.
                    if candidate.indices.len() == source_indices
                        && crate::exact_topology::strict_closed_mesh(&candidate)
                        && super::preservation::public_weld_closed(&candidate)
                        && !supported_cells::has_uncertified_needle(&candidate, supported)
                    {
                        output = candidate;
                    }
                }
            }
        }
    }
    Some(output)
}

// WATERTIGHTNESS GUARD (curved / opening-dense wall hairline cracks). The
// per-bucket re-triangulation above treats each coplanar plane bucket
// independently. Where a FLAT bucket's boundary runs along a faceted surface
// — an opening reveal, a cap, the rim of a curved or offset-jittered wall —
// the i_overlay union + collinear simplify chords that boundary, dropping the
// facet-boundary vertices the abutting buckets keep. The result is open
// boundary edges + T-junctions at the cut seam that the raw kernel output
// (which is watertight) did NOT have = the white horizontal hairlines that
// shimmer under DoubleSide. Detect it directly and pick the better mesh by
// (open edges + spike triangles): when consolidation introduced open edges
// and the raw mesh is the cleaner one overall, return raw. A curved/offset-
// jittered host's raw is watertight and well-formed (raw wins -> crack gone);
// a host whose raw carries needle fans consolidation exists to merge keeps the
// consolidated mesh. Watertight, spike-free hosts (the overwhelming majority,
// incl. #780 bath and ordinary flat walls) have cons_open == 0 and return
// immediately -> byte-identical, determinism snapshots unmoved. The exact
// kernel (and `indirect_sign_manifest`) is untouched; this only repairs what
// the post-kernel consolidation drops.
// Cheap geometric pre-filter so the per-host open-edge scan (its hashmap is
// the WASM load cost, not the rare fallback) stays OFF the hot path for the
// ~13k ordinary box-like walls. A host can only have a chorded seam if it is
// FACETED: either NON-ORTHOGONAL plane pairs (a curved wall, a sloped gable
// roof clip — neither parallel nor perpendicular) or many PARALLEL offset
// buckets per normal direction (an f32-jittered opening-dense wall like the
// curved reception counter, distinct_normals=5 / 168 planes). A box wall has
// only axis-aligned planes and consolidates watertight -> skipped.
pub(super) fn prefer_raw_if_cleaner(
    mesh: &Mesh, mut output: Mesh, buckets: &Buckets, supported: &supported_cells::Supported,
) -> Mesh {
    let mut bnorms: Vec<Vector3<f64>> = Vec::new();
    for tris in buckets.values() {
        if let Some(t0) = tris.first() {
            if !bnorms.iter().any(|m| m.dot(&t0.normal).abs() > 0.99999) {
                bnorms.push(t0.normal);
            }
        }
    }
    let nonorthogonal = (0..bnorms.len()).any(|i| {
        ((i + 1)..bnorms.len()).any(|j| {
            let d = bnorms[i].dot(&bnorms[j]).abs();
            d > 0.01 && d < 0.9999 // angle in (~0.8°, ~89.4°)
        })
    });
    let offset_jittered = buckets.len() > 4 * bnorms.len().max(1);
    if nonorthogonal || offset_jittered {
        let cons_open = count_open_boundary_edges(&output);
        if cons_open > 0 {
            // Invariant: `mesh` is kernel output (every `consolidate` caller is
            // pub(crate) and passes tris_to_mesh / union output), so its indices
            // are in range; the counters index unchecked (#7677, KERNEL-28).
            let raw_bad = count_open_boundary_edges(mesh) + count_spike_triangles(mesh);
            let cons_bad = cons_open + count_spike_triangles(&output);
            // Healthy fold retention cannot make quality preference restore
            // unrelated needles, including in its thin-cell-empty baseline.
            // Without a retained fold, keep the existing thin-cell policy.
            if raw_bad < cons_bad && (supported.folded_buckets.is_empty()
                || !supported_cells::has_uncertified_needle(mesh, supported)) {
                output = mesh.clone(); // Preserve all raw metadata and plane tags.
            }
        }
    }
    output
}
