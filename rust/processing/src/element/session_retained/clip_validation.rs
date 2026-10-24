// SPDX-License-Identifier: MPL-2.0
//! Check immutable issued plane and sealed receipt before consuming the common reply.
use super::*;
use super::runtime::{NumericalReceipt, ReceiptEvidence};
use ifc_lite_geometry::{document::retained_plane::{NumericalOutcome, PlaneClipMode, PlaneSide},
    program::{RetainedClipMode, RetainedUnaryClip}};
pub(super) fn selectors(clip: &RetainedUnaryClip) -> (PlaneSide, PlaneClipMode) {
    (if clip.keeps_negative_side() { PlaneSide::Negative } else { PlaneSide::Positive },
     match clip.mode { RetainedClipMode::Difference => PlaneClipMode::Difference,
         RetainedClipMode::Intersection => PlaneClipMode::Intersection })
}
fn bits<const N: usize>(a: &[f64; N], b: &[f64; N]) -> bool {
    a.iter().zip(b).all(|(a,b)| a.to_bits() == b.to_bits())
}
pub(super) fn validate<R: NumericalReceipt>(expected: &RetainedPlanOperation, input: &BooleanInput<R>,
    receipt: &RuntimeRealization<R>, owner: &R::Domain, evidence: ReceiptEvidence<'_, R::Object>)
    -> Result<(), RetainedExecutionError> {
    let RetainedOperationKind::UnaryClip { clip, .. } = expected.kind() else { return Err(protocol("missing clip source")); };
    let ReceiptEvidence::UnaryClip { input: actual_input, output, plane, side, mode,
        world_from_evaluation, certificate, empty } = evidence else { return Err(protocol("missing clip evidence")); };
    input.realization.validate_live().map_err(protocol)?;
    if !input.realization.kind.belongs_to_domain(owner) { return Err(protocol("foreign clip input")); }
    if actual_input != input.realization.kind.object() || output != receipt.kind.object()
        || output == actual_input || (side, mode) != selectors(clip)
        || !bits(plane, &clip.local_plane) || !bits(world_from_evaluation, &clip.input_frame)
        || !bits(world_from_evaluation, &input.frame)
        || !bits(world_from_evaluation, expected.value().object_frame())
        || empty != receipt.is_empty() || empty != (certificate.outcome() == NumericalOutcome::Empty) {
        return Err(protocol("foreign clip plane, frame, input or outcome"));
    }
    Ok(())
}
