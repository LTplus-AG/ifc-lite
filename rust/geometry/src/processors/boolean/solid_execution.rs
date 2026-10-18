// SPDX-License-Identifier: MPL-2.0
//! Decoder-free numerical execution for the existing solid/solid boolean policy.
//! Inputs are explicit polyhedral meshes; this is not authored-surface lowering.

use super::{BooleanClippingProcessor, cut_heuristics::{cutter_below_skip_ratio,
    quality_skips_small_cuts}};
use crate::{BoolOp, ClippingProcessor, Error, Mesh, Result, TessellationQuality};

/// The complete policy read by one solid/solid numerical step. Source walking,
/// half-spaces and grouped polygonal cutters retain their separate semantics.
#[derive(Debug, Clone, Copy)]
pub(crate) struct SolidBooleanPlan {
    pub operator: BoolOp,
    pub length_unit_scale: f64,
    pub quality: TessellationQuality,
    pub skip_small_cuts: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum SolidAdmission { Unknown, EmptySecond, SkippedSmallCut, Kernel }

impl SolidBooleanPlan {
    pub(super) fn admit(self, first: &Mesh, second: &Mesh) -> SolidAdmission {
        if self.operator == BoolOp::Unknown { return SolidAdmission::Unknown; }
        if second.is_empty() { return SolidAdmission::EmptySecond; }
        if self.operator == BoolOp::Difference
            && (quality_skips_small_cuts(self.quality) || self.skip_small_cuts)
            && cutter_below_skip_ratio(first, second)
        { return SolidAdmission::SkippedSmallCut; }
        SolidAdmission::Kernel
    }

    /// Execute through the production exact kernel and preserve its admission,
    /// rejection and one-record-per-loss behavior. The recorder owns diagnostics;
    /// no decoder, source bytes or transient processor is needed by this step.
    pub(crate) fn evaluate(
        self,
        recorder: &BooleanClippingProcessor,
        first: Mesh,
        second: Mesh,
        second_loss_recorded: bool,
    ) -> Result<(Mesh, bool)> {
        let admission = self.admit(&first, &second);
        self.evaluate_admitted(recorder, first, second, second_loss_recorded, admission)
    }

    pub(super) fn evaluate_admitted(self, recorder: &BooleanClippingProcessor,
        first: Mesh, second: Mesh, second_loss_recorded: bool,
        admission: SolidAdmission) -> Result<(Mesh, bool)> {
        if admission == SolidAdmission::Unknown {
            return Err(Error::geometry("Solid boolean execution requires a known operator"));
        }
        if admission == SolidAdmission::EmptySecond {
            recorder.record_empty_operand(self.operator, second_loss_recorded);
            return Ok(if self.operator == BoolOp::Intersection {
                (Mesh::new(), true)
            } else { (first, false) });
        }
        if admission == SolidAdmission::SkippedSmallCut {
            return Ok((first, false));
        }
        let clipper = ClippingProcessor::with_unit_scale(self.length_unit_scale);
        match self.operator {
            BoolOp::Difference => {
                let outcome = clipper.subtract_mesh(&first, &second);
                recorder.absorb_failures(clipper.take_failures());
                // The production admission rejection retains the uncut host.
                Ok((outcome.into_mesh().unwrap_or(first), false))
            }
            BoolOp::Union | BoolOp::Intersection => {
                let result = if self.operator == BoolOp::Union {
                    clipper.union_mesh(&first, &second)
                } else { clipper.intersection_mesh(&first, &second) };
                recorder.absorb_failures(clipper.take_failures());
                result.map(|mesh| (mesh, false))
            }
            BoolOp::Unknown => unreachable!("operator admitted above"),
        }
    }
}

#[cfg(test)]
mod tests;
