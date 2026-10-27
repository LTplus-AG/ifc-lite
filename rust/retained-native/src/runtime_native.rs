// SPDX-License-Identifier: MPL-2.0
//! Lifted from the native diagnostic stack; policy stays in processing.
use crate::native_types::{NativeDomain, NativeReceipt, NativeWorker, RealizationKind};
use ifc_lite_geometry_runtime::{
    protocol::BooleanOperation, MeshLimits, RetainedDependency, RetainedTransformInput,
    SmlibWorker, WorkerError,
};
use ifc_lite_processing::element::retained_runtime::{
    AsyncRetainedExecutor, Invocation, NumericalLimits, Operand, RetainedRuntime, RuntimeFault,
};

pub(crate) fn fault(error: WorkerError) -> RuntimeFault {
    let message = error.to_string();
    match error {
        WorkerError::Kernel { status, .. } => RuntimeFault::kernel(status, message),
        WorkerError::InvalidArgument(_) => RuntimeFault::contract(message),
        WorkerError::WrongWorker => RuntimeFault::retired(message),
        WorkerError::ResourceLimit(_) => RuntimeFault::resource_limit(message),
        WorkerError::Unqualified(_) => RuntimeFault::unqualified(message),
        _ => RuntimeFault::transport(message),
    }
}
impl NativeWorker {
    pub fn spawn(path: impl AsRef<std::ffi::OsStr>) -> Result<Self, RuntimeFault> {
        let mut worker = SmlibWorker::spawn(path).map_err(fault)?;
        worker.qualify_ordered_regions().map_err(fault)?;
        worker.qualify_rational_disks().map_err(fault)?;
        Ok(Self(worker))
    }
}
fn boolean_operation(
    operation: ifc_lite_geometry::BoolOp,
) -> Result<BooleanOperation, RuntimeFault> {
    match operation {
        ifc_lite_geometry::BoolOp::Union => Ok(BooleanOperation::Union),
        ifc_lite_geometry::BoolOp::Intersection => Ok(BooleanOperation::Intersection),
        ifc_lite_geometry::BoolOp::Difference => Ok(BooleanOperation::Difference),
        _ => Err(RuntimeFault::contract(
            "unsupported retained Boolean operator",
        )),
    }
}
fn dependency(operand: Operand<'_, NativeReceipt>) -> Result<RetainedDependency<'_>, RuntimeFault> {
    match operand {
        Operand::Source {
            receipt,
            world_from_source,
        } => match &receipt.kind {
            RealizationKind::Construction(realization) => Ok(RetainedDependency::Source {
                realization,
                world_from_source,
            }),
            _ => Err(RuntimeFault::contract("source operand receipt mismatch")),
        },
        Operand::Placed {
            receipt,
            world_from_object,
        } => match &receipt.kind {
            RealizationKind::Affine(copy) => Ok(RetainedDependency::Affine {
                copy,
                world_from_affine: world_from_object,
            }),
            RealizationKind::Boolean(result) => Ok(RetainedDependency::PlacedResult {
                result,
                world_from_result: world_from_object,
            }),
            _ => Err(RuntimeFault::contract("placed operand receipt mismatch")),
        },
    }
}
fn transform_input(receipt: &NativeReceipt) -> RetainedTransformInput<'_> {
    match &receipt.kind {
        RealizationKind::Construction(value) => RetainedTransformInput::Source(value),
        RealizationKind::Affine(value) => RetainedTransformInput::Affine(value),
        RealizationKind::Boolean(value) => RetainedTransformInput::Result(value),
    }
}
impl RetainedRuntime for NativeWorker {
    type Receipt = NativeReceipt;
    fn domain(&self) -> NativeDomain {
        NativeDomain(self.0.retained_owner())
    }
    fn incarnation(&self) -> u64 {
        self.0.incarnation()
    }
}
impl AsyncRetainedExecutor for NativeWorker {
    async fn invoke(
        &mut self,
        call: Invocation<'_, NativeReceipt>,
        limits: NumericalLimits,
    ) -> Result<NativeReceipt, RuntimeFault> {
        let mesh = MeshLimits {
            max_bytes: limits.max_bytes,
        };
        let kind = match call {
            Invocation::Construction(request) => self
                .0
                .evaluate_retained(
                    request.clone(),
                    limits.chord_metres,
                    limits.angle_degrees,
                    mesh,
                )
                .map(|value| RealizationKind::Construction(Box::new(value))),
            Invocation::Affine {
                input,
                column_major,
            } => self
                .0
                .copy_retained_affine(transform_input(input), column_major)
                .map(|value| RealizationKind::Affine(Box::new(value))),
            Invocation::Boolean {
                left,
                right,
                operation,
            } => self
                .0
                .evaluate_retained_boolean(
                    dependency(left)?,
                    dependency(right)?,
                    boolean_operation(operation)?,
                    limits.chord_metres,
                    limits.angle_degrees,
                    mesh,
                )
                .map(|value| RealizationKind::Boolean(Box::new(value))),
        }
        .map_err(fault)?;
        Ok(NativeReceipt {
            kind,
            domain: self.domain(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_arguments_are_contract_faults_not_transport_failures() {
        let error = WorkerError::InvalidArgument("bad frame");
        let expected = RuntimeFault::contract(error.to_string());
        assert_eq!(fault(error), expected);
    }
}
