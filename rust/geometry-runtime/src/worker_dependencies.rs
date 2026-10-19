// SPDX-License-Identifier: MPL-2.0
//! Immutable retained operands in a common object-local metre frame.
use super::{BrepHandle, MeshLimits, RetainedRealization, SmlibWorker, TessellatedMesh, WorkerError};
use crate::protocol::KernelCommand;
use ifc_lite_geometry::document::BooleanOperation;
use crate::RetainedLineage;
use crate::retained_values::{multiply, relative, rigid};
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};

/// Numerical dependency only. Canonical source authority and executor tickets
/// stay with the model owner; a raw handle cannot manufacture this input.
pub enum RetainedDependency<'a> {
    Source { realization: &'a RetainedRealization, world_from_source: [f64; 16] },
    Result(&'a RetainedDependencyResult),
}

/// Immutable operation identity borrowed from the actual sealed output. Handles
/// include the host incarnation and exact session/slot/generation, without any
/// numeric public constructor. The program compares these plus its own stage
/// and sequence before accepting; identity alone is not source authority.
#[derive(Debug, Clone, PartialEq)]
pub struct RetainedOperationIdentity {
    pub left: BrepHandle,
    pub right: BrepHandle,
    pub operation: BooleanOperation,
    pub left_world_from_evaluation: [f64; 16],
    pub right_world_from_evaluation: [f64; 16],
}

/// Exact issued numerical output, owned by its captured object and process.
/// This is not a final-product receipt: opening/representation coverage must be
/// accounted by the existing product executor before final-net publication.
#[derive(Debug)]
pub struct RetainedDependencyResult {
    solid: BrepHandle,
    owner: crate::RuntimeOwner,
    _lease: Arc<super::objects::ManagedObjectLease>,
    object_live: Arc<AtomicBool>,
    mesh: TessellatedMesh,
    world_from_evaluation: [f64; 16],
    lineage: Arc<RetainedLineage>,
    operations: usize,
    identity: RetainedOperationIdentity,
}
impl RetainedDependencyResult {
    pub fn solid(&self) -> BrepHandle { self.solid }
    pub fn outcome(&self) -> crate::NumericalOutcome { self.mesh.outcome() }
    pub fn is_empty(&self) -> bool { self.mesh.is_empty() }
    pub fn mesh(&self) -> &TessellatedMesh { &self.mesh }
    pub fn world_from_evaluation(&self) -> &[f64; 16] { &self.world_from_evaluation }
    pub fn lineage(&self) -> &RetainedLineage { &self.lineage }
    pub fn operation_identity(&self) -> &RetainedOperationIdentity { &self.identity }
    pub fn owner(&self) -> &crate::RuntimeOwner { &self.owner }
    pub fn validate_live(&self) -> Result<(), WorkerError> {
        if self.owner.incarnation() == Some(self.solid.worker) && self.object_live.load(Ordering::Acquire) {
            Ok(())
        } else { Err(WorkerError::WrongWorker) }
    }
}

impl RetainedDependency<'_> {
    fn input(&self) -> Result<(BrepHandle, [f64; 16], Arc<RetainedLineage>, usize), WorkerError> {
        match self {
            Self::Source { realization, world_from_source } => {
                realization.validate_live()?;
                let frame = multiply(*world_from_source, realization.completion().source_from_evaluation);
                rigid(frame).map_err(|e| WorkerError::Authored(e.into()))?;
                Ok((realization.solid(), frame, Arc::new(RetainedLineage::Source {
                    request: Box::new(realization.completion().request().clone()),
                    world_from_source: *world_from_source,
                }), 0))
            }
            Self::Result(result) => {
                result.validate_live()?;
                Ok((result.solid, result.world_from_evaluation, result.lineage.clone(), result.operations))
            }
        }
    }
}
impl SmlibWorker {
    pub(super) fn object_liveness(&self, solid: BrepHandle) -> Result<Arc<AtomicBool>, WorkerError> {
        let wire = self.wire(solid)?;
        self.objects.get(&wire).filter(|live| live.load(Ordering::Acquire)).cloned()
            .ok_or(WorkerError::WrongWorker)
    }

    /// Copy before transforming; neither a shared definition nor an earlier
    /// result is mutated. Matrices are column-major, metres, proper rigid only.
    pub fn copy_transform(&mut self, solid: BrepHandle, column_major: [f64; 16])
        -> Result<BrepHandle, WorkerError>
    {
        rigid(column_major).map_err(|e| WorkerError::Authored(e.into()))?;
        self.object_liveness(solid)?;
        let solid = self.wire(solid)?;
        let bytes = self.call(KernelCommand::CopyTransform { session: self.session, solid, column_major })?;
        self.handle(bytes)
    }

    /// Evaluate two sealed dependencies. Openings use Difference through this
    /// same operation; no second loader or geometry orchestration is introduced.
    /// The left occurrence supplies the common local frame, avoiding world
    /// coordinates in the SDK. The f64 world frame remains outside the kernel.
    pub fn evaluate_retained_boolean(&mut self, left: RetainedDependency<'_>, right: RetainedDependency<'_>,
        operation: BooleanOperation, chord_metres: f64, angle_degrees: f64, limits: MeshLimits)
        -> Result<RetainedDependencyResult, WorkerError>
    {
        let (a, frame, left_lineage, left_count) = left.input()?;
        let (b, right_frame, right_lineage, right_count) = right.input()?;
        self.object_liveness(a)?;
        self.object_liveness(b)?;
        let operations = left_count.checked_add(right_count).and_then(|n| n.checked_add(1))
            .filter(|n| *n <= 128).ok_or(WorkerError::ResourceLimit("retained dependency depth/work"))?;
        // Compute inverse-left * right in f64; subtract translations before
        // rotating to avoid manufacturing far-origin f32 geometry.
        let relative = relative(frame, right_frame).map_err(|e| WorkerError::Authored(e.into()))?;
        let transformed = self.copy_transform(b, relative)?;
        let boolean = self.boolean(a, transformed, operation);
        let cleanup = self.release(transformed);
        let solid = match boolean { Ok(solid) => solid, Err(error) => return Err(error) };
        if let Err(error) = cleanup {
            // release already retired the owner. Preserve the cleanup error;
            // no new work or retry is sent into that domain.
            return Err(error);
        }
        let mesh = match self.tessellate(solid, chord_metres, angle_degrees, limits) {
            Ok(mesh) => mesh,
            Err(error) => {
                if let Err(cleanup) = self.release(solid) { eprintln!("retained boolean cleanup retired owner: {cleanup}"); }
                return Err(error);
            }
        };
        Ok(RetainedDependencyResult {
            _lease: self.manage_object(solid)?,
            object_live: self.object_liveness(solid)?,
            solid, owner: crate::RuntimeOwner::new(self.process_control(), self.identity), mesh,
            world_from_evaluation: frame,
            lineage: Arc::new(RetainedLineage::Boolean { operation, left: left_lineage, right: right_lineage }),
            operations,
            identity: RetainedOperationIdentity { left:a, right:b, operation,
                left_world_from_evaluation:frame, right_world_from_evaluation:right_frame },
        })
    }
}
#[cfg(test)]
#[path = "worker_dependencies_tests.rs"]
mod tests;
