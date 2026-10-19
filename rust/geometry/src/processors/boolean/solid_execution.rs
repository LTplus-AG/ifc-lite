// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Decoder-free numerical step for the solid/solid boolean policy. Inputs are
//! the already-meshed host and operand; source walking, half-spaces and
//! grouped polygonal cutters keep their own semantics.
//!
//! The exact kernel has no operand-size cap. The old unconditional
//! `SolidSolidDifferenceSkipped` short-circuit meant every CSG primitive cut
//! (issue #780 bath, any `IfcCsgSolid` with a solid cutter) silently rendered
//! as the uncut host even when the operands were trivially small.

use super::cut_heuristics::{cutter_below_skip_ratio, quality_skips_small_cuts};
use super::BooleanClippingProcessor;
use crate::diagnostics::BoolOp;
use crate::{ClippingProcessor, Mesh, Result, TessellationQuality};

/// The complete policy read by one solid/solid numerical step.
#[derive(Debug, Clone, Copy)]
pub(super) struct SolidBooleanPlan {
    /// `Difference`, `Union` or `Intersection`.
    pub(super) operator: BoolOp,
    pub(super) length_unit_scale: f64,
    pub(super) quality: TessellationQuality,
    pub(super) skip_small_cuts: bool,
}

impl SolidBooleanPlan {
    /// Apply the step to `first` (the host so far) and `second` (the meshed
    /// operand). The `bool` is true only when the result is empty because an
    /// operand was dropped and that loss is already on record.
    pub(super) fn evaluate(
        self,
        recorder: &BooleanClippingProcessor,
        first: Mesh,
        second: Mesh,
        second_loss_recorded: bool,
    ) -> Result<(Mesh, bool)> {
        if second.is_empty() {
            recorder.record_empty_operand(self.operator, second_loss_recorded);
            return Ok(if self.operator == BoolOp::Intersection {
                // Emptied by a dropped operand that is now on record.
                (Mesh::new(), true)
            } else {
                (first, false)
            });
        }
        // Small-cut skip: a cutter far smaller than its host (a steel
        // cope/notch, a small detail recess) costs a full exact subtract --
        // the dominant load-time cost on boolean-heavy steel -- for a
        // barely-visible change. Dropping it renders the host un-cut and
        // recovers Manifold-class load times. Enabled either by a preview
        // tessellation tier (Lowest/Low) OR by the per-build `skip_small_cuts`
        // field, which the viewer turns on WITHOUT dropping to a preview tier
        // so curves stay full-density while the tiny cuts are skipped (#1286).
        // With neither set (the default), EVERY cut runs.
        if self.operator == BoolOp::Difference
            && (quality_skips_small_cuts(self.quality) || self.skip_small_cuts)
            && cutter_below_skip_ratio(&first, &second)
        {
            return Ok((first, false));
        }
        let clipper = ClippingProcessor::with_unit_scale(self.length_unit_scale);
        match self.operator {
            BoolOp::Difference => {
                let outcome = clipper.subtract_operand(&first, &second);
                recorder.absorb_failures(clipper.take_failures());
                // A rejection keeps the host un-cut; any failure is on record above.
                Ok((outcome.into_mesh().unwrap_or(first), false))
            }
            BoolOp::Union => {
                let result = clipper.union_mesh(&first, &second);
                recorder.absorb_failures(clipper.take_failures());
                result.map(|m| (m, false))
            }
            BoolOp::Intersection => {
                let result = clipper.intersection_mesh(&first, &second);
                recorder.absorb_failures(clipper.take_failures());
                result.map(|m| (m, false))
            }
            // The spine step records and returns before an unknown operator
            // reaches here; keep the host rather than panic.
            BoolOp::Unknown => Ok((first, false)),
        }
    }
}
