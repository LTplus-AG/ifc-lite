// SPDX-License-Identifier: MPL-2.0
//! The worker's live-object registry: issued handles, their liveness flags and
//! the affinity check every command passes before it is sent.
use super::{BrepHandle, SmlibWorker, WorkerError};
use crate::protocol::{KernelCommand, WireHandle};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

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
            KernelCommand::CopyTransform { solid, .. }
            | KernelCommand::Volume { solid, .. }
            | KernelCommand::Manifold { solid, .. }
            | KernelCommand::IsEmpty { solid, .. }
            | KernelCommand::Tessellate { solid, .. } => check(*solid),
            KernelCommand::MeshInfo { mesh, .. } | KernelCommand::MeshRead { mesh, .. } => {
                check(*mesh)
            }
            _ => Ok(()),
        }
    }

    pub(super) fn handle(&mut self, bytes: Vec<u8>) -> Result<BrepHandle, WorkerError> {
        let wire = WireHandle::from_bytes(&bytes).map_err(|error| self.poison(error.as_str()))?;
        if wire.session != self.session {
            return Err(self.poison("returned handle belongs to another session"));
        }
        if self.objects.contains_key(&wire) {
            return Err(self.poison("duplicate live object handle"));
        }
        self.objects.insert(wire, Arc::new(AtomicBool::new(true)));
        Ok(BrepHandle {
            worker: self.identity,
            wire,
        })
    }

    pub(super) fn wire(&self, solid: BrepHandle) -> Result<WireHandle, WorkerError> {
        self.check(solid)?;
        Ok(solid.wire)
    }

    pub(super) fn check(&self, solid: BrepHandle) -> Result<(), WorkerError> {
        if !self.is_live() {
            return Err(WorkerError::Protocol("worker requires restart"));
        }
        if solid.worker != self.identity || solid.wire.session != self.session {
            return Err(WorkerError::WrongWorker);
        }
        if !self
            .objects
            .get(&solid.wire)
            .is_some_and(|live| live.load(Ordering::Acquire))
        {
            return Err(WorkerError::WrongWorker);
        }
        Ok(())
    }

    /// The shared liveness flag of one live object, for receipts naming it.
    pub(super) fn object_liveness(
        &self,
        solid: BrepHandle,
    ) -> Result<Arc<AtomicBool>, WorkerError> {
        self.check(solid)?;
        self.objects
            .get(&solid.wire)
            .cloned()
            .ok_or(WorkerError::WrongWorker)
    }
}
