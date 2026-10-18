// SPDX-License-Identifier: MPL-2.0
//! One exclusive decoder/router reservation for numerical execution and final
//! publication. Dormant planning may precede admission; live work cannot migrate.
use super::session_protocol::WorkError;
use super::*;
use ifc_lite_core::execution_owner::{ExecutionIdentity, ExecutionLease, ExecutionLeaseId};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct OwnerStamp {
    router: ExecutionIdentity,
    decoder: ExecutionIdentity,
    router_lease: ExecutionLeaseId,
    decoder_lease: ExecutionLeaseId,
}

pub(super) struct ProductOwner {
    router: ExecutionLease,
    decoder: ExecutionLease,
}
impl ProductOwner {
    pub(super) fn from_child_leases(router: ExecutionLease, decoder: ExecutionLease) -> Self {
        Self { router, decoder }
    }
    pub fn admit(decoder: &EntityDecoder, router: &GeometryRouter) -> Result<Self, WorkError> {
        let decoder = decoder.try_execution_lease().map_err(|_| WorkError::OwnerBusy)?;
        let router = router.try_execution_lease().map_err(|_| WorkError::OwnerBusy)?;
        Ok(Self { router, decoder })
    }
    /// Acknowledge only mutations reached inside validated synchronous work.
    /// The caller retains this owner on an error or poisons its continuation;
    /// it must never admit a replacement against an outstanding work ticket.
    pub fn work<T>(&mut self, decoder: &mut EntityDecoder, router: &GeometryRouter,
        operation: impl FnOnce(&mut EntityDecoder, &GeometryRouter) -> T)
        -> Result<(T, OwnerStamp), WorkError> {
        let router_work = self.router.begin_synchronous_work(router.execution_identity())
            .map_err(|_| WorkError::WrongOwner)?;
        let decoder_work = self.decoder.begin_synchronous_work(decoder.execution_identity())
            .map_err(|_| WorkError::WrongOwner)?;
        let source_scope = decoder_work.source_borrow_scope_with_resources(ifc_lite_geometry::resource::current_source_context());
        let result = ifc_lite_geometry::resource::with_source_stop(source_scope.resource_stop_handle(), ||
            super::session_canonical::with_active_owner(
            router_work.child_capability(), decoder_work.child_capability(),
            || operation(decoder, router)));
        // Fresh identities come from the executor's actual owners, never a reply.
        drop(source_scope);
        decoder_work.commit(decoder.execution_identity()).map_err(|_| WorkError::WrongOwner)?;
        router_work.commit(router.execution_identity()).map_err(|_| WorkError::WrongOwner)?;
        Ok((result, self.validate(decoder, router)?))
    }
    /// Final diagnostic hooks receive shared decoder access, but can invoke
    /// canonical child producers through their own fresh decoder and this router.
    /// Keep the caller's triangle-order mode while granting lexical child scope.
    pub fn read_work<T>(&mut self, decoder: &EntityDecoder, router: &GeometryRouter,
        operation: impl FnOnce() -> T) -> Result<(T, OwnerStamp), WorkError> {
        let router_work = self.router.begin_synchronous_work(router.execution_identity())
            .map_err(|_| WorkError::WrongOwner)?;
        let decoder_work = self.decoder.begin_synchronous_work(decoder.execution_identity())
            .map_err(|_| WorkError::WrongOwner)?;
        let source_scope = decoder_work.source_borrow_scope_with_resources(ifc_lite_geometry::resource::current_source_context());
        let result = ifc_lite_geometry::resource::with_source_stop(source_scope.resource_stop_handle(), ||
            super::session_canonical::with_active_owner(
            router_work.child_capability(), decoder_work.child_capability(), operation));
        drop(source_scope);
        decoder_work.commit(decoder.execution_identity()).map_err(|_| WorkError::WrongOwner)?;
        router_work.commit(router.execution_identity()).map_err(|_| WorkError::WrongOwner)?;
        Ok((result, self.validate(decoder, router)?))
    }
    pub fn validate(&self, decoder: &EntityDecoder, router: &GeometryRouter) -> Result<OwnerStamp, WorkError> {
        self.router.validate(router.execution_identity()).map_err(|_| WorkError::WrongOwner)?;
        self.decoder.validate(decoder.execution_identity()).map_err(|_| WorkError::WrongOwner)?;
        Ok(OwnerStamp { router: self.router.identity(), decoder: self.decoder.identity(),
            router_lease: self.router.id(), decoder_lease: self.decoder.id() })
    }
}

#[cfg(test)]
#[path = "session_mutation_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "session_finalize_tests.rs"]
mod finalize_tests;
