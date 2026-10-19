// SPDX-License-Identifier: MPL-2.0
//! Shared resource interfaces; the enclosing module is strictly test support.
pub(super) use crate::execution_owner::{AllocationCost as Cost, StorageEvent};
// Feasibility bound only: this module never compiles in ordinary tracking builds.
pub(super) const MAX_BINDINGS: usize = 16;
#[cfg(test)]
pub(super) use crate::execution_owner::AllocationAccount as Backend;
#[cfg(test)]
#[path = "backend_fixture.rs"]
mod fixture;
#[cfg(test)]
pub(super) use fixture::{Resources, MAX_GATES, fixture_resources};
