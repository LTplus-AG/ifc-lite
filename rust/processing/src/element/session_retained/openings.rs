// SPDX-License-Identifier: MPL-2.0
//! Opening closure is authenticated against this product's sealed ledger.
//! Consumed-host effects remain provisional. No commit API exists while final
//! publication and source-bound removal protection policy are unimplemented.
use super::*;
impl<R: NumericalReceipt> RuntimeProductExecution<'_, R> {
    pub(super) fn authenticate_openings(&self, plan: &RetainedProductPlan) -> Result<(), RetainedExecutionError> {
        let Some(completion) = &plan.opening_completion else { return Ok(()); };
        if completion.product() != self.state.job.id { return Err(protocol("foreign opening product")); }
        for cut in completion.cuts() {
            self.resources.check().map_err(RetainedExecutionError::Stopped)?;
            let (_, receipt) = self.ledger.iter().find(|(value, _)| value.definition() == cut.output().definition())
                .ok_or_else(|| protocol("unsealed opening cut"))?;
            receipt.validate_live().map_err(protocol)?;
            let left = self.input(&cut.inputs()[0])?;
            let right = self.input(&cut.inputs()[1])?;
            let a = BooleanInput::new(left, &cut.inputs()[0])?;
            let b = BooleanInput::new(right, &cut.inputs()[1])?;
            // Use the same ordered, source-relative invocation validation as
            // acceptance; provenance metadata cannot turn an SDK Empty into permission.
            let runtime::ReceiptEvidence::Boolean { operation, left, right,
                world_from_left, world_from_right, world_from_evaluation, .. } = receipt.kind.evidence()
                else { return Err(protocol("opening receipt kind")); };
            let same = |a: &[f64; 16], b: &[f64; 16]| a.iter().zip(b).all(|(a,b)| a.to_bits() == b.to_bits());
            if operation != ifc_lite_geometry::BoolOp::Difference
                || left != a.realization.kind.object() || right != b.realization.kind.object()
                || !same(world_from_left, &a.frame) || !same(world_from_right, &b.frame)
                || !same(world_from_evaluation, cut.output().object_frame()) {
                return Err(protocol("foreign or swapped opening receipt"));
            }
            if cut.output().evaluated_empty() != Some(receipt.is_empty()) {
                return Err(protocol("opening outcome mismatch"));
            }
        }
        if plan.values.iter().all(LogicalRetainedValue::is_empty) {
            return Err(RetainedExecutionError::Unsupported(
                "authenticated opening Empty: source-bound whole-product protection policy unproved"));
        }
        Ok(())
    }
}
