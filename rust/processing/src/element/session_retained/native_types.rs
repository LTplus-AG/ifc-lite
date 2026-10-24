// SPDX-License-Identifier: MPL-2.0
//! Native compatibility names for the shared target-neutral transaction types.
use super::*;
use ifc_lite_geometry_runtime::{RetainedAffineCopy, RetainedDependencyResult};

pub enum RealizationKind {
    Construction(Box<RetainedRealization>),
    UnaryClip(Box<ifc_lite_geometry_runtime::RetainedPlaneClip>),
    Affine(Box<RetainedAffineCopy>),
    Boolean(Box<RetainedDependencyResult>),
}
pub type RetainedProductExecution<'a> = RuntimeProductExecution<'a, RealizationKind>;
pub type CommonRetainedRealization = RuntimeRealization<RealizationKind>;
pub type IssuedCommonConstruction = RuntimeIssued<RealizationKind>;
pub type CompletedCommonConstruction = RuntimeCompleted<RealizationKind>;
pub type RejectedCommonConstruction = RuntimeRejectedCompletion<RealizationKind>;
pub type RejectedCommonExecution = RuntimeRejectedExecution<RealizationKind>;
pub type RetainedCancellation = RuntimeCancellation<RealizationKind>;
pub type RetainedProductWitness = RuntimeProductWitness<RealizationKind>;

impl CommonRetainedRealization {
    pub fn construction(&self) -> Option<&RetainedRealization> {
        match &self.kind { RealizationKind::Construction(value) => Some(value), _ => None }
    }
}
