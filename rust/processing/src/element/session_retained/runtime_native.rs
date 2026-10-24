// SPDX-License-Identifier: MPL-2.0
//! Native numerical mapping only; transaction policy stays in the common loop.
use super::*;
use super::runtime::{Invocation, NumericalLimits, Operand, RetainedExecutor, RetainedRuntime};
use super::native_types::RealizationKind;
use ifc_lite_geometry_runtime::{RetainedDependency, RetainedTransformInput, protocol::BooleanOperation};

pub(super) fn boolean_operation(operation: ifc_lite_geometry::BoolOp) -> Result<BooleanOperation, RetainedExecutionError> {
    match operation {
        ifc_lite_geometry::BoolOp::Union => Ok(BooleanOperation::Union),
        ifc_lite_geometry::BoolOp::Intersection => Ok(BooleanOperation::Intersection),
        ifc_lite_geometry::BoolOp::Difference => Ok(BooleanOperation::Difference),
        _ => Err(protocol("unsupported retained Boolean operator")),
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
            _ => Err(protocol("Boolean operand form/receipt kind mismatch")),
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
        }.map_err(|error| RetainedExecutionError::Runtime(error.to_string()))
    }
}
