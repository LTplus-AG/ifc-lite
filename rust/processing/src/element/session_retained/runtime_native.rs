// SPDX-License-Identifier: MPL-2.0
//! Native numerical mapping only; transaction policy stays in the common loop.
use super::*;
use super::runtime::{Invocation, NumericalLimits, Operand, RetainedExecutor, RetainedRuntime};
use super::native_types::RealizationKind;
use ifc_lite_geometry_runtime::{MeshLimits, RetainedDependency, RetainedTransformInput, RuntimeOwner,
    SmlibWorker, WorkerError, protocol::BooleanOperation};

impl From<WorkerError> for RetainedExecutionError {
    fn from(error: WorkerError) -> Self { Self::Runtime(error) }
}

pub(super) fn error_code(error: &WorkerError) -> crate::retained_native_contract::Code {
    use crate::retained_native_contract::Code;
    match error {
        WorkerError::WrongWorker => Code::WorkerRetired,
        WorkerError::ResourceLimit(_) => Code::ResourceExhausted,
        _ => Code::RuntimeFailed,
    }
}

pub(super) fn boolean_operation(operation: ifc_lite_geometry::BoolOp) -> Result<BooleanOperation, RetainedExecutionError> {
    match operation {
        ifc_lite_geometry::BoolOp::Union => Ok(BooleanOperation::Union),
        ifc_lite_geometry::BoolOp::Intersection => Ok(BooleanOperation::Intersection),
        ifc_lite_geometry::BoolOp::Difference => Ok(BooleanOperation::Difference),
        _ => Err(protocol(ReceiptFailure::UnsupportedRetainedBooleanOperator)),
    }
}

impl<'a> Operand<'a, RealizationKind> {
    pub(super) fn native_dependency(self) -> Result<RetainedDependency<'a>, RetainedExecutionError> {
        match self {
            Self::Source { receipt: RealizationKind::Construction(realization), world_from_source } =>
                Ok(RetainedDependency::Source { realization, world_from_source }),
            Self::Placed { receipt: RealizationKind::Affine(copy), world_from_object } =>
                Ok(RetainedDependency::Affine { copy, world_from_affine: world_from_object }),
            Self::Placed { receipt: RealizationKind::Boolean(result), world_from_object } =>
                Ok(RetainedDependency::PlacedResult { result, world_from_result: world_from_object }),
            _ => Err(protocol(ReceiptFailure::BooleanOperandFormReceiptKindMismatch)),
        }
    }
}

fn transform_input(receipt: &RealizationKind) -> RetainedTransformInput<'_> {
    match receipt {
        RealizationKind::Construction(value) => RetainedTransformInput::Source(value),
        RealizationKind::Affine(value) => RetainedTransformInput::Affine(value),
        RealizationKind::Boolean(value) => RetainedTransformInput::Result(value),
    }
}

impl RetainedRuntime for SmlibWorker {
    type Receipt = RealizationKind;
    fn domain(&self) -> RuntimeOwner { self.retained_owner() }
    fn incarnation(&self) -> u64 { SmlibWorker::incarnation(self) }
}
impl RetainedExecutor for SmlibWorker {
    fn invoke(&mut self, call: Invocation<'_, Self::Receipt>, limits: NumericalLimits)
        -> Result<Self::Receipt, RetainedExecutionError> {
        let mesh = MeshLimits { max_bytes: limits.max_bytes };
        match call {
            Invocation::Construction(request) => self.evaluate_retained(request.clone(), limits.chord_metres, limits.angle_degrees, mesh)
                .map(|value| RealizationKind::Construction(Box::new(value))),
            Invocation::Affine { input, column_major } => self.copy_retained_affine(transform_input(input), column_major)
                .map(|value| RealizationKind::Affine(Box::new(value))),
            Invocation::Boolean { left, right, operation } => self.evaluate_retained_boolean(
                left.native_dependency()?, right.native_dependency()?, boolean_operation(operation)?,
                limits.chord_metres, limits.angle_degrees, mesh)
                .map(|value| RealizationKind::Boolean(Box::new(value))),
        }.map_err(RetainedExecutionError::Runtime)
    }
}

// A native call is synchronous today, but the consumer exercises the common
// post-await boundary. DeferredNative tests suspend around this real adapter.
impl runtime::AsyncRetainedExecutor for SmlibWorker {
    async fn invoke(&mut self, call: Invocation<'_, Self::Receipt>, limits: NumericalLimits)
        -> Result<Self::Receipt, RetainedExecutionError> {
        RetainedExecutor::invoke(self, call, limits)
    }
}
