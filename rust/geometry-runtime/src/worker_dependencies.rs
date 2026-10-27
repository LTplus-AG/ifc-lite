// SPDX-License-Identifier: MPL-2.0
//! Retained Boolean operands in one common object-local metre frame. Each
//! result owns its solid through its own managed lease, independently of the
//! receipts it was built from.
use super::{
    rigid, AffineCertificate, BrepHandle, MeshLimits, NumericalOutcome, RetainedAffineCopy,
    RetainedRealization, SmlibWorker, TessellatedMesh, WorkerError,
};
use crate::protocol::BooleanOperation;
use ifc_lite_geometry::document::RetainedRequest;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Deepest admitted chain of retained Boolean and affine-copy operations.
pub(super) const MAX_OPERATIONS: usize = 128;

/// A sealed numerical operand. A raw handle cannot manufacture one.
pub enum RetainedDependency<'a> {
    /// A realization placed by `world_from_source`: column-major, raw
    /// solid-local file units -> world metres. Composed with the request's
    /// frame it must be a proper rigid metre motion.
    Source {
        realization: &'a RetainedRealization,
        world_from_source: [f64; 16],
    },
    /// An earlier result, in its own unchanged world frame.
    Result(&'a RetainedDependencyResult),
    /// Reuse an earlier result at this explicit proper-rigid placement. Replaces
    /// the evaluation-to-world frame; does not compose another occurrence twice.
    #[cfg(feature = "retained-runtime")]
    PlacedResult { result: &'a RetainedDependencyResult, world_from_result: [f64; 16] },
    /// A baked affine copy placed by an explicit proper rigid
    /// `world_from_affine` (column-major, copy metres -> world metres). Never
    /// inferred from authored units or a relative-to-centre origin.
    Affine {
        copy: &'a RetainedAffineCopy,
        world_from_affine: [f64; 16],
    },
}

/// The evaluated operations behind a result, separate from revision-local SDK
/// faces and display data. It records numerical provenance, not complete
/// representation coverage.
#[derive(Debug, Clone)]
pub enum RetainedLineage {
    Source {
        request: Box<RetainedRequest>,
        world_from_source: [f64; 16],
    },
    Boolean {
        operation: BooleanOperation,
        left: Arc<Self>,
        right: Arc<Self>,
    },
    /// A realization's raw authored source in its own evaluation frame, as
    /// the input of an affine copy (no world placement applies to it).
    Definition {
        request: Box<RetainedRequest>,
        source_from_evaluation: [f64; 16],
        evaluation_from_source: [f64; 16],
    },
    /// A bounded affine copy of `input`, in the input's evaluation frame.
    AffineCopy {
        input: Arc<Self>,
        column_major: [f64; 16],
        certificate: AffineCertificate,
    },
    /// An explicit rigid placement of a copied value as a Boolean operand.
    Placed {
        value: Arc<Self>,
        world_from_evaluation: [f64; 16],
    },
}

/// Read-only identity sealed from the actual ordered numerical invocation.
/// This metadata cannot create a result or acquire an object lease.
#[cfg(feature = "retained-runtime")]
#[derive(Debug, Clone, PartialEq)]
pub struct RetainedBooleanIdentity {
    pub operation: BooleanOperation,
    pub left: BrepHandle,
    pub right: BrepHandle,
    pub world_from_left: [f64; 16],
    pub world_from_right: [f64; 16],
}

/// One retained Boolean output, owned by its own object lease. Dropping it
/// releases only this solid; its operands' receipts are unaffected. This is a
/// numerical result, not a final product receipt.
#[derive(Debug)]
pub struct RetainedDependencyResult {
    solid: BrepHandle,
    owner: crate::RuntimeOwner,
    _lease: Arc<super::objects::ManagedObjectLease>,
    object_live: Arc<AtomicBool>,
    mesh: TessellatedMesh,
    #[cfg(feature = "retained-runtime")]
    identity: RetainedBooleanIdentity,
    world_from_evaluation: [f64; 16],
    lineage: Arc<RetainedLineage>,
    operations: usize,
}

impl RetainedDependencyResult {
    /// Immutable actual ordered inputs and their bit-preserved invocation frames.
    #[cfg(feature = "retained-runtime")]
    pub fn operation_identity(&self) -> &RetainedBooleanIdentity { &self.identity }
    pub fn solid(&self) -> BrepHandle {
        self.solid
    }
    /// Sealed from the actual result solid. An empty result is a valid,
    /// independently owned operand of later Booleans, not a failure.
    pub fn outcome(&self) -> NumericalOutcome {
        self.mesh.outcome()
    }
    pub fn is_empty(&self) -> bool {
        self.mesh.is_empty()
    }
    /// Display mesh in the result's evaluation frame; no buffers when empty.
    pub fn mesh(&self) -> &TessellatedMesh {
        &self.mesh
    }
    /// Column-major evaluation metres -> world metres (the left operand's frame).
    pub fn world_from_evaluation(&self) -> &[f64; 16] {
        &self.world_from_evaluation
    }
    pub fn lineage(&self) -> &RetainedLineage {
        &self.lineage
    }
    pub fn owner(&self) -> &crate::RuntimeOwner {
        &self.owner
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
    /// Live solid, shared lineage and operation count, for a further operation.
    pub(super) fn parts(&self) -> Result<(BrepHandle, Arc<RetainedLineage>, usize), WorkerError> {
        self.validate_live()?;
        Ok((self.solid, self.lineage.clone(), self.operations))
    }
}

type Operand = (BrepHandle, [f64; 16], Arc<RetainedLineage>, usize);

impl RetainedDependency<'_> {
    fn operand(&self) -> Result<Operand, WorkerError> {
        match self {
            Self::Source {
                realization,
                world_from_source,
            } => {
                realization.validate_live()?;
                let frame = multiply(
                    *world_from_source,
                    realization.completion().source_from_evaluation,
                );
                rigid(frame).map_err(WorkerError::InvalidArgument)?;
                let lineage = RetainedLineage::Source {
                    request: Box::new(realization.completion().request().clone()),
                    world_from_source: *world_from_source,
                };
                Ok((realization.solid(), frame, Arc::new(lineage), 0))
            }
            Self::Result(result) => {
                let (solid, lineage, operations) = result.parts()?;
                Ok((solid, result.world_from_evaluation, lineage, operations))
            }
            #[cfg(feature = "retained-runtime")]
            Self::PlacedResult { result, world_from_result } => {
                let (solid, value, operations) = result.parts()?;
                rigid(*world_from_result).map_err(WorkerError::InvalidArgument)?;
                let lineage = RetainedLineage::Placed { value, world_from_evaluation: *world_from_result };
                Ok((solid, *world_from_result, Arc::new(lineage), operations))
            }
            Self::Affine {
                copy,
                world_from_affine,
            } => {
                let (solid, value, operations) = copy.parts()?;
                rigid(*world_from_affine).map_err(WorkerError::InvalidArgument)?;
                let lineage = RetainedLineage::Placed {
                    value,
                    world_from_evaluation: *world_from_affine,
                };
                Ok((solid, *world_from_affine, Arc::new(lineage), operations))
            }
        }
    }
}

impl SmlibWorker {
    /// Evaluate two sealed operands. The left operand's frame is the common
    /// local frame, so world coordinates never enter the SDK; the right operand
    /// is copied into it and the copy is released. Both inputs stay unchanged.
    /// A certified-empty result is sealed as [`NumericalOutcome::Empty`].
    pub fn evaluate_retained_boolean(
        &mut self,
        left: RetainedDependency<'_>,
        right: RetainedDependency<'_>,
        operation: BooleanOperation,
        chord_metres: f64,
        angle_degrees: f64,
        limits: MeshLimits,
    ) -> Result<RetainedDependencyResult, WorkerError> {
        let (a, frame, left_lineage, left_count) = left.operand()?;
        let (b, right_frame, right_lineage, right_count) = right.operand()?;
        self.object_liveness(a)?;
        self.object_liveness(b)?;
        let operations = left_count
            .checked_add(right_count)
            .and_then(|n| n.checked_add(1))
            .filter(|&n| n <= MAX_OPERATIONS)
            .ok_or(WorkerError::ResourceLimit("retained dependency depth"))?;
        let relative = relative(frame, right_frame).map_err(WorkerError::InvalidArgument)?;
        let transformed = self.copy_transform(b, relative)?;
        let boolean = self.boolean(a, transformed, operation);
        let cleanup = self.release(transformed);
        // Both ran: report the Boolean failure first. A failed cleanup has
        // already retired the process.
        let solid = boolean?;
        cleanup?;
        let mesh = match self.tessellate(solid, chord_metres, angle_degrees, limits) {
            Ok(mesh) => mesh,
            Err(error) => {
                if self.release(solid).is_err() {
                    self.retire();
                }
                return Err(error);
            }
        };
        Ok(RetainedDependencyResult {
            _lease: self.manage_object(solid)?,
            object_live: self.object_liveness(solid)?,
            solid,
            owner: self.retained_owner(),
            mesh,
            #[cfg(feature = "retained-runtime")]
            identity: RetainedBooleanIdentity { operation, left: a, right: b,
                world_from_left: frame, world_from_right: right_frame },
            world_from_evaluation: frame,
            lineage: Arc::new(RetainedLineage::Boolean {
                operation,
                left: left_lineage,
                right: right_lineage,
            }),
            operations,
        })
    }
}

/// Column-major 4x4 product `a * b`.
fn multiply(a: [f64; 16], b: [f64; 16]) -> [f64; 16] {
    std::array::from_fn(|i| (0..4).map(|k| a[k * 4 + i % 4] * b[i / 4 * 4 + k]).sum())
}

/// `inverse(a) * b` for proper rigid frames. Translations are subtracted
/// before rotating, so survey-scale origins cancel in f64.
fn relative(a: [f64; 16], b: [f64; 16]) -> Result<[f64; 16], &'static str> {
    rigid(a)?;
    rigid(b)?;
    let mut out = [0.; 16];
    out[15] = 1.;
    for col in 0..3 {
        for row in 0..3 {
            out[col * 4 + row] = (0..3).map(|k| a[row * 4 + k] * b[col * 4 + k]).sum();
        }
    }
    for row in 0..3 {
        out[12 + row] = (0..3)
            .map(|k| a[row * 4 + k] * (b[12 + k] - a[12 + k]))
            .sum();
    }
    rigid(out)?;
    Ok(out)
}

#[cfg(test)]
#[path = "worker_dependencies_tests.rs"]
mod tests;
