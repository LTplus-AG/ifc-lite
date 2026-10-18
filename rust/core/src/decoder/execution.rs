// SPDX-License-Identifier: MPL-2.0
use super::EntityDecoder;
use crate::execution_owner::{ExecutionIdentity,ExecutionLease,ExecutionLeaseError};

impl EntityDecoder<'_> {
    /// Stable decoder/input owner and its explicit configuration generation.
    /// Lazy memo population does not change it; index/unit/cache replacement does.
    pub fn execution_identity(&self)->ExecutionIdentity { self.execution_owner.identity() }

    /// Reserve this warm input/decoder for one product until the owned token is
    /// dropped. Ordinary nested decoding remains legal within that product.
    pub fn try_execution_lease(&self)->Result<ExecutionLease,ExecutionLeaseError> {
        self.execution_owner.try_lease()
    }
    /// Inherit only an active trusted source borrow through this actual mutable
    /// decoder. A waiting product lease alone never grants child authority.
    pub fn try_source_execution_lease(&mut self)->Result<Option<ExecutionLease>,ExecutionLeaseError> {
        self.execution_owner.try_source_borrow_lease()
    }

}
