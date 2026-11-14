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
//! retry is kept only if it comes back strictly closed.

use super::dedup_cut_vertices;
use crate::csg::{ClippingProcessor, ConsolidationOutcome};
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
/// consolidated mesh is open.
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
    // Strictly closed, not just closed on the 1 mm grid.
    let retried = ClosureVerdict::for_mesh(&retry.mesh);
    if retried.is_directed_closed() {
        (retry, retried)
    } else {
        (first, verdict)
    }
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
