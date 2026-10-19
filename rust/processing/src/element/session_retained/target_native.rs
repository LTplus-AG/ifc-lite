// SPDX-License-Identifier: MPL-2.0
pub(crate) use ifc_lite_geometry_runtime::{SmlibWorker as Worker, RuntimeOwner as Domain,
    RetainedRealization as ConstructionReceipt, RetainedAffineCopy as AffineReceipt,
    RetainedDependencyResult as BooleanReceipt, BrepHandle as ObjectIdentity,
    RetainedDependency as Dependency, RetainedTransformInput as TransformInput, WorkerError as ReceiptError};
pub(crate) fn capture(worker: &Worker) -> Domain { worker.retained_owner() }
pub(crate) fn construction_belongs(value: &ConstructionReceipt, owner: &Domain) -> bool { value.owner().same_domain(owner) }
pub(crate) fn affine_belongs(value: &AffineReceipt, owner: &Domain) -> bool { value.owner().same_domain(owner) }
pub(crate) fn boolean_belongs(value: &BooleanReceipt, owner: &Domain) -> bool { value.owner().same_domain(owner) }
