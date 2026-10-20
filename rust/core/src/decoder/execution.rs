// SPDX-License-Identifier: MPL-2.0
use super::{EntityDecoder, EntityIndexStore};
use crate::execution_owner::{ExecutionIdentity, ExecutionLease, ExecutionLeaseError};
use crate::EntityIndex;
use std::sync::Arc;

impl EntityDecoder<'_> {
    /// Install a pre-built index into this decoder. Used when the caller already
    /// built the index during another pass (e.g. the processor scan loop) so the
    /// decoder does not lazily rebuild it via `build_index`. Set it before any
    /// `decode_by_id`/ref-resolving call; afterwards `build_index` no-ops.
    pub fn set_entity_index(&mut self, index: Arc<EntityIndex>) {
        self.execution_owner.changed();
        // A raw index is a trusted external input, like the other raw setters.
        self.revoke_cache_authority();
        self.source_bundle = None;
        self.entity_index = Some(EntityIndexStore::Hash(index));
    }

    /// Stable decoder/input owner and its explicit configuration generation.
    /// Lazy memo population does not change it; index/unit/cache replacement does.
    pub fn execution_identity(&self) -> ExecutionIdentity {
        self.execution_owner.identity()
    }

    /// Reserve this warm input/decoder for one product until the owned token is
    /// dropped. Ordinary nested decoding remains legal within that product.
    pub fn try_execution_lease(&self) -> Result<ExecutionLease, ExecutionLeaseError> {
        self.execution_owner.try_lease()
    }
    /// Inherit only an active trusted source borrow through this actual mutable
    /// decoder. A waiting product lease alone never grants child authority.
    pub fn try_source_execution_lease(
        &mut self,
    ) -> Result<Option<ExecutionLease>, ExecutionLeaseError> {
        self.execution_owner.try_source_borrow_lease()
    }
}
