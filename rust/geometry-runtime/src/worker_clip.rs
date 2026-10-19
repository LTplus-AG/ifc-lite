// SPDX-License-Identifier: MPL-2.0
//! Sealed unary clip over the existing finite-domain opcode20 implementation.
use super::{BrepHandle, MeshLimits, RetainedDependency, SmlibWorker, TessellatedMesh, WorkerError};
use crate::{plane::{validate_plane, PlaneCertificate}, protocol::KernelCommand,
    NumericalOutcome, PlaneClipMode, PlaneSide, RetainedLineage, RuntimeOwner};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

#[derive(Debug, Clone, PartialEq)]
pub struct PlaneClipIdentity {
    pub input: BrepHandle,
    pub output: BrepHandle,
    pub plane: [f64;6],
    pub side: PlaneSide,
    pub mode: PlaneClipMode,
    pub world_from_evaluation: [f64;16],
    /// Shared immutable evidence, also retained by the numerical lineage.
    pub certificate: Arc<PlaneCertificate>,
}
/// Immutable operation-derived value, never an authored completion or recipe.
#[derive(Debug)]
pub struct RetainedPlaneClip {
    solid: BrepHandle,
    owner: RuntimeOwner,
    live: Arc<AtomicBool>,
    _lease: Arc<super::objects::ManagedObjectLease>,
    identity: PlaneClipIdentity,
    lineage: Arc<RetainedLineage>,
    operations: usize,
    mesh: TessellatedMesh,
}
impl RetainedPlaneClip {
    pub fn solid(&self) -> BrepHandle { self.solid }
    pub fn operation_identity(&self) -> &PlaneClipIdentity { &self.identity }
    pub fn lineage(&self) -> &RetainedLineage { &self.lineage }
    pub fn world_from_evaluation(&self) -> &[f64;16] { &self.identity.world_from_evaluation }
    pub fn mesh(&self) -> &TessellatedMesh { &self.mesh }
    pub fn outcome(&self) -> NumericalOutcome { self.mesh.outcome() }
    pub fn is_empty(&self) -> bool { self.mesh.is_empty() }
    pub fn owner(&self) -> &RuntimeOwner { &self.owner }
    pub(super) fn operation_count(&self) -> usize { self.operations }
    pub fn validate_live(&self) -> Result<(), WorkerError> {
        if self.owner.incarnation()==Some(self.solid.worker) && self.live.load(Ordering::Acquire) {
            Ok(())
        } else { Err(WorkerError::WrongWorker) }
    }
}
impl SmlibWorker {
    /// The plane is in the selected actual BRep's local metres. Its world frame
    /// is preserved separately and is never baked into the SDK plane or solid.
    /// A success is a numerical candidate, not whole-product qualification.
    // Keep the explicit plane/side/mode distinct from display transfer limits.
    #[allow(clippy::too_many_arguments)]
    pub fn clip_retained_plane(&mut self, source: RetainedDependency<'_>, plane: [f64;6],
        side: PlaneSide, mode: PlaneClipMode, chord: f64, angle: f64, limits: MeshLimits)
        -> Result<RetainedPlaneClip, WorkerError>
    {
        validate_plane(&plane).map_err(|e|WorkerError::Authored(e.into()))?;
        if !chord.is_finite() || chord<=0. || !angle.is_finite() || angle<=0. || angle>180. || limits.max_bytes==0 {
            return Err(WorkerError::ResourceLimit("invalid plane tessellation limits"));
        }
        let (input,frame,lineage,count)=source.input()?;
        crate::retained_values::rigid(frame).map_err(|e|WorkerError::Authored(e.into()))?;
        self.object_liveness(input)?; // Reject foreign/released before any cleanup/dispatch.
        let operations=count.checked_add(1).filter(|n|*n<=128)
            .ok_or(WorkerError::ResourceLimit("retained clip depth/work"))?;
        let capabilities=self.call(KernelCommand::Capabilities)?;
        if capabilities.len()!=8 || capabilities[..4]!=1u32.to_le_bytes() {
            return Err(self.poison("invalid plane capability payload"));
        }
        if u32::from_le_bytes(capabilities[4..].try_into().expect("four bytes"))&64==0 {
            return Err(WorkerError::Kernel {status:7,message:"finite plane clipping unavailable".into()});
        }
        let wire=self.wire(input)?;
        let bytes=match self.call(KernelCommand::ClipPlane {session:self.session,solid:wire,plane,side:side.code(),mode:mode.code()}) {
            Err(error @ WorkerError::Kernel {status,..}) if !(1..=7).contains(&status) => {
                self.retire(); return Err(error);
            }
            result => result?,
        };
        let certificate=Arc::new(PlaneCertificate::decode(&bytes,wire,plane,side,mode).map_err(|e|self.poison(e))?);
        let solid=self.handle(certificate.output().to_bytes().to_vec())?;
        let lease=self.manage_object(solid)?;
        // The managed lease owns every later failure path. Typed refusal keeps
        // healthy inputs; uncertain/certificate failures retire the actual owner.
        let mesh=self.tessellate(solid,chord,angle,limits)?;
        if mesh.outcome()!=certificate.outcome() { return Err(self.poison("plane Empty classification mismatch")); }
        self.object_liveness(input)?;
        let result=RetainedPlaneClip { solid, owner:self.retained_owner(),live:self.object_liveness(solid)?,
            _lease:lease,mesh,operations,
            identity:PlaneClipIdentity {input,output:solid,plane,side,mode,world_from_evaluation:frame,certificate:Arc::clone(&certificate)},
            lineage:Arc::new(RetainedLineage::PlaneClip {input:lineage,plane,side,mode,
                world_from_evaluation:frame,certificate}) };
        result.validate_live()?;
        Ok(result)
    }
}
