// SPDX-License-Identifier: MPL-2.0
//! Standard Arc metadata backing, including final Weak lifetime, in one account.
use super::{AllocationAccount, AllocationClass, AllocationCost, AllocationObserver,
    SourceResourceContext, SourceStopHandle, StorageEvent};
use crate::resource_stop::{Dimension, ProgramStop, RefusalReason, ResourceFailure};
use std::{alloc::{AllocError, Allocator, Global, Layout}, ops::Deref,
    ptr::NonNull, sync::{Arc, Weak}};

fn refusal(reason: RefusalReason, requested: u64) -> ProgramStop {
    ProgramStop::ResourceRefused(ResourceFailure { dimension: Dimension::LiveBytes,
        requested, remaining: 0, reason })
}
#[derive(Clone)]
struct MetadataAllocator {
    account: Arc<dyn AllocationAccount>, source: Option<SourceStopHandle>,
}
impl MetadataAllocator {
    fn new(context: &SourceResourceContext, source: Option<SourceStopHandle>) -> Result<Self, ProgramStop> {
        let account = context.allocation_account().ok_or_else(|| {
            let stop = ProgramStop::ResourceRefused(ResourceFailure { dimension: Dimension::Coverage,
                requested: 0, remaining: 0, reason: RefusalReason::UnsupportedCoverage });
            source.as_ref().map_or(stop, |source| source.stop(stop))
        })?;
        let value = Self { account, source };
        value.check()?;
        Ok(value)
    }
    fn check(&self) -> Result<(), ProgramStop> {
        if let Some(source) = &self.source { source.check().map_err(|stop| self.record(stop))?; }
        self.account.check().map_err(|stop| self.record(stop))
    }
    fn record(&self, stop: ProgramStop) -> ProgramStop {
        let source = self.source.as_ref().and_then(|source| source.check().err());
        let account = self.account.check().err();
        let chosen = source.or(account).unwrap_or(stop);
        let chosen = self.source.as_ref().map_or(chosen, |source| source.stop(chosen));
        let account = self.account.stop(chosen);
        self.source.as_ref().map_or(account, |source| source.stop(account))
    }
}
// SAFETY: only standard Arc/Weak own these blocks. All pointer/Layout operations
// delegate unchanged to Global. Clones retain the original refund domain; no
// account-owned strong reference points back to this allocation.
unsafe impl Allocator for MetadataAllocator {
    fn allocate(&self, layout: Layout) -> Result<NonNull<[u8]>, AllocError> {
        self.check().map_err(|_| AllocError)?;
        let bytes = u64::try_from(layout.size()).map_err(|_| {
            self.record(refusal(RefusalReason::Overflow, u64::MAX)); AllocError
        })?;
        self.account.admit(AllocationCost { live: bytes, work: 1, copies: 0,
            class: AllocationClass::Metadata }).map_err(|stop| { self.record(stop); AllocError })?;
        match Global.allocate(layout) {
            Ok(block) => {
                self.account.observe(StorageEvent::Allocated(bytes), AllocationClass::Metadata);
                Ok(block)
            }
            Err(_) => {
                self.account.refund(bytes, AllocationClass::Metadata);
                self.record(refusal(RefusalReason::Allocation, bytes));
                Err(AllocError)
            }
        }
    }
    unsafe fn deallocate(&self, ptr: NonNull<u8>, layout: Layout) {
        // SAFETY: Arc/Weak supply the original Global block and fitting Layout.
        unsafe { Global.deallocate(ptr, layout); }
        self.account.observe(StorageEvent::Deallocated(layout.size() as u64), AllocationClass::Metadata);
        self.account.refund(layout.size() as u64, AllocationClass::Metadata);
    }
}

/// Resource-only metadata ownership. Construction does not authenticate source
/// work. Payload and standard Arc control block use the same admitted backing.
pub struct AccountedArc<T: ?Sized>(Arc<T, MetadataAllocator>);
impl<T> AccountedArc<T> {
    pub fn try_new(value: T, context: &SourceResourceContext, source: Option<SourceStopHandle>)
        -> Result<Self, ProgramStop> {
        let allocator = MetadataAllocator::new(context, source)?;
        Arc::try_new_in(value, allocator.clone()).map(Self)
            .map_err(|_| allocator.record(refusal(RefusalReason::Allocation, 0)))
    }
}
impl<T: ?Sized> AccountedArc<T> {
    pub fn downgrade(&self) -> AccountedWeak<T> { AccountedWeak(Arc::downgrade(&self.0)) }
}
impl<T: AllocationObserver + 'static> AccountedArc<T> {
    /// Sharing an existing metadata owner allocates no observer adapter record.
    pub fn observer(&self) -> AllocationObserverHandle {
        let observer: Arc<dyn AllocationObserver, MetadataAllocator> = self.0.clone();
        AllocationObserverHandle(observer)
    }
}
impl<T: ?Sized> Clone for AccountedArc<T> {
    fn clone(&self) -> Self { Self(self.0.clone()) }
}
impl<T: ?Sized> Deref for AccountedArc<T> {
    type Target = T;
    fn deref(&self) -> &T { &self.0 }
}
pub struct AccountedWeak<T: ?Sized>(Weak<T, MetadataAllocator>);
impl<T: ?Sized> Clone for AccountedWeak<T> {
    fn clone(&self) -> Self { Self(self.0.clone()) }
}
impl<T: ?Sized> AccountedWeak<T> {
    pub fn upgrade(&self) -> Option<AccountedArc<T>> { self.0.upgrade().map(AccountedArc) }
}
/// Opaque sharing of an already funded observer allocation; never source authority.
#[derive(Clone)]
pub struct AllocationObserverHandle(Arc<dyn AllocationObserver, MetadataAllocator>);
impl AllocationObserverHandle {
    #[cfg(all(feature = "source-resource-tracking", any(test, feature = "source-resource-gate-test-support")))]
    pub(crate) fn account_context(&self) -> Option<SourceResourceContext> { self.0.account_context() }
    pub fn check(&self) -> Result<(), ProgramStop> { self.0.check() }
    pub fn record(&self, stop: ProgramStop) -> ProgramStop { self.0.record(stop) }
}
