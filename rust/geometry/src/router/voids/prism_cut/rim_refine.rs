// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Vertex canonicalization after a final analytic cut.

use super::finish;
use crate::csg::ConsolidationBoundary;
use crate::Mesh;

/// Check the committed cutter boxes for high-aspect rim triangles before
/// rebuilding the mesh. Adopt the result only if it passes the closure checks.
pub(super) fn canonicalize_rim_vertices(
    out: Mesh,
    boxes: &[([f64; 3], [f64; 3])],
    boundary: ConsolidationBoundary,
) -> Mesh {
    crate::facet_weld::canonicalize_cut_vertices(&out, Some(boxes))
        .filter(|candidate| finish::can_adopt_refinement(boundary, candidate))
        .unwrap_or(out)
}
