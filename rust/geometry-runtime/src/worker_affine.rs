// SPDX-License-Identifier: MPL-2.0
//! Separate opcode18 numerical seam. Opcode17 remains proper rigid only.
use super::{BrepHandle, RetainedRealization, SmlibWorker, WorkerError};
use crate::{affine::{validate_affine, AffineCertificate}, protocol::KernelCommand, RuntimeOwner, RetainedLineage};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

/// Input geometry is already in its object's local metre domain. This enum
/// grants no authority to caller-created handles or manufactured lineage.
pub enum RetainedTransformInput<'a> {
    Source(&'a RetainedRealization),
    Result(&'a super::RetainedDependencyResult),
    Affine(&'a RetainedAffineCopy),
}
impl RetainedTransformInput<'_> {
    fn parts(self) -> Result<(BrepHandle, Arc<RetainedLineage>, usize), WorkerError> {
        match self {
            Self::Source(source) => {
                source.validate_live()?;
                let completion=source.completion();
                Ok((source.solid(),Arc::new(RetainedLineage::Definition {
                    request:Box::new(completion.request().clone()),
                    source_from_evaluation:completion.source_from_evaluation,
                    evaluation_from_source:completion.evaluation_from_source }),0))
            }
            Self::Result(result) => {
                result.validate_live()?;
                Ok((result.solid(),Arc::new(result.lineage().clone()),result.operation_count()))
            }
            Self::Affine(copy) => {
                copy.validate_live()?;
                Ok((copy.solid,copy.lineage.clone(),copy.operations))
            }
        }
    }
}
/// Sealed actual operation identity. Keeping this data does not grant a lease.
#[derive(Debug, Clone, PartialEq)]
pub struct AffineCopyIdentity {
    pub input: BrepHandle,
    pub column_major: [f64; 16],
    pub certificate: AffineCertificate,
}
/// Independent session-owned BRep lease; explicitly release through the worker.
/// Dropping the receipt does not retire other objects in its process. Session
/// destruction reclaims any unreleased copy. No tessellation is performed here.
#[derive(Debug)]
pub struct RetainedAffineCopy {
    solid: BrepHandle,
    owner: RuntimeOwner,
    live: Arc<AtomicBool>,
    identity: AffineCopyIdentity,
    lineage: Arc<RetainedLineage>,
    operations: usize,
}
impl RetainedAffineCopy {
    pub fn solid(&self) -> BrepHandle { self.solid }
    pub fn operation_identity(&self) -> &AffineCopyIdentity { &self.identity }
    /// Full immutable ancestry, including original raw source coefficients.
    pub fn lineage(&self) -> &RetainedLineage { &self.lineage }
    pub(super) fn operation_count(&self) -> usize { self.operations }
    pub fn owner(&self) -> &RuntimeOwner { &self.owner }
    pub fn validate_live(&self) -> Result<(), WorkerError> {
        if self.owner.incarnation()==Some(self.solid.worker) && self.live.load(Ordering::Acquire) {
            Ok(())
        } else { Err(WorkerError::WrongWorker) }
    }
}
impl SmlibWorker {
    /// Explicit candidate API, distinct from proper-rigid copy_transform.
    /// Capability means implementation; this does not qualify any target or P1.
    pub fn copy_retained_affine(&mut self, source: RetainedTransformInput<'_>, column_major: [f64; 16])
        -> Result<RetainedAffineCopy, WorkerError>
    {
        validate_affine(&column_major).map_err(|e| WorkerError::Authored(e.into()))?;
        let (input,lineage,count)=source.parts()?;
        self.object_liveness(input)?;
        let operations=count.checked_add(1).filter(|n|*n<=128)
            .ok_or(WorkerError::ResourceLimit("retained affine depth/work"))?;
        let capabilities=self.call(KernelCommand::Capabilities)?;
        if capabilities.len()!=8 || capabilities[..4]!=1u32.to_le_bytes() ||
            u32::from_le_bytes(capabilities[4..].try_into().expect("four bytes"))&16==0 {
            return Err(WorkerError::Kernel { status:7, message:"affine rational copy unavailable".into() });
        }
        let solid=self.wire(input)?;
        let bytes=self.call(KernelCommand::CopyAffine {session:self.session,solid,column_major})?;
        if bytes.len()!=72 { return Err(self.poison("invalid affine result size")); }
        let certificate=AffineCertificate::decode(&bytes[16..]).map_err(|e| self.poison(e))?;
        let solid=self.handle(bytes[..16].to_vec())?;
        let result=RetainedAffineCopy { solid, owner:RuntimeOwner::new(self.process_control(),self.identity),
            live:self.object_liveness(solid)?, identity:AffineCopyIdentity {input,column_major,certificate:certificate.clone()},
            lineage:Arc::new(RetainedLineage::AffineCopy { input:lineage,column_major,certificate }), operations };
        result.validate_live()?;
        Ok(result)
    }
}
