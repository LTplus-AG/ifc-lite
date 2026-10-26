// SPDX-License-Identifier: MPL-2.0
//! Project sealed native receipt evidence without inventing numerical authority.
use crate::native_types::{NativeDomain, NativeReceipt, RealizationKind};
use crate::runtime_native::fault;
use ifc_lite_geometry_runtime::{protocol::BooleanOperation, BrepHandle};
use ifc_lite_processing::element::retained_runtime::{
    NumericalReceipt, ReceiptDomain, ReceiptEvidence, ReceiptMesh, RuntimeFault,
};

impl ReceiptDomain for NativeDomain {
    fn incarnation(&self) -> Option<u64> {
        self.0.incarnation()
    }
    fn retire(&self) {
        self.0.retire()
    }
    fn same_domain(&self, other: &Self) -> bool {
        self.0.same_domain(&other.0)
    }
}

impl NumericalReceipt for NativeReceipt {
    type Object = BrepHandle;
    type Domain = NativeDomain;
    type Error = RuntimeFault;
    fn heap_bytes() -> u64 {
        std::mem::size_of::<ifc_lite_geometry_runtime::RetainedRealization>()
            .max(std::mem::size_of::<
                ifc_lite_geometry_runtime::RetainedAffineCopy,
            >())
            .max(std::mem::size_of::<
                ifc_lite_geometry_runtime::RetainedDependencyResult,
            >()) as u64
    }
    fn buffer_bytes(&self) -> Result<u64, RuntimeFault> {
        let capacities = match &self.kind {
            RealizationKind::Construction(value) => {
                let mesh = &value.completion().tessellation;
                [
                    mesh.positions.capacity(),
                    mesh.flat_corner_normals.capacity(),
                    mesh.indices.capacity(),
                    mesh.revision_local_faces.capacity(),
                ]
            }
            RealizationKind::Boolean(value) => {
                let mesh = value.mesh();
                [
                    mesh.positions.capacity(),
                    mesh.corner_normals.capacity(),
                    mesh.indices.capacity(),
                    mesh.source_faces.capacity(),
                ]
            }
            RealizationKind::Affine(_) => [0; 4],
        };
        capacities
            .into_iter()
            .zip([8u64, 8, 4, 4])
            .try_fold(0u64, |sum, (n, size)| {
                (n as u64)
                    .checked_mul(size)
                    .and_then(|bytes| sum.checked_add(bytes))
                    .ok_or_else(|| RuntimeFault::resource_limit("receipt buffers overflow"))
            })
    }
    fn domain(&self) -> &Self::Domain {
        &self.domain
    }
    fn mesh(&self) -> Option<ReceiptMesh<'_>> {
        match &self.kind {
            RealizationKind::Construction(value) => Some(ReceiptMesh {
                positions: &value.completion().tessellation.positions,
                indices: &value.completion().tessellation.indices,
            }),
            RealizationKind::Boolean(value) => Some(ReceiptMesh {
                positions: &value.mesh().positions,
                indices: &value.mesh().indices,
            }),
            RealizationKind::Affine(_) => None,
        }
    }
    fn validate_live(&self) -> Result<(), Self::Error> {
        match &self.kind {
            RealizationKind::Construction(value) => value.validate_live().map_err(fault),
            RealizationKind::Affine(value) => value.validate_live().map_err(fault),
            RealizationKind::Boolean(value) => value.validate_live().map_err(fault),
        }
    }
    fn object(&self) -> Self::Object {
        match &self.kind {
            RealizationKind::Construction(value) => value.solid(),
            RealizationKind::Affine(value) => value.solid(),
            RealizationKind::Boolean(value) => value.solid(),
        }
    }
    fn evidence(&self) -> ReceiptEvidence<'_, Self::Object> {
        match &self.kind {
            RealizationKind::Construction(value) => {
                ReceiptEvidence::Construction(value.completion())
            }
            RealizationKind::Affine(value) => {
                let identity = value.operation_identity();
                ReceiptEvidence::Affine {
                    input: identity.input,
                    column_major: &identity.column_major,
                }
            }
            RealizationKind::Boolean(value) => {
                let identity = value.operation_identity();
                let operation = match identity.operation {
                    BooleanOperation::Union => ifc_lite_geometry::BoolOp::Union,
                    BooleanOperation::Intersection => ifc_lite_geometry::BoolOp::Intersection,
                    BooleanOperation::Difference => ifc_lite_geometry::BoolOp::Difference,
                };
                ReceiptEvidence::Boolean {
                    operation,
                    left: identity.left,
                    right: identity.right,
                    world_from_left: &identity.world_from_left,
                    world_from_right: &identity.world_from_right,
                    world_from_evaluation: value.world_from_evaluation(),
                    empty: value.is_empty(),
                }
            }
        }
    }
}
