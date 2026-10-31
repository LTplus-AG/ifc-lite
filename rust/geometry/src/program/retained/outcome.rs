// SPDX-License-Identifier: MPL-2.0
//! One write-once numerical classification per logical definition.
use std::sync::{Arc, OnceLock};
pub(super) fn new() -> crate::Result<Arc<OnceLock<bool>>> {
    crate::resource::charge(crate::resource::Cost {
        live_bytes: (std::mem::size_of::<OnceLock<bool>>() + 2 * std::mem::size_of::<usize>()) as u64,
        ..Default::default()
    })?.retain();
    Ok(Arc::new(OnceLock::new()))
}

impl super::LogicalRetainedValue {
    pub(crate) fn is_empty(&self) -> bool {
        self.evaluated_empty() == Some(true)
    }
    /// None until a numerical executor has accepted this definition.
    pub(crate) fn evaluated_empty(&self) -> Option<bool> { self.outcome.get().copied() }
}

impl super::RetainedPlanOperation {
    /// Attach an already authenticated numerical outcome to this definition.
    /// All placed/copied logical references observe the same write-once value.
    /// This logical annotation does not manufacture a sealed runtime receipt.
    pub(crate) fn bind_numerical_outcome(&self, empty: bool) -> crate::Result<()> {
        match self.value.outcome.set(empty) {
            Ok(()) => Ok(()),
            Err(_) if self.value.evaluated_empty() == Some(empty) => Ok(()),
            Err(_) => Err(crate::Error::geometry("conflicting retained numerical outcome")),
        }
    }
}

#[cfg(test)]
#[path = "outcome_allocation_tests.rs"]
mod tests;
