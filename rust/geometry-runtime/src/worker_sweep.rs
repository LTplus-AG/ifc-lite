// SPDX-License-Identifier: MPL-2.0
//! One immutable retained construction; no fallback or implicit replay.
use super::{BrepHandle, MeshLimits, SmlibWorker, WorkerError};
use ifc_lite_geometry::document::{
    RegionQualification, RetainedCompletion, RetainedRequest, RetainedTessellation,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Executor-issued binding of one completion to the live solid it describes.
/// Public host-trusted completions cannot construct this receipt.
///
/// The receipt owns its solid: dropping it releases that one object before the
/// worker's next command, and never retires the process or another object.
#[derive(Debug)]
pub struct RetainedRealization {
    solid: BrepHandle,
    completion: RetainedCompletion,
    owner: crate::RuntimeOwner,
    lease: Arc<super::objects::ManagedObjectLease>,
    object_live: Arc<AtomicBool>,
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
    /// Explicit standalone host-trusted escape. Consumes the receipt and hands
    /// the solid to the caller, who must [`SmlibWorker::release`] it; the
    /// returned numerical data cannot recreate runtime authority.
    pub fn into_host_trusted_parts(self) -> (BrepHandle, RetainedCompletion) {
        self.lease.disarm();
        (self.solid, self.completion)
    }
    /// The producing process is live and the solid has not been released.
    pub fn validate_live(&self) -> Result<(), WorkerError> {
        if self.owner.incarnation() == Some(self.solid.worker)
            && self.object_live.load(Ordering::Acquire)
        {
            Ok(())
        } else {
            Err(WorkerError::WrongWorker)
        }
    }
}

impl SmlibWorker {
    /// Independently captured liveness/retirement for this exact process.
    pub fn retained_owner(&self) -> crate::RuntimeOwner {
        crate::RuntimeOwner::new(self.process_control(), self.identity)
    }

    /// Execute one retained source request on the incarnation it was prepared
    /// for. A stale request, or a curved/disk request this incarnation has not
    /// qualified, is refused before anything is uploaded. Only the raw authored
    /// solid is evaluated: no opening, enclosing Boolean or style applies.
    pub fn evaluate_retained(
        &mut self,
        request: RetainedRequest,
        chord_metres: f64,
        angle_degrees: f64,
        limits: MeshLimits,
    ) -> Result<RetainedRealization, WorkerError> {
        if !self.is_live() || request.worker_incarnation() != self.incarnation() {
            return Err(WorkerError::WrongWorker);
        }
        let payload = request.payload();
        let qualified = match payload.qualification {
            RegionQualification::Rectangle => true,
            RegionQualification::OrderedRegion => self.regions_qualified,
            RegionQualification::RationalDisk => self.disks_qualified,
            _ => false,
        };
        if !qualified {
            return Err(WorkerError::Unqualified(
                "execute this incarnation's numerical witnesses first",
            ));
        }
        let solid = self.create_sweep(
            &payload.bytes,
            payload.format,
            payload.loops,
            payload.segments,
        )?;
        let mesh = match self.tessellate(solid, chord_metres, angle_degrees, limits) {
            Ok(mesh) => mesh,
            Err(error) => {
                // Never retain an unpublished object: if its cleanup fails the
                // process is retired. The execution error is reported.
                if self.release(solid).is_err() {
                    self.retire();
                }
                return Err(error);
            }
        };
        // The adapter publishes sweeps only after manifold/positive-volume
        // checks: a certified-empty construction is a contract breach.
        if mesh.is_empty() {
            self.retire();
            return Err(WorkerError::Protocol("retained construction sealed empty"));
        }
        let (source_from_evaluation, evaluation_from_source) = (
            payload.source_from_evaluation,
            payload.evaluation_from_source,
        );
        let tessellation = RetainedTessellation {
            positions: mesh.positions,
            indices: mesh.indices,
            flat_corner_normals: mesh.corner_normals,
            revision_local_faces: mesh.source_faces,
            source_face_count: mesh.source_face_count,
            boundary_edges: mesh.boundary_edges,
            spine_edges: mesh.spine_edges,
        };
        Ok(RetainedRealization {
            lease: self.manage_object(solid)?,
            object_live: self.object_liveness(solid)?,
            owner: self.retained_owner(),
            solid,
            completion: RetainedCompletion::new(
                request,
                tessellation,
                source_from_evaluation,
                evaluation_from_source,
            ),
        })
    }
}
