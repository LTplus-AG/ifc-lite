// SPDX-License-Identifier: MPL-2.0
//! bounded transfer of strict tessellation buffers from retained solids.
use super::{BrepHandle, SmlibWorker, WorkerError};
use crate::protocol::{KernelCommand, MeshStream, MAX_MESH_CHUNK_SCALARS};

/// Maximum aggregate bytes in the returned geometry buffers. Worker-local
/// tessellation memory is separate and needs process-level supervision.
#[derive(Debug, Clone, Copy)]
pub struct MeshLimits {
    pub max_bytes: usize,
}
impl Default for MeshLimits {
    fn default() -> Self {
        Self {
            max_bytes: 256 * 1024 * 1024,
        }
    }
}

/// Approximate display mesh in the BRep's evaluation coordinate frame.
/// Normals are per triangle CORNER, not per shared vertex. Source-face IDs are
/// revision-local indices of the source BRep, not persistent IFC identities.
#[derive(Debug)]
pub struct TessellatedMesh {
    outcome: crate::NumericalOutcome,
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
    pub corner_normals: Vec<f64>,
    pub source_faces: Vec<u32>,
    pub source_face_count: u32,
    pub boundary_edges: u32,
    pub spine_edges: u32,
}

impl TessellatedMesh {
    pub fn outcome(&self) -> crate::NumericalOutcome { self.outcome }
    pub fn is_empty(&self) -> bool { self.outcome == crate::NumericalOutcome::Empty }
}

impl SmlibWorker {
    /// Queries the actual retained SDK solid; zero volume/buffers are no proof.
    pub fn is_empty(&mut self, solid: BrepHandle) -> Result<bool, WorkerError> {
        let solid = self.wire(solid)?;
        let capabilities = self.call(KernelCommand::Capabilities)?;
        if capabilities.len() != 8 || capabilities[..4] != 1u32.to_le_bytes()
            || u32::from_le_bytes(capabilities[4..].try_into().expect("four bytes")) & 32 == 0 {
            return Err(self.poison("missing semantic empty query capability"));
        }
        let bytes = self.call(KernelCommand::IsEmpty { session: self.session, solid })?;
        let value: [u8; 4] = self.fixed(bytes)?;
        match u32::from_le_bytes(value) {
            0 => Ok(false), 1 => Ok(true),
            _ => Err(self.poison("invalid semantic empty query result")),
        }
    }

    /// Tessellate a retained solid without consuming it, then copy the owned
    /// result in bounded frames and release the worker's mesh handle on every
    /// reported success/failure path. Strict worker tessellation refuses partial
    /// failed faces. Buffers retain f64 positions before display narrowing.
    pub fn tessellate(
        &mut self,
        solid: BrepHandle,
        chord_metres: f64,
        angle_degrees: f64,
        limits: MeshLimits,
    ) -> Result<TessellatedMesh, WorkerError> {
        let empty = self.is_empty(solid)?;
        let solid = self.wire(solid)?;
        let bytes = self.call(KernelCommand::Tessellate {
            session: self.session,
            solid,
            chord_metres,
            angle_degrees,
        })?;
        let mesh = self.handle(bytes)?;
        let result = self.read_mesh(mesh, limits, empty);
        let released = self.release(mesh);
        if released.is_err() {
            self.retire();
        }
        match (result, released) {
            (Ok(mesh), Ok(())) => Ok(mesh),
            (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        }
    }

    fn read_mesh(
        &mut self,
        mesh: BrepHandle,
        limits: MeshLimits,
        empty: bool,
    ) -> Result<TessellatedMesh, WorkerError> {
        let object = self.wire(mesh)?;
        let bytes = self.call(KernelCommand::MeshInfo {
            session: self.session,
            mesh: object,
        })?;
        let info: [u8; 24] = self.fixed(bytes)?;
        let field = |i| u32::from_le_bytes(info[i..i + 4].try_into().expect("four bytes"));
        let vertices = field(0) as usize;
        let triangles = field(4) as usize;
        let source_face_count = field(8);
        let boundary_edges = field(12);
        let spine_edges = field(16);
        let consistent = if empty {
            info.iter().all(|&byte| byte == 0)
        } else { vertices > 0 && triangles > 0 && source_face_count > 0 };
        if !consistent || boundary_edges != 0 || spine_edges != 0 || field(20) != 0 {
            return Err(self.poison("partial tessellation returned as success"));
        }
        let positions = multiply(vertices, 3)?;
        let indices = multiply(triangles, 3)?;
        let normals = multiply(triangles, 9)?;
        let size = multiply(positions, 8)?
            .checked_add(multiply(indices, 4)?)
            .and_then(|n| n.checked_add(multiply(normals, 8).ok()?))
            .and_then(|n| n.checked_add(multiply(triangles, 4).ok()?))
            .ok_or(WorkerError::ResourceLimit("mesh byte count overflow"))?;
        if size > limits.max_bytes {
            return Err(WorkerError::ResourceLimit("mesh exceeds max_bytes"));
        }
        let positions = self.read_f64(mesh, MeshStream::Positions, positions)?;
        let indices = self.read_u32(mesh, MeshStream::Indices, indices)?;
        let source_faces = self.read_u32(mesh, MeshStream::SourceFaces, triangles)?;
        let corner_normals = self.read_f64(mesh, MeshStream::CornerNormals, normals)?;
        if indices.iter().any(|&index| index as usize >= vertices)
            || source_faces.iter().any(|&face| face >= source_face_count)
        {
            return Err(self.poison("mesh index or source face out of bounds"));
        }
        Ok(TessellatedMesh {
            outcome: if empty { crate::NumericalOutcome::Empty } else { crate::NumericalOutcome::NonEmpty },
            positions,
            indices,
            corner_normals,
            source_faces,
            source_face_count,
            boundary_edges,
            spine_edges,
        })
    }

    fn read_f64(
        &mut self,
        mesh: BrepHandle,
        stream: MeshStream,
        count: usize,
    ) -> Result<Vec<f64>, WorkerError> {
        let mut values = Vec::new();
        values
            .try_reserve_exact(count)
            .map_err(|_| WorkerError::ResourceLimit("f64 allocation refused"))?;
        for offset in (0..count).step_by(MAX_MESH_CHUNK_SCALARS as usize) {
            let n = (count - offset).min(MAX_MESH_CHUNK_SCALARS as usize);
            let bytes = self.read_chunk(mesh, stream, offset, n)?;
            if bytes.len() != n * 8 {
                return Err(self.poison("wrong f64 chunk length"));
            }
            for bytes in bytes.chunks_exact(8) {
                let value = f64::from_le_bytes(bytes.try_into().expect("eight bytes"));
                if !value.is_finite() {
                    return Err(self.poison("nonfinite mesh scalar"));
                }
                values.push(value);
            }
        }
        Ok(values)
    }

    fn read_u32(
        &mut self,
        mesh: BrepHandle,
        stream: MeshStream,
        count: usize,
    ) -> Result<Vec<u32>, WorkerError> {
        let mut values = Vec::new();
        values
            .try_reserve_exact(count)
            .map_err(|_| WorkerError::ResourceLimit("u32 allocation refused"))?;
        for offset in (0..count).step_by(MAX_MESH_CHUNK_SCALARS as usize) {
            let n = (count - offset).min(MAX_MESH_CHUNK_SCALARS as usize);
            let bytes = self.read_chunk(mesh, stream, offset, n)?;
            if bytes.len() != n * 4 {
                return Err(self.poison("wrong u32 chunk length"));
            }
            values.extend(
                bytes
                    .chunks_exact(4)
                    .map(|b| u32::from_le_bytes(b.try_into().expect("four bytes"))),
            );
        }
        Ok(values)
    }

    fn read_chunk(
        &mut self,
        mesh: BrepHandle,
        stream: MeshStream,
        offset: usize,
        count: usize,
    ) -> Result<Vec<u8>, WorkerError> {
        let offset = u32::try_from(offset)
            .map_err(|_| WorkerError::ResourceLimit("stream offset overflow"))?;
        let mesh = self.wire(mesh)?;
        self.call(KernelCommand::MeshRead {
            session: self.session,
            mesh,
            stream,
            offset,
            count: count as u32,
        })
    }
}

fn multiply(count: usize, stride: usize) -> Result<usize, WorkerError> {
    count
        .checked_mul(stride)
        .ok_or(WorkerError::ResourceLimit("mesh size overflow"))
}
