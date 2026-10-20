// SPDX-License-Identifier: MPL-2.0
//! Synchronous work epochs, child capabilities and source-borrow scopes
//! issued by an [`ExecutionLease`](super::ExecutionLease).
use super::*;

#[derive(Debug)]
pub struct ExecutionWork<'a> {
    pub(super) lease: &'a mut ExecutionLease,
    pub(super) epoch: OnceLock<Arc<WorkEpoch>>,
    pub(super) _thread_bound: std::marker::PhantomData<*const ()>,
}
impl ExecutionWork<'_> {
    /// Grant synchronous descendants access without releasing this reservation.
    /// Allocation occurs only when a descendant capability is actually requested.
    pub fn child_capability(&self) -> ExecutionChildCapability {
        let epoch = self.epoch.get_or_init(|| {
            Arc::new(WorkEpoch {
                active: AtomicBool::new(true),
                thread: std::thread::current().id(),
                parent: self.lease.parent.clone(),
                parent_source: self.lease.source_borrow,
                resource_stop: Mutex::new(None),
            })
        });
        ExecutionChildCapability {
            epoch: epoch.clone(),
            state: self.lease.state.clone(),
            instance: self.lease.identity.instance,
            _thread_bound: std::marker::PhantomData,
        }
    }
    /// Publish decoder-only authority for the duration of a trusted source
    /// borrow. The actual decoder's mutable borrow can cross a scoped thread;
    /// generic owner capabilities and router admission remain thread-bound.
    pub fn source_borrow_scope(&self) -> ExecutionSourceScope {
        self.source_borrow_scope_with_resources(None)
    }
    /// Attach only the explicitly supplied resource account to this source
    /// capability. No kernel, diagnostics, census or other TLS state is copied.
    pub fn source_borrow_scope_with_resources(
        &self,
        resources: Option<SourceResourceContext>,
    ) -> ExecutionSourceScope {
        let capability = self.child_capability();
        let scope_id = next_id();
        self.lease
            .state
            .active_source
            .lock()
            .expect("source borrow lock")
            .push((
                scope_id,
                ActiveSource {
                    epoch: Arc::downgrade(&capability.epoch),
                    resources,
                },
            ));
        ExecutionSourceScope {
            state: self.lease.state.clone(),
            scope_id,
            epoch: capability.epoch,
            _thread_bound: std::marker::PhantomData,
        }
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
        if let Some(epoch) = self.epoch.get() {
            epoch.active.store(false, Ordering::Release);
        }
    }
}

#[derive(Debug)]
pub(super) struct WorkEpoch {
    pub(super) active: AtomicBool,
    pub(super) thread: std::thread::ThreadId,
    pub(super) parent: Option<Arc<WorkEpoch>>,
    pub(super) parent_source: bool,
    pub(super) resource_stop: Mutex<Option<crate::resource_stop::ProgramStop>>,
}
impl WorkEpoch {
    pub(super) fn validate(&self, mut source_borrow: bool) -> Result<(), ExecutionLeaseError> {
        let mut cursor = Some(self);
        while let Some(epoch) = cursor {
            if !epoch.active.load(Ordering::Acquire)
                || (!source_borrow && epoch.thread != std::thread::current().id())
            {
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
    pub fn try_lease(
        &self,
        current: ExecutionIdentity,
    ) -> Result<ExecutionLease, ExecutionLeaseError> {
        self.epoch.validate(false)?;
        if !self.state.alive.load(Ordering::Acquire) {
            return Err(ExecutionLeaseError::OwnerDropped);
        }
        if current.instance != self.instance {
            return Err(ExecutionLeaseError::WrongOwner);
        }
        if current.generation != self.state.generation.load(Ordering::Acquire) {
            return Err(ExecutionLeaseError::ConfigurationChanged);
        }
        Ok(ExecutionLease {
            identity: current,
            id: ExecutionLeaseId(next_id()),
            state: self.state.clone(),
            parent: Some(self.epoch.clone()),
            source_borrow: false,
            resources: None,
        })
    }
}

/// Thread-bound publication of source-borrow authority. No lock is held while
/// extension work runs. Nested decoder borrows restore the enclosing authority;
/// out-of-order drops remove only their own entry.
#[derive(Debug)]
pub struct ExecutionSourceScope {
    state: Arc<State>,
    scope_id: u64,
    epoch: Arc<WorkEpoch>,
    _thread_bound: std::marker::PhantomData<*const ()>,
}
impl ExecutionSourceScope {
    pub fn resource_stop_handle(&self) -> SourceStopHandle {
        SourceStopHandle::new(Arc::clone(&self.epoch))
    }
}
impl Drop for ExecutionSourceScope {
    fn drop(&mut self) {
        // Remove exactly this scope's entry so non-LIFO drops never revive
        // or clobber another scope's authority. No allocation under the lock.
        let displaced = {
            let mut active = self.state.active_source.lock().expect("source borrow lock");
            active
                .iter()
                .rposition(|(id, _)| *id == self.scope_id)
                .map(|at| active.remove(at))
        };
        drop(displaced); // Final account/pool destruction must occur outside the lock.
    }
}
