// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Numeric ownership for already-composed imported USD tessellation.
//! No STEP identifiers, source parser, renderer or host callbacks are required.
pub mod scene;
pub mod graph;
mod graph_packet;
mod math;
mod packet;
pub use math::{compute_normal_matrix, compute_normals, stage_transform, stage_values};
pub use packet::process_packet;

use std::sync::Arc;

pub type RawMatrix = Vec<Vec<f64>>;
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ImportIdentity {
    pub store: u64,
    pub revision: u64,
    pub definition: u64,
    pub occurrence: u64,
}
#[derive(Clone, Debug)]
pub struct RawMesh {
    pub points: Vec<Vec<f64>>,
    pub face_vertex_indices: Vec<f64>,
    pub face_vertex_counts: Option<Vec<f64>>,
    pub normals: Option<Vec<Vec<f64>>>,
}
#[derive(Clone, Debug)]
pub enum ImportedSource { Mesh(RawMesh), Points(Vec<f64>) }
#[derive(Clone, Debug)]
pub struct ImportedDefinition {
    pub identity: ImportIdentity,
    pub source: ImportedSource,
    pub transform_stack: Vec<RawMatrix>,
}
#[derive(Clone, Debug)]
pub struct ReadyOperation { definition: Arc<ImportedDefinition>, seal: Arc<()> }
impl ReadyOperation {
    pub fn definition(&self) -> &ImportedDefinition { &self.definition }
}
#[derive(Clone, Debug)]
pub struct MeshOutput { pub positions: Vec<f32>, pub normals: Vec<f32>, pub indices: Vec<u32> }
#[derive(Clone, Debug)]
pub struct PointsOutput { pub positions: Vec<f32>, pub min: [f64; 3], pub max: [f64; 3] }
#[derive(Clone, Debug)]
pub enum ImportedOutput { Mesh(MeshOutput), Points(PointsOutput) }
#[derive(Clone, Debug)]
pub struct ExecutedOperation { identity: ImportIdentity, output: ImportedOutput, seal: Arc<()> }
impl ExecutedOperation {
    pub fn identity(&self) -> ImportIdentity { self.identity }
    pub fn output(&self) -> &ImportedOutput { &self.output }
}
#[derive(Clone, Debug)]
pub struct ImportedAssembly { pub definition: ImportedDefinition, pub output: ImportedOutput }
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportError { HomogeneousMesh, HomogeneousPoints, IdentityMismatch, InvalidPacket }
impl std::fmt::Display for ImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::HomogeneousMesh => "IFCx geometry: usd::xformop produces non-finite homogeneous w; matrix is malformed or singular",
            Self::HomogeneousPoints => "IFCx pointcloud: usd::xformop produces non-finite homogeneous w; matrix is malformed or singular",
            Self::IdentityMismatch => "Imported geometry: stale operation identity",
            Self::InvalidPacket => "Imported geometry: invalid binary packet",
        })
    }
}
impl std::error::Error for ImportError {}
pub fn plan(definition: ImportedDefinition) -> ReadyOperation { ReadyOperation { definition: Arc::new(definition), seal: Arc::new(()) } }
pub fn execute(op: &ReadyOperation) -> Result<ExecutedOperation, ImportError> {
    let d = &op.definition;
    let output = match &d.source {
        ImportedSource::Mesh(mesh) => ImportedOutput::Mesh(math::mesh(mesh, &d.transform_stack)?),
        ImportedSource::Points(points) => ImportedOutput::Points(math::points(points, &d.transform_stack)?),
    };
    Ok(ExecutedOperation { identity: d.identity, output, seal: Arc::clone(&op.seal) })
}
pub fn assemble(op: ReadyOperation, executed: ExecutedOperation) -> Result<ImportedAssembly, ImportError> {
    if !Arc::ptr_eq(&op.seal, &executed.seal) || op.definition.identity != executed.identity { return Err(ImportError::IdentityMismatch); }
    let definition = Arc::try_unwrap(op.definition).unwrap_or_else(|shared| (*shared).clone());
    Ok(ImportedAssembly { definition, output: executed.output })
}

#[cfg(test)]
mod tests;
