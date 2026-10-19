// SPDX-License-Identifier: MPL-2.0
//! One immutable construction transaction; no fallback or implicit replay.
use super::{BrepHandle, MeshLimits, SmlibWorker, WorkerError};
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
    object_live: std::sync::Arc<std::sync::atomic::AtomicBool>,
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
        if self.owner.incarnation() == Some(self.solid.worker)
            && self.object_live.load(std::sync::atomic::Ordering::Acquire) {
            Ok(())
        } else {
            Err(WorkerError::WrongWorker)
        }
    }
}

impl SmlibWorker {
    /// Independently captured cancellation/liveness for a dormant product owner.
    pub fn retained_owner(&self) -> crate::RuntimeOwner {
        crate::RuntimeOwner::new(self.process_control(), self.identity)
    }

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
        let payload = request.recipe().lower()
            .map_err(|error| WorkerError::Authored(error.to_string()))?;
        let qualified = match payload.qualification {
            retained_sweep::RegionQualification::Rectangle => true,
            retained_sweep::RegionQualification::OrderedRegion => self.regions_qualified,
            retained_sweep::RegionQualification::RationalDisk => self.disks_qualified,
        };
        if !qualified {
            return Err(WorkerError::Authored("UnqualifiedRegion: execute same-incarnation target witnesses first".into()));
        }
        let solid = self.create_sweep(&payload.bytes, payload.format, payload.loops, payload.segments)?;
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
        if tessellation.is_empty() {
            self.retire();
            return Err(WorkerError::Protocol("construction returned empty solid"));
        }
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
            object_live: self.object_liveness(solid)?,
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

}
