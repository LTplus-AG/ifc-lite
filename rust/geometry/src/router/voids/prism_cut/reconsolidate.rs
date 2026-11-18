// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Consolidation of the analytic cut, with one welded retry when it opens a
//! cut that went in closed.
//!
//! The cut derives a crossing once per host triangle, so two host triangles
//! that meet at a point can leave two copies of it a few micrometres apart.
//! Where the host itself arrives with a sub-grid sliver missing (boolean
//! operands are cleaned by index only), the two copies bound a slit that runs
//! the height of a face. The consolidation's union then sees two regions that
//! touch at a point, keeps one copy as a corner of each, and the face across
//! the edge keeps neither: T-junctions a millimetre from the corner, on a cut
//! that read closed before.
//!
//! [`dedup_cut_vertices`] is the weld that reconciles those copies. It runs
//! after consolidation, in the finalizer, which is too late for this case.
//! Running it first on every cut moves two dozen hosts and costs one of them
//! a percent of its volume, so it stays where it is and is brought forward
//! only here: the consolidated cut is open, the raw one was not, and the
//! retry is kept only if it comes back strictly closed with the raw cut's
//! volume.
//!
//! When the retry is not kept either, the cut is kept as it was made, provided
//! it still finishes closed. Consolidation saves triangles; it is not allowed
//! to cost a closed cut. Without that the opening went on to the exact kernel
//! with the uncut host, which left a clipped wall torn
//! (`FM_ARC_DigitalHub` #138037: 9 open edges).

use super::checks::result_volume_within_bounds;
use super::{dedup_cut_vertices, finish_cut_verdict};
use crate::csg::{ClippingProcessor, ConsolidationBoundary, ConsolidationOutcome};
use crate::mesh::Mesh;
use crate::mesh_check::{ClosureVerdict, Degenerate, EdgeLedger, VertexKey};

/// Open edges on a 1 mm grid: coarser than the spread between the per-bucket
/// copies of one vertex, far finer than a real crack. A triangle the grid
/// collapses is skipped, not counted as open.
fn open_edges(mesh: &Mesh) -> usize {
    EdgeLedger::build(mesh, VertexKey::GridMul(1.0e3), Degenerate::SkipTriangle).unbalanced().count()
}

/// Consolidate `cut`, the raw analytic cut of `host`, and audit the result.
/// `raw` rebuilds the cut as it was handed in; it is called only when the
/// consolidated mesh is open, and is the result when no consolidation of it
/// stays closed.
pub(super) fn consolidate(
    cut: Mesh,
    host: &Mesh,
    raw: impl FnOnce() -> Mesh,
) -> (ConsolidationOutcome, ClosureVerdict) {
    let first = ClippingProcessor::consolidate_prism_cut(cut, host);
    let verdict = ClosureVerdict::for_mesh(&first.mesh);
    // A host stored about its own origin has its own seam pass after the
    // finalizer (`tjunction_close`, #5739), sized for that frame's weld; it
    // runs on the hairline result and is skipped for a closed one.
    if verdict.is_directed_closed() || host.origin != [0.0; 3] || open_edges(&first.mesh) == 0 {
        return (first, verdict);
    }
    let raw = raw();
    if open_edges(&raw) != 0 {
        return (first, verdict);
    }
    let retry = ClippingProcessor::consolidate_prism_cut(dedup_cut_vertices(&raw, host), host);
    // Strictly closed, not just closed on the 1 mm grid, and the same solid:
    // with no cutter volume to spend, the bound allows quantization only.
    let retried = ClosureVerdict::for_mesh(&retry.mesh);
    if retried.is_directed_closed() && result_volume_within_bounds(&raw, &retry.mesh, 0.0) {
        return (retry, retried);
    }
    // Neither consolidation kept the cut closed and whole. Consolidating is a
    // saving in triangles, not a correction: the cut as it was made stands,
    // provided it is still closed once finished, strictly and on the 1 mm
    // grid. Otherwise the opening goes to the exact kernel, as it did. The raw
    // cut carries no remote repair, so it is finished as an established one.
    let boundary = ConsolidationBoundary::Established;
    let finishes_closed = finish_cut_verdict(raw.clone(), host, boundary)
        .is_some_and(|(finished, directed)| directed && open_edges(&finished) == 0);
    if !finishes_closed {
        return (first, verdict);
    }
    let raw_verdict = ClosureVerdict::for_mesh(&raw);
    (ConsolidationOutcome { mesh: raw, boundary }, raw_verdict)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::{arrangement::box_mesh, mesh_bridge::tris_to_mesh};

    #[test]
    fn a_cut_that_consolidates_closed_is_never_rebuilt() {
        let cube = tris_to_mesh(&box_mesh([0.0; 3], [1.0; 3]));
        let (outcome, verdict) = consolidate(cube.clone(), &cube, || panic!("the raw cut is not needed"));
        assert!(verdict.is_directed_closed());
        assert_eq!(outcome.mesh.triangle_count(), 12);
    }

    #[test]
    fn a_cut_that_went_in_open_keeps_the_established_result() {
        // A cube missing one face: open before and after consolidation.
        let mut open = tris_to_mesh(&box_mesh([0.0; 3], [1.0; 3]));
        open.indices.truncate(open.indices.len() - 6);
        let expected = ClippingProcessor::consolidate_prism_cut(open.clone(), &open).mesh;
        let (outcome, verdict) = consolidate(open.clone(), &open, || open.clone());
        assert!(!verdict.is_directed_closed());
        assert_eq!(outcome.mesh.positions, expected.positions);
        assert_eq!(outcome.mesh.indices, expected.indices);
    }
}
