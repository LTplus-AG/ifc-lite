// SPDX-License-Identifier: MPL-2.0
//! Managed object cleanup is serialized by the exact owning worker.
use super::{BrepHandle, SmlibWorker, WorkerError};
use crate::{protocol::KernelCommand, RuntimeOwner};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, Weak,
};

const MAX_PENDING_RELEASES: usize = 4096;

#[derive(Default, Debug)]
pub(super) struct ReleaseQueue {
    pending: Mutex<Vec<BrepHandle>>,
}

impl ReleaseQueue {
    // Convert poison errors here so their contained guards are dropped before
    // the caller retires the process (which performs IO).
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
            // This authority captures the Child, never a PID or replacement lookup.
            self.owner.retire();
        }
    }
}

impl SmlibWorker {
    pub(super) fn check_command_objects(&self, command: &KernelCommand) -> Result<(), WorkerError> {
        let check = |wire| {
            self.check(BrepHandle {
                worker: self.identity,
                wire,
            })
        };
        match command {
            KernelCommand::Boolean { left, right, .. } => {
                check(*left)?;
                check(*right)
            }
            KernelCommand::CopyAffine { solid, .. }
            | KernelCommand::CopyTransform { solid, .. }
            | KernelCommand::IsEmpty { solid, .. }
            | KernelCommand::Volume { solid, .. }
            | KernelCommand::Manifold { solid, .. }
            | KernelCommand::Tessellate { solid, .. } => check(*solid),
            KernelCommand::MeshInfo { mesh, .. } | KernelCommand::MeshRead { mesh, .. } => {
                check(*mesh)
            }
            _ => Ok(()),
        }
    }

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

    /// Release pending managed objects while idle. Failure retires this exact
    /// process and is returned before any subsequent command can run.
    pub fn flush_releases(&mut self) -> Result<(), WorkerError> {
        if !self.is_live() {
            return Err(WorkerError::Protocol("worker requires restart"));
        }
        // Bound one drain even when another thread is dropping receipts.
        let count = match self.releases.len() {
            Ok(count) => count,
            Err(_) => {
                self.retained_owner().retire();
                return Err(WorkerError::Protocol("release queue poisoned"));
            }
        };
        for _ in 0..count {
            let solid = match self.releases.pop() {
                Ok(solid) => solid,
                Err(_) => {
                    self.retained_owner().retire();
                    return Err(WorkerError::Protocol("release queue poisoned"));
                }
            };
            let Some(solid) = solid else { break };
            if solid.worker != self.identity || solid.wire.session != self.session {
                return Err(self.poison("queued release belongs to another domain"));
            }
            // Explicit release may already have reclaimed this exact generation.
            let Some(live) = self.objects.remove(&solid.wire) else {
                continue;
            };
            live.store(false, Ordering::Release);
            self.managed.remove(&solid.wire);
            self.release_wire(solid.wire)?;
        }
        Ok(())
    }

    pub fn release(&mut self, solid: BrepHandle) -> Result<(), WorkerError> {
        // Reject foreign authority before inspecting or draining this domain.
        if solid.worker != self.identity || solid.wire.session != self.session {
            return Err(WorkerError::WrongWorker);
        }
        // Only a registered, invalidated object can authorize draining its
        // queued cleanup. Unknown or already removed raw handles dispatch nothing.
        if let Err(error) = self.check(solid) {
            if self
                .objects
                .get(&solid.wire)
                .is_some_and(|live| !live.load(Ordering::Acquire))
            {
                self.flush_releases()?;
            }
            return Err(error);
        }
        let live = self
            .objects
            .remove(&solid.wire)
            .ok_or(WorkerError::WrongWorker)?;
        live.store(false, Ordering::Release);
        self.managed.remove(&solid.wire);
        self.flush_releases()?;
        self.release_wire(solid.wire)
    }

    fn release_wire(&mut self, object: crate::protocol::WireHandle) -> Result<(), WorkerError> {
        // No call recursion and no queue lock across SDK IO.
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
