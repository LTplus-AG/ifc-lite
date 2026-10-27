// SPDX-License-Identifier: MPL-2.0
//! Local ownership wrappers keep the runtime implementation within orphan rules.
use ifc_lite_geometry_runtime::{
    RetainedAffineCopy, RetainedDependencyResult, RetainedRealization, RuntimeOwner, SmlibWorker,
};

pub struct NativeWorker(pub(crate) SmlibWorker);
#[doc(hidden)]
#[derive(Clone)]
pub struct NativeDomain(pub(crate) RuntimeOwner);
#[doc(hidden)]
pub struct NativeReceipt {
    pub(crate) kind: RealizationKind,
    pub(crate) domain: NativeDomain,
}
pub(crate) enum RealizationKind {
    Construction(Box<RetainedRealization>),
    Affine(Box<RetainedAffineCopy>),
    Boolean(Box<RetainedDependencyResult>),
}
