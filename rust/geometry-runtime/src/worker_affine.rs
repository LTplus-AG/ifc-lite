// SPDX-License-Identifier: MPL-2.0
//! Bounded general affine copies (opcode 18). The proper-rigid
//! `copy_transform` (opcode 17) is unchanged. A copy is an exact
//! rationalizable representation conversion with floating-point
//! transformation: never exact arithmetic, a product receipt or a target
//! qualification. Policy and SDK sources: native/smlib-adapter/src/affine.cpp.
use super::dependencies::MAX_OPERATIONS;
use super::{BrepHandle, RetainedDependencyResult, RetainedLineage, RetainedRealization};
use super::{SmlibWorker, WorkerError};
use crate::protocol::KernelCommand;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Adapter capability bit of the affine rational copy (opcode 18).
const AFFINE_COPY: u32 = 16;
/// Handle plus u32 version, representation and twelve class counters.
const REPLY_BYTES: usize = 16 + 4 * 14;
/// Per-family bound on certified unique geometry objects.
const MAX_CLASS_OBJECTS: u64 = 100_000;

/// Counts of unique SDK geometry objects of the source, in this fixed order:
/// curve BSpline/Line/Circle/Ellipse/Parabola/Hyperbola, then surface
/// BSpline/Plane/Cylinder/Cone/Sphere/Torus. Every other class refuses before
/// copying. The counters are not face or edge identities.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AffineCertificate {
    source_classes: [u32; 12],
}

impl AffineCertificate {
    pub fn source_classes(&self) -> &[u32; 12] {
        &self.source_classes
    }
    /// Representation of the copied BRep: every curve and surface generic rational.
    pub fn representation(&self) -> &'static str {
        "generic-rational-brep-v1"
    }
    fn decode(bytes: &[u8]) -> Result<Self, &'static str> {
        let word =
            |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
        if bytes.len() != 56 || word(0) != 1 || word(4) != 1 {
            return Err("invalid affine conversion certificate");
        }
        let source_classes: [u32; 12] = std::array::from_fn(|i| word(8 + 4 * i));
        let total = |classes: &[u32]| classes.iter().map(|&n| u64::from(n)).sum::<u64>();
        if total(&source_classes[..6]) > MAX_CLASS_OBJECTS
            || total(&source_classes[6..]) > MAX_CLASS_OBJECTS
        {
            return Err("affine certificate exceeds class budget");
        }
        Ok(Self { source_classes })
    }
}

/// Cheap admission before dispatch. The adapter's SVD enforces the singular
/// value, conditioning and reconstruction policy.
fn validate_affine(m: &[f64; 16]) -> Result<(), &'static str> {
    if !m.iter().all(|x| x.is_finite() && x.abs() <= 1e9)
        || m[3] != 0.
        || m[7] != 0.
        || m[11] != 0.
        || m[15] != 1.
    {
        return Err("expected a finite bounded affine matrix");
    }
    let det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2])
        + m[8] * (m[1] * m[6] - m[5] * m[2]);
    if det == 0. {
        return Err("singular affine matrix");
    }
    Ok(())
}

/// A sealed value to copy, in its own evaluation metre frame. A raw handle
/// cannot manufacture one.
pub enum RetainedTransformInput<'a> {
    Source(&'a RetainedRealization),
    Result(&'a RetainedDependencyResult),
    Affine(&'a RetainedAffineCopy),
}

type Input = (BrepHandle, Arc<RetainedLineage>, usize);

impl RetainedTransformInput<'_> {
    fn parts(&self) -> Result<Input, WorkerError> {
        match self {
            Self::Source(source) => {
                source.validate_live()?;
                let completion = source.completion();
                let lineage = RetainedLineage::Definition {
                    request: Box::new(completion.request().clone()),
                    source_from_evaluation: completion.source_from_evaluation,
                    evaluation_from_source: completion.evaluation_from_source,
                };
                Ok((source.solid(), Arc::new(lineage), 0))
            }
            Self::Result(result) => result.parts(),
            Self::Affine(copy) => copy.parts(),
        }
    }
}

/// The actual operation behind a copy. Keeping it grants no lease.
#[derive(Debug, Clone, PartialEq)]
pub struct AffineCopyIdentity {
    pub input: BrepHandle,
    pub column_major: [f64; 16],
    pub certificate: AffineCertificate,
}

/// One affine copy, owned by its own managed lease and independent of its
/// input: dropping it releases only this solid, and releasing the input leaves
/// it live. No tessellation happens here.
#[derive(Debug)]
pub struct RetainedAffineCopy {
    solid: BrepHandle,
    owner: crate::RuntimeOwner,
    _lease: Arc<super::objects::ManagedObjectLease>,
    object_live: Arc<AtomicBool>,
    identity: AffineCopyIdentity,
    lineage: Arc<RetainedLineage>,
    operations: usize,
}

impl RetainedAffineCopy {
    pub fn solid(&self) -> BrepHandle {
        self.solid
    }
    pub fn operation_identity(&self) -> &AffineCopyIdentity {
        &self.identity
    }
    /// Full immutable ancestry, down to the raw authored source requests.
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
    pub(super) fn parts(&self) -> Result<Input, WorkerError> {
        self.validate_live()?;
        Ok((self.solid, self.lineage.clone(), self.operations))
    }
}

impl SmlibWorker {
    /// Copy a sealed value under a bounded general affine column-major matrix,
    /// in that value's evaluation frame. The input is never modified. A refused
    /// matrix or source class leaves the worker and input live; a failure after
    /// the copy started (status 8) retires this process and every object in it.
    pub fn copy_retained_affine(
        &mut self,
        input: RetainedTransformInput<'_>,
        column_major: [f64; 16],
    ) -> Result<RetainedAffineCopy, WorkerError> {
        validate_affine(&column_major).map_err(WorkerError::InvalidArgument)?;
        let (source, lineage, count) = input.parts()?;
        self.object_liveness(source)?;
        let operations = count
            .checked_add(1)
            .filter(|&n| n <= MAX_OPERATIONS)
            .ok_or(WorkerError::ResourceLimit("retained operation depth"))?;
        if self.capabilities()? & AFFINE_COPY == 0 {
            return Err(WorkerError::Protocol(
                "affine rational copy extension unavailable",
            ));
        }
        let solid = self.wire(source)?;
        let bytes = self.call(KernelCommand::CopyAffine {
            session: self.session,
            solid,
            column_major,
        })?;
        if bytes.len() != REPLY_BYTES {
            return Err(self.poison("invalid affine copy reply size"));
        }
        let certificate = AffineCertificate::decode(&bytes[16..]).map_err(|e| self.poison(e))?;
        let solid = self.handle(bytes[..16].to_vec())?;
        Ok(RetainedAffineCopy {
            _lease: self.manage_object(solid)?,
            object_live: self.object_liveness(solid)?,
            owner: self.retained_owner(),
            solid,
            identity: AffineCopyIdentity {
                input: source,
                column_major,
                certificate: certificate.clone(),
            },
            lineage: Arc::new(RetainedLineage::AffineCopy {
                input: lineage,
                column_major,
                certificate,
            }),
            operations,
        })
    }
}

#[cfg(test)]
#[path = "worker_affine_tests.rs"]
mod tests;
