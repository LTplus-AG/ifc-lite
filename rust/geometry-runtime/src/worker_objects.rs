// SPDX-License-Identifier: MPL-2.0
//! Per-object lifetime of managed receipts, serialized by the owning worker.
//!
//! Dropping the final receipt of an object invalidates it at once and queues
//! its release; the worker releases queued objects before its next command.
//! A failed release retires only this exact process. Only when the queue
//! cannot accept an object does its lease retire the captured process.
use super::{BrepHandle, SmlibWorker, WorkerError};
use crate::protocol::{KernelCommand, WireHandle};
use crate::RuntimeOwner;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

const MAX_PENDING_RELEASES: usize = 4096;

#[derive(Debug, Default)]
pub(super) struct ReleaseQueue {
    pending: Mutex<Vec<BrepHandle>>,
}

impl ReleaseQueue {
    // Poison is converted here so its guard is dropped before the caller
    // retires the process (which performs IO).
    fn len(&self) -> Result<usize, ()> {
        self.pending
            .lock()
            .map(|pending| pending.len())
            .map_err(|_| ())
    }
    fn pop(&self) -> Result<Option<BrepHandle>, ()> {
        self.pending
            .lock()
            .map(|mut pending| pending.pop())
            .map_err(|_| ())
    }
}

/// The one shared lease of a managed object. Its final drop invalidates the
/// object and queues its release with the exact worker that issued it.
#[derive(Debug)]
pub(super) struct ManagedObjectLease {
    solid: BrepHandle,
    live: Arc<AtomicBool>,
    armed: AtomicBool,
    queue: Weak<ReleaseQueue>,
    owner: RuntimeOwner,
}

impl ManagedObjectLease {
    /// Only the consuming host-trusted escape transfers ownership to a raw caller.
    pub(super) fn disarm(&self) {
        self.armed.store(false, Ordering::Release);
    }
}

impl Drop for ManagedObjectLease {
    fn drop(&mut self) {
        // Disarmed, explicitly released or already invalidated: nothing to do.
        if !self.armed.load(Ordering::Acquire) || !self.live.swap(false, Ordering::AcqRel) {
            return;
        }
        let queued = self.queue.upgrade().is_some_and(|queue| {
            let Ok(mut pending) = queue.pending.lock() else {
                return false;
            };
            if pending.len() >= MAX_PENDING_RELEASES || pending.try_reserve(1).is_err() {
                return false;
            }
            pending.push(self.solid);
            true
        });
        if !queued {
            // The captured Child, never a PID or a replacement lookup. After
            // the worker itself is gone this only re-reaps the exited process.
            self.owner.retire();
        }
    }
}

impl SmlibWorker {
    /// The shared lease of one live object, created on first management.
    pub(super) fn manage_object(
        &mut self,
        solid: BrepHandle,
    ) -> Result<Arc<ManagedObjectLease>, WorkerError> {
        let live = self.object_liveness(solid)?;
        if let Some(lease) = self.managed.get(&solid.wire).and_then(Weak::upgrade) {
            return Ok(lease);
        }
        let lease = Arc::new(ManagedObjectLease {
            solid,
            live,
            armed: AtomicBool::new(true),
            queue: Arc::downgrade(&self.releases),
            owner: self.retained_owner(),
        });
        self.managed.insert(solid.wire, Arc::downgrade(&lease));
        Ok(lease)
    }

    /// Release the objects of dropped receipts now. Every command does this
    /// first; failure retires this exact process and is returned before any
    /// later command can run.
    pub fn flush_releases(&mut self) -> Result<(), WorkerError> {
        if !self.is_live() {
            return Err(WorkerError::Protocol("worker requires restart"));
        }
        // Bound one drain even while another thread drops receipts.
        let Ok(count) = self.releases.len() else {
            self.retire();
            return Err(WorkerError::Protocol("release queue poisoned"));
        };
        for _ in 0..count {
            let solid = match self.releases.pop() {
                Ok(Some(solid)) => solid,
                Ok(None) => break,
                Err(()) => {
                    self.retire();
                    return Err(WorkerError::Protocol("release queue poisoned"));
                }
            };
            if solid.worker != self.identity || solid.wire.session != self.session {
                return Err(self.poison("queued release belongs to another domain"));
            }
            // An explicit release may already have reclaimed this generation.
            if self.objects.remove(&solid.wire).is_none() {
                continue;
            }
            self.managed.remove(&solid.wire);
            self.release_wire(solid.wire)?;
        }
        Ok(())
    }

    /// Release one live object, managed or raw. Foreign, stale or unknown
    /// handles dispatch nothing. A reported kernel failure retires the process
    /// because the object's state is then unknown.
    pub fn release(&mut self, solid: BrepHandle) -> Result<(), WorkerError> {
        // Reject foreign authority before inspecting or draining this domain.
        if solid.worker != self.identity || solid.wire.session != self.session {
            return Err(WorkerError::WrongWorker);
        }
        if let Err(error) = self.check(solid) {
            // Only a registered object invalidated by its dropped receipt
            // authorizes draining: its queued release failure is reported.
            if self
                .objects
                .get(&solid.wire)
                .is_some_and(|live| !live.load(Ordering::Acquire))
            {
                self.flush_releases()?;
            }
            return Err(error);
        }
        if let Some(live) = self.objects.remove(&solid.wire) {
            live.store(false, Ordering::Release);
        }
        self.managed.remove(&solid.wire);
        self.flush_releases()?;
        self.release_wire(solid.wire)
    }

    fn release_wire(&mut self, object: WireHandle) -> Result<(), WorkerError> {
        // No call() recursion and no queue lock across worker IO.
        match self.exchange(&KernelCommand::Release {
            session: self.session,
            object,
        }) {
            Ok(bytes) if bytes.is_empty() => Ok(()),
            Ok(_) => Err(self.poison("release returned unexpected payload")),
            Err(error) => {
                self.retire();
                Err(error)
            }
        }
    }
}

#[cfg(all(test, unix))]
#[path = "worker_objects_tests.rs"]
mod tests;
