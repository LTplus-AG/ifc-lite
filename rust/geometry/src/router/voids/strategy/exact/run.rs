// SPDX-License-Identifier: MPL-2.0
//! Coaxial preprocessing, then first-member batches and sequential fallbacks.
use super::{CutContext, ExactTail, Flow};
use crate::Mesh;

impl ExactTail<'_> {
    pub(in crate::router::voids) fn run(mut self, context: CutContext<'_>) -> (Mesh, bool) {
        let result = &mut self.host;
        let all_openings = &self.all_openings;
        let state = &mut self.state;
        let CutContext { execution, clipper, wall_min, wall_max, .. } = context;
        for pass in PREPASSES {
            match pass {
                Prepass::CoaxialUnion => execution.coaxial_union_prepass(
                    result, all_openings, &mut state.consumed, &mut state.host_mutated, clipper,
                ),
            }
        }
        state.plan_groups(execution, result, all_openings, wall_min, wall_max);
        'openings: for (opening_idx, opening) in all_openings.iter().enumerate() {
            if state.consumed[opening_idx] { continue; }
            let mut fallback = None;
            for pass in OPENING_PASSES {
                match pass {
                    OpeningPass::DisjointBatch => {
                        if state.cut_group(result, all_openings, clipper, opening_idx) {
                            continue 'openings;
                        }
                    }
                    OpeningPass::SequentialExact => match state.cut_one(result, opening, context) {
                        Flow::Next => continue 'openings,
                        Flow::Stop => break 'openings,
                        Flow::Fallback(attempt) => fallback = Some(attempt),
                    },
                    OpeningPass::Fallback635 => {
                        if let Some(attempt) = fallback.take() {
                            state.fallback_635(result, context, attempt);
                        }
                    }
                }
            }
        }
        (self.host, self.state.host_mutated)
    }
}

// Coaxial union is a whole-set prepass. Batch and sequential attempts remain
// interleaved at each opening, and only an eligible sequential miss reaches635.
// Changing either list is a geometry/diagnostic policy change, not refactoring.
enum Prepass { CoaxialUnion }
const PREPASSES: [Prepass; 1] = [Prepass::CoaxialUnion];
enum OpeningPass { DisjointBatch, SequentialExact, Fallback635 }
const OPENING_PASSES: [OpeningPass; 3] = [
    OpeningPass::DisjointBatch, OpeningPass::SequentialExact, OpeningPass::Fallback635,
];
