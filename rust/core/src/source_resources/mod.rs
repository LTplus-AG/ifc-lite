// SPDX-License-Identifier: MPL-2.0
//! Private, opt-in unit-test prototype. No production source activation.
mod allocator;
mod backend;
mod containers;
mod gate;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod authority_tests;

use crate::resource_stop::{Dimension, ProgramStop, RefusalReason, ResourceFailure};

fn failure(dimension: Dimension, requested: u64, remaining: u64, reason: RefusalReason) -> ProgramStop {
    ProgramStop::ResourceRefused(ResourceFailure { dimension, requested, remaining, reason })
}
fn coverage() -> ProgramStop {
    failure(Dimension::Coverage, 0, 0, RefusalReason::UnsupportedCoverage)
}
#[cfg(test)]
mod fixtures;
#[cfg(test)]
mod lifetime_tests;
