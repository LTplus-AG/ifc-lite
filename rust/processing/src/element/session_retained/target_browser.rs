// SPDX-License-Identifier: MPL-2.0
pub(crate) use ifc_lite_geometry_runtime::browser::{BrowserWorker as Worker, BrowserCancellation as Domain,
    BrowserRealization as ConstructionReceipt, BrowserAffineCopy as AffineReceipt,
    BrowserDependencyResult as BooleanReceipt, BrowserObjectHandle as ObjectIdentity,
    BrowserDependency as Dependency, BrowserTransformInput as TransformInput};
pub(crate) use ifc_lite_geometry::document::RetainedRefusal as ReceiptError;
pub(crate) fn capture(worker: &Worker) -> Domain { worker.cancellation() }
pub(crate) fn construction_belongs(value: &ConstructionReceipt, owner: &Domain) -> bool { value.belongs_to(owner) }
pub(crate) fn affine_belongs(value: &AffineReceipt, owner: &Domain) -> bool { value.belongs_to(owner) }
pub(crate) fn boolean_belongs(value: &BooleanReceipt, owner: &Domain) -> bool { value.belongs_to(owner) }
