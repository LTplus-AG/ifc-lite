// SPDX-License-Identifier: MPL-2.0
//! Coaxial preprocessing, then first-member batches and sequential fallbacks.
use super::{CutContext, ExactTail, Flow};
use crate::Mesh;
use crate::router::voids::CutterKind;

impl ExactTail {
    pub(in crate::router::voids) fn run(
        &mut self, result: &mut Mesh, all_openings: &[&CutterKind], context: CutContext<'_>,
    ) {
        let CutContext { execution, clipper, wall_min, wall_max, .. } = context;
        // COAXIAL FOOTPRINT-UNION for OVERLAPPING clusters (issue #129, flag
        // `IFC_LITE_VOID_UNION`). Overlapping cutters can't join the disjoint batch
        // below and otherwise fall to the O(N) sequential exact path; this fuses
        // each overlapping coaxial cluster into disjoint re-extruded prisms and cuts
        // them in one `subtract_mesh_many`. See `coaxial_union`. Marks consumed
        // openings so the batch + sequential loops skip them; a cluster that fails
        // any guard is left unconsumed for the exact path (never worse than exact).
        execution.coaxial_union_prepass(
            result,
            all_openings,
            &mut self.consumed,
            &mut self.host_mutated,
            clipper,
        );

        self.plan_groups(execution, result, all_openings, wall_min, wall_max);

        for (opening_idx, opening) in all_openings.iter().enumerate() {
            if self.consumed[opening_idx] {
                continue; // already handled by a batched disjoint group
            }
            // Batched group cut, attempted ONCE, inline at the group's first
            // member — so the relative order of batched vs sequential cutters
            // matches the pure sequential pass. On any failure (admission,
            // guards, or the kernel's conformity gate) the members fall back
            // to the per-opening sequential path below.
            if self.cut_group(result, all_openings, clipper, opening_idx) {
                continue; // this opening was handled with its group
            }
            if let Flow::Stop = self.cut_one(result, opening, context) {
                break;
            }
        }

    }
}
