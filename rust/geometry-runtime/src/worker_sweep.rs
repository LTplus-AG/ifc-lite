// SPDX-License-Identifier: MPL-2.0
//! One immutable construction transaction; no fallback or implicit replay.
use super::{BrepHandle, MeshLimits, SmlibWorker, WorkerError};
use crate::protocol::KernelCommand;
use ifc_lite_geometry::document::{
    retained_sweep, RetainedCompletion, RetainedRequest, RetainedTessellation,
};

/// Executor-issued exact packet/handle binding. Public trusted packets cannot
/// construct this receipt or replace its numerical buffers.
#[derive(Debug)]
pub struct RetainedRealization {
    solid: BrepHandle,
    completion: RetainedCompletion,
    owner: crate::RuntimeOwner,
}
impl RetainedRealization {
    pub fn solid(&self) -> BrepHandle {
        self.solid
    }
    pub fn completion(&self) -> &RetainedCompletion {
        &self.completion
    }
    pub fn owner(&self) -> &crate::RuntimeOwner {
        &self.owner
    }
    /// Explicit standalone host-trusted escape. Consumes the sealed receipt;
    /// returned mutable numerical data cannot recreate runtime authority.
    pub fn into_host_trusted_parts(self) -> (BrepHandle, RetainedCompletion) {
        (self.solid, self.completion)
    }
    pub fn validate_live(&self) -> Result<(), WorkerError> {
        if self.owner.incarnation() == Some(self.solid.worker) {
            Ok(())
        } else {
            Err(WorkerError::WrongWorker)
        }
    }
}

impl SmlibWorker {
    pub fn incarnation(&self) -> u64 {
        if self.is_live() {
            self.identity
        } else {
            0
        }
    }

    /// Execute a source-only RetainedBrep request on its explicitly selected
    /// incarnation. A stale request is refused before uploading or allocating.
    pub fn evaluate_retained_extrusion(
        &mut self,
        request: RetainedRequest,
        chord_metres: f64,
        angle_degrees: f64,
        limits: MeshLimits,
    ) -> Result<RetainedRealization, WorkerError> {
        if request.worker_incarnation() != self.incarnation() || !self.is_live() {
            return Err(WorkerError::WrongWorker);
        }
        let payload = retained_sweep::lower(request.recipe())
            .map_err(|error| WorkerError::Authored(error.to_string()))?;
        let solid = self.create_sweep(&payload.bytes, payload.segments)?;
        let tessellation = match self.tessellate(solid, chord_metres, angle_degrees, limits) {
            Ok(mesh) => mesh,
            Err(error) => {
                // If cleanup fails, retire the process instead of retaining an
                // unpublished object. The original execution error remains useful.
                if self.release(solid).is_err() {
                    self.retire();
                }
                return Err(error);
            }
        };
        let mesh = RetainedTessellation {
            positions: tessellation.positions,
            indices: tessellation.indices,
            flat_corner_normals: tessellation.corner_normals,
            revision_local_faces: tessellation.source_faces,
            source_face_count: tessellation.source_face_count,
            boundary_edges: tessellation.boundary_edges,
            spine_edges: tessellation.spine_edges,
        };
        if !self.is_live() {
            self.retire();
            return Err(WorkerError::Protocol("worker exited before publication"));
        }
        Ok(RetainedRealization {
            owner: crate::RuntimeOwner::new(self.process_control(), self.identity),
            solid,
            completion: RetainedCompletion::new(
                request,
                mesh,
                payload.source_from_evaluation,
                payload.evaluation_from_source,
            ),
        })
    }

    fn create_sweep(&mut self, bytes: &[u8], segments: u32) -> Result<BrepHandle, WorkerError> {
        let capabilities = self.call(KernelCommand::Capabilities)?;
        if capabilities.len() != 8
            || capabilities[..4] != 1u32.to_le_bytes()
            || u32::from_le_bytes(capabilities[4..].try_into().expect("four bytes")) & 1 == 0
        {
            return Err(WorkerError::Protocol("staged sweep extension unavailable"));
        }
        let length =
            u32::try_from(bytes.len()).map_err(|_| WorkerError::ResourceLimit("sweep size"))?;
        if bytes.len() > 1_048_576 || segments == 0 || segments > 8192 {
            return Err(WorkerError::ResourceLimit("sweep declaration"));
        }
        let response = self.call(KernelCommand::SweepBegin {
            session: self.session,
            length,
            loops: 1,
            segments,
        })?;
        let upload = u64::from_le_bytes(self.fixed(response)?);
        if upload == 0 {
            return Err(self.poison("zero upload token"));
        }
        for (index, chunk) in bytes.chunks(3840).enumerate() {
            let result = self.call(KernelCommand::SweepChunk {
                session: self.session,
                upload,
                offset: (index * 3840) as u32,
                bytes: chunk.to_vec(),
            });
            match result {
                Ok(response) if response.is_empty() => (),
                Ok(_) => return Err(self.poison("unexpected upload result")),
                Err(error) => {
                    // Chunk domain failures discard the transaction at the ABI.
                    // Abort is best effort; inability to clean retires the worker.
                    if self
                        .call(KernelCommand::SweepAbort {
                            session: self.session,
                            upload,
                        })
                        .is_err()
                    {
                        self.retire();
                    }
                    return Err(error);
                }
            }
        }
        let result = self.call(KernelCommand::SweepCommit {
            session: self.session,
            upload,
        })?;
        self.handle(result)
    }
}
