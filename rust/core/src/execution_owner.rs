// SPDX-License-Identifier: MPL-2.0
//! Stable execution ownership for warm decoder/router workers. A reservation
//! is owned data, never a mutex/TLS guard, and may survive a scheduling yield.
use std::{
    fmt,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
};

mod resource_context;
pub use resource_context::{SourceResourceContext, SourceStopHandle};
mod allocation_account;
pub use allocation_account::{
    AllocationAccount, AllocationClass, AllocationCost, AllocationObserver, StorageEvent,
};
use resource_context::ActiveSource;
mod work;
use work::WorkEpoch;
pub use work::{ExecutionChildCapability, ExecutionSourceScope, ExecutionWork};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
fn next_id() -> u64 {
    NEXT_ID
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
            value.checked_add(1)
        })
        .expect("execution identity space exhausted")
}

/// Instance plus configuration generation. Opaque and independent of addresses,
/// IFC express ids, allocation reuse, and identical bytes in another decoder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ExecutionIdentity {
    instance: u64,
    generation: u64,
}

/// Unique reservation identity; a later lease on the same owner is distinct.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ExecutionLeaseId(u64);

#[derive(Debug)]
struct State {
    generation: AtomicU64,
    reserved: AtomicBool,
    alive: AtomicBool,
    /// Ordered scope stack; empty is the base (no authority) state.
    active_source: Mutex<Vec<(u64, ActiveSource)>>,
    cache_authority: Mutex<CacheAuthority>,
}

// Baseline owner metadata, independent of configuration generation. A weak
// source link cannot keep a source alive or form an owner/source cycle.
#[derive(Debug, Clone, Default)]
struct CacheAuthority {
    revision: u64,
    source: std::sync::Weak<crate::SourceBundle>,
}

/// Private state of one execution owner. Move preserves identity; construction
/// creates a distinct owner. Ordinary nested geometry calls remain permitted.
#[derive(Debug)]
pub struct ExecutionOwner {
    instance: u64,
    generation: u64,
    state: OnceLock<Arc<State>>,
    cache_authority: CacheAuthority,
}
impl Default for ExecutionOwner {
    fn default() -> Self {
        // Warm per-job decoder/router construction must remain allocation-free.
        Self {
            instance: next_id(),
            generation: 0,
            state: OnceLock::new(),
            cache_authority: CacheAuthority::default(),
        }
    }
}
impl ExecutionOwner {
    pub fn identity(&self) -> ExecutionIdentity {
        ExecutionIdentity {
            instance: self.instance,
            generation: self.generation,
        }
    }
    /// Invalidate pending work without releasing its owner's reservation.
    pub fn changed(&mut self) {
        self.generation = self
            .generation
            .checked_add(1)
            .expect("execution generation space exhausted");
        if let Some(state) = self.state.get() {
            state.generation.store(self.generation, Ordering::Release);
        }
    }
    /// Revoke captured cache work before a cache mutation. This does not change
    /// configuration generation or the canonical/raw cache provenance marker.
    pub(crate) fn cache_changed(&mut self) {
        self.cache_authority.revision = self
            .cache_authority
            .revision
            .checked_add(1)
            .expect("execution cache revision space exhausted");
        if let Some(state) = self.state.get() {
            let previous = std::mem::replace(
                &mut *state.cache_authority.lock().expect("cache authority lock"),
                self.cache_authority.clone(),
            );
            drop(previous); // Final Weak destruction happens outside the lock.
        }
    }
    pub(crate) fn publish_cache_source(&mut self, source: Option<&Arc<crate::SourceBundle>>) {
        self.cache_authority.source = source.map_or_else(Default::default, Arc::downgrade);
        self.cache_changed();
    }
    pub fn try_lease(&self) -> Result<ExecutionLease, ExecutionLeaseError> {
        let id = ExecutionLeaseId(next_id());
        let state = self.state.get_or_init(|| {
            Arc::new(State {
                generation: AtomicU64::new(self.generation),
                reserved: AtomicBool::new(false),
                alive: AtomicBool::new(true),
                active_source: Mutex::new(Vec::new()),
                cache_authority: Mutex::new(self.cache_authority.clone()),
            })
        });
        state
            .reserved
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| ExecutionLeaseError::AlreadyLeased)?;
        Ok(ExecutionLease {
            identity: self.identity(),
            id,
            state: state.clone(),
            parent: None,
            source_borrow: false,
            resources: None,
        })
    }
    pub(crate) fn try_source_borrow_lease(
        &mut self,
    ) -> Result<Option<ExecutionLease>, ExecutionLeaseError> {
        let Some(state) = self.state.get() else {
            return Ok(None);
        };
        let source = state
            .active_source
            .lock()
            .expect("source borrow lock")
            .last()
            .map(|(_, source)| source.clone())
            .unwrap_or_default();
        let Some(epoch) = source.epoch.upgrade() else {
            return Ok(None);
        };
        epoch.validate(true)?;
        if !state.alive.load(Ordering::Acquire) {
            return Err(ExecutionLeaseError::OwnerDropped);
        }
        if !state.reserved.load(Ordering::Acquire) {
            return Err(ExecutionLeaseError::ExpiredWork);
        }
        Ok(Some(ExecutionLease {
            identity: self.identity(),
            id: ExecutionLeaseId(next_id()),
            state: state.clone(),
            parent: Some(epoch),
            source_borrow: true,
            resources: source.resources,
        }))
    }
}
impl Drop for ExecutionOwner {
    fn drop(&mut self) {
        if let Some(state) = self.state.get() {
            state.alive.store(false, Ordering::Release);
        }
    }
}

/// Exclusive product reservation. Send, not Clone: no borrow or thread-bound
/// guard survives a poll. Drop releases admission on normal/error/panic paths.
/// This does not prohibit direct router calls: the executor must keep those
/// calls within its product owner while the reservation is live.
#[derive(Debug)]
pub struct ExecutionLease {
    identity: ExecutionIdentity,
    id: ExecutionLeaseId,
    state: Arc<State>,
    parent: Option<Arc<WorkEpoch>>,
    source_borrow: bool,
    resources: Option<SourceResourceContext>,
}
impl ExecutionLease {
    fn validate_parent(&self) -> Result<(), ExecutionLeaseError> {
        if let Some(parent) = &self.parent {
            parent.validate(self.source_borrow)?;
        }
        Ok(())
    }
    /// Read only an active source-borrow resource context. This does not install
    /// any execution state or grant a router lease on another thread.
    pub fn source_resource_context(
        &self,
    ) -> Result<Option<SourceResourceContext>, ExecutionLeaseError> {
        self.validate_parent()?;
        Ok(self.resources.clone())
    }
    pub fn source_stop_handle(&self) -> Result<Option<SourceStopHandle>, ExecutionLeaseError> {
        self.validate_parent()?;
        Ok(self
            .parent
            .as_ref()
            .map(|epoch| SourceStopHandle::new(Arc::clone(epoch))))
    }
    pub fn id(&self) -> ExecutionLeaseId {
        self.id
    }
    pub fn identity(&self) -> ExecutionIdentity {
        self.identity
    }
    /// Begin trusted synchronous executor work after validating its current
    /// owner. Only this scope may acknowledge configuration/cache mutations
    /// made by existing callbacks. Acceptance of a reply must use `validate`
    /// instead; reply-supplied identities cannot authorize a refresh.
    pub fn begin_synchronous_work(
        &mut self,
        current: ExecutionIdentity,
    ) -> Result<ExecutionWork<'_>, ExecutionLeaseError> {
        self.validate(current)?;
        Ok(ExecutionWork {
            lease: self,
            epoch: OnceLock::new(),
            _thread_bound: std::marker::PhantomData,
        })
    }
    /// Supply the owner's freshly read identity, never a cached ticket value.
    pub fn validate(&self, current: ExecutionIdentity) -> Result<(), ExecutionLeaseError> {
        self.validate_parent()?;
        if !self.state.alive.load(Ordering::Acquire) {
            return Err(ExecutionLeaseError::OwnerDropped);
        }
        if current.instance != self.identity.instance {
            return Err(ExecutionLeaseError::WrongOwner);
        }
        if current != self.identity
            || self.state.generation.load(Ordering::Acquire) != self.identity.generation
        {
            return Err(ExecutionLeaseError::ConfigurationChanged);
        }
        Ok(())
    }
}
impl Drop for ExecutionLease {
    fn drop(&mut self) {
        if self.parent.is_none() {
            self.state.reserved.store(false, Ordering::Release);
        }
    }
}

/// Why an execution lease, work scope or source borrow was refused.
/// Admission/acceptance failures have no geometry or diagnostic side effects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionLeaseError {
    AlreadyLeased,
    WrongOwner,
    ConfigurationChanged,
    OwnerDropped,
    ExpiredWork,
}
impl fmt::Display for ExecutionLeaseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::AlreadyLeased => "execution owner already has a product lease",
            Self::WrongOwner => "execution lease belongs to a different owner",
            Self::ConfigurationChanged => "execution configuration changed while work was pending",
            Self::OwnerDropped => "execution owner was dropped",
            Self::ExpiredWork => "synchronous ancestor work is no longer active on this thread",
        })
    }
}
impl std::error::Error for ExecutionLeaseError {}

#[cfg(test)]
#[path = "execution_owner/resource_context_tests.rs"]
mod resource_context_tests;
#[cfg(test)]
#[path = "execution_owner_tests.rs"]
mod tests;
