// SPDX-License-Identifier: MPL-2.0
//! The entire delivered batch is checked before the common reply is consumed.
use super::*;
use super::runtime::{NumericalReceipt, ReceiptEvidence};
fn same_frame(left: &[f64; 16], right: &[f64; 16]) -> bool {
    left.iter().zip(right).all(|(left, right)| left.to_bits() == right.to_bits())
}
impl<R: NumericalReceipt> RuntimeProductExecution<'_, R> {
    pub(super) fn validate_operation(&self, operation: &PendingRetainedOperation<R>,
        receipt: &RuntimeRealization<R>, owner: &R::Domain) -> Result<(), RetainedExecutionError> {
        receipt.validate_live().map_err(runtime_fault)?;
        if receipt.definition != operation.expected().value().definition() {
            return Err(protocol(ReceiptFailure::ForeignRetainedOutputDefinition));
        }
        if !receipt.kind.belongs_to_domain(owner) { return Err(protocol(ReceiptFailure::ForeignRuntime)); }
        if operation.expected().value().evaluated_empty().is_some_and(|empty| empty != receipt.is_empty()) {
            return Err(protocol(ReceiptFailure::ConflictingRetainedNumericalOutcome));
        }
        match (operation, receipt.kind.evidence()) {
            (PendingRetainedOperation::Construction { expected, document, request, .. }, ReceiptEvidence::Construction(completion)) => {
                if receipt.is_empty() { return Err(protocol(ReceiptFailure::EmptyConstructionResult)); }
                if !ifc_lite_geometry::program::transactions::same_admission(request, completion.request()) { return Err(protocol(ReceiptFailure::ForeignSourceAdmission)); }
                document.validate_retained_completion(completion,
                    owner.incarnation().ok_or(RetainedExecutionError::DomainRetired)?).map_err(protocol)?;
                if !same_frame(expected.value().source_from_evaluation(), &completion.source_from_evaluation)
                    || !same_frame(expected.value().evaluation_from_source(), &completion.evaluation_from_source) {
                    return Err(protocol(ReceiptFailure::RetainedFrameMismatch));
                }
            }
            (PendingRetainedOperation::Affine { input, matrix, .. }, ReceiptEvidence::Affine { input: identity_input, column_major }) => {
                input.validate_live().map_err(runtime_fault)?;
                if !input.kind.belongs_to_domain(owner) { return Err(protocol(ReceiptFailure::ForeignAffineInput)); }
                if receipt.is_empty() != input.is_empty() || identity_input != input.kind.object() || !same_frame(column_major, matrix) {
                    return Err(protocol(ReceiptFailure::ForeignAffineOperationOrOrderedInput));
                }
            }
            (PendingRetainedOperation::Boolean { inputs, operation, expected }, ReceiptEvidence::Boolean { operation: actual_operation, left, right, world_from_left, world_from_right, world_from_evaluation, empty }) => {
                for input in inputs.iter() {
                    input.realization.validate_live().map_err(runtime_fault)?;
                    if !input.realization.kind.belongs_to_domain(owner) { return Err(protocol(ReceiptFailure::ForeignBooleanInput)); }
                }
                // Runtimes report each operand's evaluation frame. For a construction,
                // world_from_source * source_from_evaluation is its object frame;
                // compare frame, not the dispatched source frame.
                if receipt.is_empty() != empty || actual_operation != *operation
                    || left != inputs[0].realization.kind.object()
                    || right != inputs[1].realization.kind.object()
                    || !same_frame(world_from_left, &inputs[0].frame)
                    || !same_frame(world_from_right, &inputs[1].frame)
                    || !same_frame(world_from_evaluation, expected.value().object_frame()) {
                    return Err(protocol(ReceiptFailure::ForeignBooleanOperationOrOrderedInputs));
                }
            }
            _ => return Err(protocol(ReceiptFailure::WrongRetainedOperationResult)),
        }
        Ok(())
    }
}
