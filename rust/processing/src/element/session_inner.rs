// SPDX-License-Identifier: MPL-2.0
//! An attempt remains open across reached inner requests and their acceptance.
use super::session_protocol::{WorkKind, WorkPayload};
use super::session_work::{PrimaryOutcome,PartsOutcome};
use super::plan::PrimaryStrategy;
use super::session_state::OwnedJob;
use ifc_lite_geometry::{GeometryRouter, program::{GeometryProgram, ProgramRequest}};
use ifc_lite_core::IfcType;

pub(super) struct PendingGeometryAttempt {
    pub kind: WorkKind,
    pub program: GeometryProgram,
}
impl PendingGeometryAttempt {
    pub fn new(kind:WorkKind,job:&OwnedJob)->Self {
        let program=match kind {
            WorkKind::TypeMap {map_id,..}=>GeometryProgram::type_map_id(map_id),
            WorkKind::Primary {strategy:PrimaryStrategy::TexturedSubmeshes,..}=>GeometryProgram::submeshes(job.entity.clone()),
            WorkKind::Primary {strategy:PrimaryStrategy::VoidedSubmeshes,..}=>GeometryProgram::voided_submeshes(job.entity.clone()),
            WorkKind::VoidedParts=>GeometryProgram::voided_parts(job.entity.clone()),
            WorkKind::PlainParts=>GeometryProgram::parts(job.entity.clone()),
        };
        Self {kind,program}
    }
    pub fn request(&mut self)->Option<ProgramRequest> {
        self.program.request().expect("live inner geometry program")
    }
    pub fn finish(self,job:&OwnedJob,router:&GeometryRouter)->WorkPayload {
        match self.kind {
            WorkKind::TypeMap {..}=>WorkPayload::TypeMap(self.program.finish_type_parts().ok().filter(|parts|!parts.is_empty())),
            WorkKind::Primary {strategy,..}=>WorkPayload::Primary(match self.program.finish_submeshes() {
                Ok(meshes) if !meshes.is_empty()=>PrimaryOutcome::Candidate(meshes),
                Err(_) if strategy==PrimaryStrategy::TexturedSubmeshes && job.ifc_type==IfcType::IfcAnnotation=>PrimaryOutcome::RefusedAnnotation,
                _=>PrimaryOutcome::Retry,
            }),
            WorkKind::VoidedParts=>WorkPayload::VoidedParts(match self.program.finish_parts() {
                Ok(parts) if parts.iter().any(|mesh|!mesh.is_empty())=>PartsOutcome::Geometry(parts),
                Ok(_) if router.host_consumed_by_void(job.id)=>PartsOutcome::ConsumedByOpening,
                _=>PartsOutcome::Retry,
            }),
            WorkKind::PlainParts=>WorkPayload::PlainParts(self.program.finish_parts().unwrap_or_default()),
        }
    }
}

impl PendingGeometryAttempt {
    pub fn retained(kind: WorkKind, job: &OwnedJob, contract: ifc_lite_geometry::program::RetainedContract)
        -> Result<Self, super::session_protocol::WorkError> {
        match kind {
            WorkKind::Primary { strategy: PrimaryStrategy::TexturedSubmeshes, .. } | WorkKind::PlainParts =>
                Ok(Self { kind, program: GeometryProgram::retained_submeshes(job.entity.clone(), contract) }),
            WorkKind::TypeMap {map_id,..}=>Ok(Self {kind,program:GeometryProgram::retained_type_map_id(map_id,contract)}),
            WorkKind::Primary {strategy:PrimaryStrategy::VoidedSubmeshes,..}=>
                Ok(Self {kind,program:GeometryProgram::retained_voided_submeshes(job.entity.clone(),contract)}),
            WorkKind::VoidedParts=>Ok(Self {kind,program:GeometryProgram::retained_voided_parts(job.entity.clone(),contract)}),
        }
    }
}
