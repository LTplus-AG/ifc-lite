// SPDX-License-Identifier: MPL-2.0
//! Stable warm-router reservation and configuration acceptance barriers.
use super::GeometryRouter;
use ifc_lite_core::execution_owner::{ExecutionIdentity,ExecutionLease,ExecutionLeaseError};

impl GeometryRouter {
    /// Stable instance/configuration identity, unaffected by scoped triangle
    /// order or ordinary cache population during a product's execution.
    pub fn execution_identity(&self)->ExecutionIdentity { self.execution_owner.identity() }

    /// Reserve this router for one product. The executor must enforce this
    /// admission for every product; nested geometry calls within it remain legal.
    /// No RefCell borrow, Rc processor or cache lock is retained by the token.
    pub fn try_execution_lease(&self)->Result<ExecutionLease,ExecutionLeaseError> {
        self.execution_owner.try_lease()
    }

    /// Set the RTC offset for large coordinate handling
    pub fn set_rtc_offset(&mut self, offset: (f64, f64, f64)) {
        self.execution_owner.changed();
        self.rtc_offset = offset;
    }

    /// Get the current RTC offset
    pub fn rtc_offset(&self) -> (f64, f64, f64) {
        self.rtc_offset
    }

    /// Check if RTC offset is active (non-zero)
    #[inline]
    pub fn has_rtc_offset(&self) -> bool {
        self.rtc_offset.0 != 0.0 || self.rtc_offset.1 != 0.0 || self.rtc_offset.2 != 0.0
    }

    /// Get the current unit scale factor
    pub fn unit_scale(&self) -> f64 {
        self.unit_scale
    }

}

#[cfg(test)]
#[path="execution_owner_tests.rs"]
mod tests;
