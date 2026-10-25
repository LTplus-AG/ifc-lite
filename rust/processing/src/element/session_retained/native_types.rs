// SPDX-License-Identifier: MPL-2.0
//! Native compatibility names for the shared target-neutral transaction types.
use super::*;
use ifc_lite_geometry_runtime::{RetainedAffineCopy, RetainedDependencyResult};

pub(super) enum RealizationKind {
    Construction(Box<RetainedRealization>),
    Affine(Box<RetainedAffineCopy>),
    Boolean(Box<RetainedDependencyResult>),
}
pub(super) type RetainedProductExecution<'a> = RuntimeProductExecution<'a, RealizationKind>;
#[cfg(test)]
pub(super) type CommonRetainedRealization = RuntimeRealization<RealizationKind>;
pub(super) type IssuedCommonConstruction = RuntimeIssued<RealizationKind>;
#[cfg(test)]
pub(super) type CompletedCommonConstruction = RuntimeCompleted<RealizationKind>;
#[cfg(test)]
pub(super) type RejectedCommonExecution = RuntimeRejectedExecution<RealizationKind>;

#[cfg(test)]
impl CommonRetainedRealization {
    pub(super) fn construction(&self) -> Option<&RetainedRealization> {
        match &self.kind { RealizationKind::Construction(value) => Some(value), _ => None }
    }
}
