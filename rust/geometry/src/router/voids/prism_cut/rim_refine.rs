// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Rim-sliver refinement of a final analytic cut (#1007).

use super::finish;
use crate::csg::ConsolidationBoundary;
use crate::Mesh;

/// Refine the high-aspect corner slivers a prism cut leaves at an opening rim
/// (a far-corner triangle fanned to two rim vertices, the roof-slope chamfer
/// the exact path also produces and repairs), when that makes the mesh better.
///
/// SCOPED to the committed cutters' padded boxes: every rim sliver touches its
/// cutter's box, and the unscoped pass also bisected the host's own authored
/// long-thin faces (the Holter 4.1.x regression). The scoped pass returns
/// nothing when no in-region sliver fires, the common clean-cut case, and then
/// the probe clean and the closure audits are not paid for.
///
/// Two tests stand between a refinement and the cut:
///
/// - Closure. On a hairline-tolerated output the lockstep split can see just
///   one side of an overlapping chain pair and amplify the sub-grid mismatch,
///   and split slivers can fall below the clean-degenerate grid. So the result
///   must be STRICTLY closed and stay so once cleaned
///   (`finish::can_adopt_refinement`).
/// - Quality. The split triangles must leave the mesh better by the census's
///   sliver measure (`facet_weld::improves`).
///
/// A refinement that fails either leaves the cut its own triangles,
/// canonicalised, when that passes the closure test, and untouched when not.
///
/// Not a replacement for the router's source-triangle cleanup, and no promise
/// of hygienic output: `finish_cut` closure-audits afterwards and prefers a
/// clean result, but may return its explicit compatibility result (#4797).
pub(super) fn refine_rim_slivers(
    out: Mesh,
    boxes: &[([f64; 3], [f64; 3])],
    boundary: ConsolidationBoundary,
) -> Mesh {
    let adoptable = |candidate: &Mesh| finish::can_adopt_refinement(boundary, candidate);
    let Some(refined) = crate::facet_weld::refine_within_to_fixpoint(&out, boxes) else {
        return out;
    };
    let plain = crate::facet_weld::canonicalised(&out);
    if crate::facet_weld::improves(&refined, &plain) && adoptable(&refined) {
        refined
    } else if adoptable(&plain) {
        plain
    } else {
        out
    }
}
