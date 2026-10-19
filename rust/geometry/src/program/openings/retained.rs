// SPDX-License-Identifier: MPL-2.0
//! Original opening occurrences with analytic authority; no display-mesh cutters.
use crate::program::retained::LogicalRetainedValue;

/// No analytic eligibility certificate exists for the mesh-only optimized routes.
/// This is a policy deferral before speculative numerical effects, not a failed
/// grouped operation or permission to erase a reached group failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GroupEligibility {
    DeferredMeshOnlyProbes,
}
pub(crate) struct RetainedOpening {
    pub requested_id: u32,
    pub values: Vec<LogicalRetainedValue>,
}
pub(crate) struct RetainedVoidContext {
    pub openings: Vec<RetainedOpening>,
    pub grouping: GroupEligibility,
}
