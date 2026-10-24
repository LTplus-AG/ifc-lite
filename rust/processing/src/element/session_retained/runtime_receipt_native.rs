// SPDX-License-Identifier: MPL-2.0
//! Project sealed native receipt evidence without inventing numerical authority.
use super::runtime::{NumericalReceipt, ReceiptDomain, ReceiptEvidence};
use super::native_types::RealizationKind;
use ifc_lite_geometry_runtime::{BrepHandle, RuntimeOwner, WorkerError, protocol::BooleanOperation};

impl ReceiptDomain for RuntimeOwner {
    fn incarnation(&self) -> Option<u64> { RuntimeOwner::incarnation(self) }
    fn retire(&self) { RuntimeOwner::retire(self) }
    fn same_domain(&self, other: &Self) -> bool { RuntimeOwner::same_domain(self, other) }
}

impl NumericalReceipt for RealizationKind {
    type Object = BrepHandle;
    type Domain = RuntimeOwner;
    type Error = WorkerError;
    fn heap_bytes() -> u64 {
        std::mem::size_of::<ifc_lite_geometry_runtime::RetainedRealization>()
            .max(std::mem::size_of::<ifc_lite_geometry_runtime::RetainedAffineCopy>())
            .max(std::mem::size_of::<ifc_lite_geometry_runtime::RetainedDependencyResult>())
            .max(std::mem::size_of::<ifc_lite_geometry_runtime::RetainedPlaneClip>() + 2 * 2488) as u64
    }
    fn domain(&self) -> &Self::Domain {
        match self {
            Self::Construction(value) => value.owner(),
            Self::Affine(value) => value.owner(),
            Self::Boolean(value) => value.owner(),
            Self::UnaryClip(value) => value.owner(),
        }
    }
    fn validate_live(&self) -> Result<(), Self::Error> {
        match self {
            Self::Construction(value) => value.validate_live(),
            Self::Affine(value) => value.validate_live(),
            Self::Boolean(value) => value.validate_live(),
            Self::UnaryClip(value) => value.validate_live(),
        }
    }
    fn object(&self) -> Self::Object {
        match self {
            Self::Construction(value) => value.solid(),
            Self::Affine(value) => value.solid(),
            Self::Boolean(value) => value.solid(),
            Self::UnaryClip(value) => value.solid(),
        }
    }
    fn evidence(&self) -> ReceiptEvidence<'_, Self::Object> {
        match self {
            Self::Construction(value) => ReceiptEvidence::Construction(value.completion()),
            Self::UnaryClip(value) => {
                let identity = value.operation_identity();
                ReceiptEvidence::UnaryClip { input: identity.input, output: identity.output,
                    plane: &identity.plane, side: identity.side, mode: identity.mode,
                    world_from_evaluation: &identity.world_from_evaluation,
                    certificate: &identity.certificate, empty: value.is_empty() }
            }
            Self::Affine(value) => {
                let identity = value.operation_identity();
                ReceiptEvidence::Affine { input: identity.input, column_major: &identity.column_major }
            }
            Self::Boolean(value) => {
                let identity = value.operation_identity();
                let operation = match identity.operation {
                    BooleanOperation::Union => ifc_lite_geometry::BoolOp::Union,
                    BooleanOperation::Intersection => ifc_lite_geometry::BoolOp::Intersection,
                    BooleanOperation::Difference => ifc_lite_geometry::BoolOp::Difference,
                };
                ReceiptEvidence::Boolean {
                    operation, left: identity.left, right: identity.right,
                    world_from_left: &identity.world_from_left,
                    world_from_right: &identity.world_from_right,
                    world_from_evaluation: value.world_from_evaluation(), empty: value.is_empty(),
                }
            }
        }
    }
}
