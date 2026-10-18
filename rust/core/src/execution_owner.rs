// SPDX-License-Identifier: MPL-2.0
//! Stable execution ownership for warm decoder/router workers. A reservation
//! is owned data, never a mutex/TLS guard, and may survive a scheduling yield.
use std::{fmt, sync::{Arc, Mutex, OnceLock, Weak, atomic::{AtomicBool, AtomicU64, Ordering}}};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
fn next_id() -> u64 {
    NEXT_ID.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| value.checked_add(1))
        .expect("execution identity space exhausted")
}

/// Instance plus configuration generation. Opaque and independent of addresses,
/// IFC express ids, allocation reuse, and identical bytes in another decoder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ExecutionIdentity { instance: u64, generation: u64 }

/// Unique reservation identity; a later lease on the same owner is distinct.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ExecutionLeaseId(u64);

#[derive(Debug)]
struct State {
    generation: AtomicU64,
    reserved: AtomicBool,
    alive: AtomicBool,
    active_source: Mutex<Weak<WorkEpoch>>,
}

/// Private state of one execution owner. Move preserves identity; construction
/// creates a distinct owner. Ordinary nested geometry calls remain permitted.
#[derive(Debug)]
pub struct ExecutionOwner {
    instance: u64,
    generation: u64,
    state: OnceLock<Arc<State>>,
}
impl Default for ExecutionOwner {
    fn default() -> Self {
        // Warm per-job decoder/router construction must remain allocation-free.
        Self { instance: next_id(), generation: 0, state: OnceLock::new() }
    }
}
impl ExecutionOwner {
    pub fn identity(&self) -> ExecutionIdentity {
        ExecutionIdentity { instance: self.instance, generation: self.generation }
    }
    /// Invalidate pending work without releasing its owner's reservation.
    pub fn changed(&mut self) {
        self.generation = self.generation.checked_add(1).expect("execution generation space exhausted");
        if let Some(state) = self.state.get() {
            state.generation.store(self.generation, Ordering::Release);
        }
    }
    pub fn try_lease(&self) -> Result<ExecutionLease, ExecutionLeaseError> {
        let id = ExecutionLeaseId(next_id());
        let state = self.state.get_or_init(|| Arc::new(State {
            generation: AtomicU64::new(self.generation),
            reserved: AtomicBool::new(false), alive: AtomicBool::new(true),
            active_source: Mutex::new(Weak::new()),
        }));
        state.reserved.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| ExecutionLeaseError::AlreadyLeased)?;
        Ok(ExecutionLease { identity: self.identity(), id, state: state.clone(), parent: None, source_borrow: false })
    }
    pub(crate) fn try_source_borrow_lease(&mut self) -> Result<Option<ExecutionLease>, ExecutionLeaseError> {
        let Some(state) = self.state.get() else { return Ok(None) };
        let Some(epoch) = state.active_source.lock().expect("source borrow lock").upgrade()
            else { return Ok(None) };
        epoch.validate(true)?;
        if !state.alive.load(Ordering::Acquire) { return Err(ExecutionLeaseError::OwnerDropped); }
        if !state.reserved.load(Ordering::Acquire) { return Err(ExecutionLeaseError::ExpiredWork); }
        Ok(Some(ExecutionLease { identity: self.identity(), id: ExecutionLeaseId(next_id()),
            state: state.clone(), parent: Some(epoch), source_borrow: true }))
    }

}
impl Drop for ExecutionOwner {
    fn drop(&mut self) {
        if let Some(state) = self.state.get() { state.alive.store(false, Ordering::Release); }
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
}
impl ExecutionLease {
    fn validate_parent(&self) -> Result<(), ExecutionLeaseError> {
        if let Some(parent) = &self.parent { parent.validate(self.source_borrow)?; }
        Ok(())
    }
    pub fn id(&self) -> ExecutionLeaseId { self.id }
    pub fn identity(&self) -> ExecutionIdentity { self.identity }
    /// Begin trusted synchronous executor work after validating its current
    /// owner. Only this scope may acknowledge configuration/cache mutations
    /// made by existing callbacks. Acceptance of a reply must use `validate`
    /// instead; reply-supplied identities cannot authorize a refresh.
    pub fn begin_synchronous_work(&mut self, current: ExecutionIdentity)
        -> Result<ExecutionWork<'_>, ExecutionLeaseError> {
        self.validate(current)?;
        Ok(ExecutionWork { lease: self, epoch: OnceLock::new(), _thread_bound: std::marker::PhantomData })
    }
    /// Supply the owner's freshly read identity, never a cached ticket value.
    pub fn validate(&self,current:ExecutionIdentity)->Result<(),ExecutionLeaseError> {
        self.validate_parent()?;
        if !self.state.alive.load(Ordering::Acquire) { return Err(ExecutionLeaseError::OwnerDropped); }
        if current.instance!=self.identity.instance { return Err(ExecutionLeaseError::WrongOwner); }
        if current!=self.identity || self.state.generation.load(Ordering::Acquire)!=self.identity.generation {
            return Err(ExecutionLeaseError::ConfigurationChanged);
        }
        Ok(())
    }
}
impl Drop for ExecutionLease {
    fn drop(&mut self) {
        if self.parent.is_none() { self.state.reserved.store(false,Ordering::Release); }
    }
}

/// Short-lived trusted execution scope. It borrows its reservation and is
/// thread-bound; no active scope may cross a yield. Dropping it, including on
/// panic, never acknowledges changed configuration. Normal executor completion
/// must explicitly commit against the same live owner's fresh identity.
#[derive(Debug)]
pub struct ExecutionWork<'a> {
    lease: &'a mut ExecutionLease,
    epoch: OnceLock<Arc<WorkEpoch>>,
    _thread_bound: std::marker::PhantomData<*const ()>,
}
impl ExecutionWork<'_> {
    /// Grant synchronous descendants access without releasing this reservation.
    /// Allocation occurs only when a descendant capability is actually requested.
    pub fn child_capability(&self) -> ExecutionChildCapability {
        let epoch = self.epoch.get_or_init(|| Arc::new(WorkEpoch {
            active: AtomicBool::new(true), thread: std::thread::current().id(),
            parent: self.lease.parent.clone(), parent_source: self.lease.source_borrow,
        }));
        ExecutionChildCapability { epoch: epoch.clone(), state: self.lease.state.clone(),
            instance: self.lease.identity.instance, _thread_bound: std::marker::PhantomData }
    }
    /// Publish decoder-only authority for the duration of a trusted source
    /// borrow. The actual decoder's mutable borrow can cross a scoped thread;
    /// generic owner capabilities and router admission remain thread-bound.
    pub fn source_borrow_scope(&self) -> ExecutionSourceScope {
        let capability = self.child_capability();
        let previous = std::mem::replace(
            &mut *self.lease.state.active_source.lock().expect("source borrow lock"),
            Arc::downgrade(&capability.epoch));
        ExecutionSourceScope { state: self.lease.state.clone(), previous,
            _thread_bound: std::marker::PhantomData }
    }
    pub fn commit(self, current: ExecutionIdentity) -> Result<(), ExecutionLeaseError> {
        self.lease.validate_parent()?;
        if !self.lease.state.alive.load(Ordering::Acquire) {
            return Err(ExecutionLeaseError::OwnerDropped);
        }
        if current.instance != self.lease.identity.instance {
            return Err(ExecutionLeaseError::WrongOwner);
        }
        if current.generation != self.lease.state.generation.load(Ordering::Acquire) {
            return Err(ExecutionLeaseError::ConfigurationChanged);
        }
        self.lease.identity = current;
        Ok(())
    }
}

impl Drop for ExecutionWork<'_> {
    fn drop(&mut self) {
        if let Some(epoch) = self.epoch.get() { epoch.active.store(false, Ordering::Release); }
    }
}

#[derive(Debug)]
struct WorkEpoch {
    active: AtomicBool,
    thread: std::thread::ThreadId,
    parent: Option<Arc<WorkEpoch>>,
    parent_source: bool,
}
impl WorkEpoch {
    fn validate(&self, mut source_borrow: bool) -> Result<(), ExecutionLeaseError> {
        let mut cursor = Some(self);
        while let Some(epoch) = cursor {
            if !epoch.active.load(Ordering::Acquire) || (!source_borrow && epoch.thread != std::thread::current().id()) {
                return Err(ExecutionLeaseError::ExpiredWork);
            }
            source_borrow |= epoch.parent_source;
            cursor = epoch.parent.as_deref();
        }
        Ok(())
    }
}

/// Same-thread capability for a synchronous descendant of active trusted work.
/// It expires at that work's normal completion or unwind. Child reservations
/// cannot release the root owner's exclusive reservation.
#[derive(Debug, Clone)]
pub struct ExecutionChildCapability {
    epoch: Arc<WorkEpoch>,
    state: Arc<State>,
    instance: u64,
    _thread_bound: std::marker::PhantomData<*const ()>,
}
impl ExecutionChildCapability {
    pub fn try_lease(&self, current: ExecutionIdentity) -> Result<ExecutionLease, ExecutionLeaseError> {
        self.epoch.validate(false)?;
        if !self.state.alive.load(Ordering::Acquire) { return Err(ExecutionLeaseError::OwnerDropped); }
        if current.instance != self.instance { return Err(ExecutionLeaseError::WrongOwner); }
        if current.generation != self.state.generation.load(Ordering::Acquire) {
            return Err(ExecutionLeaseError::ConfigurationChanged);
        }
        Ok(ExecutionLease { identity: current, id: ExecutionLeaseId(next_id()),
            state: self.state.clone(), parent: Some(self.epoch.clone()), source_borrow: false })
    }
}

/// Thread-bound publication of source-borrow authority. No lock is held while
/// extension work runs. Nested decoder borrows restore the enclosing authority.
#[derive(Debug)]
pub struct ExecutionSourceScope {
    state: Arc<State>,
    previous: Weak<WorkEpoch>,
    _thread_bound: std::marker::PhantomData<*const ()>,
}
impl Drop for ExecutionSourceScope {
    fn drop(&mut self) {
        *self.state.active_source.lock().expect("source borrow lock") = self.previous.clone();
    }
}

/// Admission/acceptance failures have no geometry or diagnostic side effects.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionLeaseError { AlreadyLeased, WrongOwner, ConfigurationChanged, OwnerDropped, ExpiredWork }
impl fmt::Display for ExecutionLeaseError {
    fn fmt(&self,formatter:&mut fmt::Formatter<'_>)->fmt::Result {
        formatter.write_str(match self {
            Self::AlreadyLeased=>"execution owner already has a product lease",
            Self::WrongOwner=>"execution lease belongs to a different owner",
            Self::ConfigurationChanged=>"execution configuration changed while work was pending",
            Self::OwnerDropped=>"execution owner was dropped",
            Self::ExpiredWork=>"synchronous ancestor work is no longer active on this thread",
        })
    }
}
impl std::error::Error for ExecutionLeaseError {}

#[cfg(test)]
#[path="execution_owner_tests.rs"]
mod tests;
