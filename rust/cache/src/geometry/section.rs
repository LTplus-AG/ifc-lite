// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The incremental writer for the geometry section described in
//! [`super`](super). The head describes the chunks, but every chunk is final
//! the moment it closes, so [`SectionWriter`] appends chunk records to a
//! [`ChunkBody`] as they close and builds the head last. The in-memory
//! writer's body is a `Vec`, the streaming writer's a spool file; both run
//! this same code.

use crate::buf::{to_uint32, Buf};
use crate::format::Limits;
use crate::CacheError;
use super::chunks::{Grouper, StoredChunk};
use super::coordinate_info::{self, CoordinateInfo};
use super::record::CacheMesh;
/// `validateMeshes`' sanity caps.
const MAX_VERTEX_COUNT: usize = 100_000_000;
const MAX_INDEX_COUNT: usize = 300_000_000;
const DIRECTORY_ENTRY_BYTES: usize = 44;

/// The head bytes every section carries whatever it holds: `meshCount`,
/// `totalVertices`, `totalTriangles`, the smallest `CoordinateInfo`, the
/// v19 source-index pool count and `chunkCount`. The directory is counted
/// per entry on top of this.
const MIN_HEAD_BYTES: u64 = (3 * 4 + coordinate_info::MIN_BYTES + 4 + 4) as u64;

/// Where closed chunk records go, in order, back to back.
pub(crate) trait ChunkBody {
    fn append(&mut self, bytes: &[u8]) -> Result<(), CacheError>;
}

impl ChunkBody for Vec<u8> {
    fn append(&mut self, bytes: &[u8]) -> Result<(), CacheError> {
        self.extend_from_slice(bytes);
        Ok(())
    }
}

/// A chunk's directory entry, its offset still relative to the body.
struct DirectoryEntry {
    aabb: [f32; 6],
    body_offset: u64,
    stored_length: u32,
    uncompressed_length: u32,
    mesh_count: u32,
    flags: u32,
}

/// The finished head (`headLength` through the directory) and what it counts.
pub(crate) struct GeometryHead {
    pub(crate) bytes: Vec<u8>,
    pub(crate) body_length: u64,
    pub(crate) mesh_count: u64,
    pub(crate) skipped_meshes: u64,
    pub(crate) chunk_count: u64,
    pub(crate) total_vertices: u32,
    pub(crate) total_triangles: u32,
    pub(crate) chunk_cells: u64,
    pub(crate) peak_open_chunk_bytes: u64,
}

impl GeometryHead {
    /// The whole section: the head plus the body it addresses.
    pub(crate) fn section_length(&self) -> u64 {
        self.bytes.len() as u64 + self.body_length
    }
}

/// `validateMeshes`: a mesh with absurd counts or with normals that do not
/// pair with its positions is dropped.
fn is_valid(mesh: &CacheMesh) -> bool {
    mesh.positions.len() / 3 <= MAX_VERTEX_COUNT
        && mesh.indices.len() <= MAX_INDEX_COUNT
        && mesh.normals.len() == mesh.positions.len()
}

pub(crate) struct SectionWriter {
    grouper: Grouper,
    directory: Vec<DirectoryEntry>,
    body_length: u64,
    /// The section's absolute offset in the file, so every append can check
    /// the file length it implies against the limit.
    section_start: u64,
    limits: Limits,
    mesh_count: u64,
    skipped_meshes: u64,
    /// `validateMeshes` sums `count / 3` as f64 in mesh order; so does this.
    vertices: f64,
    triangles: f64,
    /// World bounds of every mesh, valid or not (the TS `CoordinateHandler`
    /// sees the meshes before `validateMeshes` does).
    min: [f64; 3],
    max: [f64; 3],
}

impl SectionWriter {
    pub(crate) fn new(compress: bool, section_start: u64, limits: Limits) -> Self {
        Self {
            grouper: Grouper::new(compress),
            directory: Vec::new(),
            body_length: 0,
            section_start,
            limits,
            mesh_count: 0,
            skipped_meshes: 0,
            vertices: 0.0,
            triangles: 0.0,
            min: [f64::INFINITY; 3],
            max: [f64::NEG_INFINITY; 3],
        }
    }

    /// Add the next mesh in emit order.
    pub(crate) fn push(&mut self, mesh: &CacheMesh, body: &mut dyn ChunkBody) -> Result<(), CacheError> {
        self.bound(mesh);
        if !is_valid(mesh) {
            self.skipped_meshes += 1;
            return Ok(());
        }
        self.mesh_count += 1;
        self.vertices += mesh.positions.len() as f64 / 3.0;
        self.triangles += mesh.indices.len() as f64 / 3.0;
        match self.grouper.push(mesh) {
            Some(chunk) => self.append(chunk, body),
            None => Ok(()),
        }
    }

    fn bound(&mut self, mesh: &CacheMesh) {
        for vertex in mesh.positions.chunks_exact(3) {
            for (axis, coordinate) in vertex.iter().enumerate() {
                let value = mesh.origin[axis] + f64::from(*coordinate);
                if value.is_finite() {
                    self.min[axis] = self.min[axis].min(value);
                    self.max[axis] = self.max[axis].max(value);
                }
            }
        }
    }

    fn append(&mut self, chunk: StoredChunk, body: &mut dyn ChunkBody) -> Result<(), CacheError> {
        if self.limits.fail_at_chunk == Some(self.directory.len()) {
            return Err(CacheError::Io {
                context: format!("geometry chunk {}", self.directory.len()),
                source: std::io::Error::other("injected failure"),
            });
        }
        // The section's length field, the head bytes no section can do
        // without, the directory entries through this chunk and the body it
        // would make: a lower bound on the file, so the chunk that crosses
        // the limit is refused before it is written rather than at `finish`.
        let body_length = self.body_length + chunk.bytes.len() as u64;
        let entries = self.directory.len() as u64 + 1;
        let at_least = self.section_start
            + 4
            + MIN_HEAD_BYTES
            + entries * DIRECTORY_ENTRY_BYTES as u64
            + body_length;
        if at_least > self.limits.max_bytes {
            return Err(CacheError::TooLarge(at_least));
        }
        body.append(&chunk.bytes)?;
        self.directory.push(DirectoryEntry {
            aabb: chunk.aabb,
            body_offset: self.body_length,
            stored_length: chunk.bytes.len() as u32,
            uncompressed_length: chunk.uncompressed_length,
            mesh_count: chunk.mesh_count,
            flags: chunk.flags,
        });
        self.body_length = body_length;
        Ok(())
    }

    /// Close the open chunks in their cell order, then build the head over
    /// `info` (bounds filled in here) and the complete directory.
    pub(crate) fn finish(mut self, mut info: CoordinateInfo, body: &mut dyn ChunkBody) -> Result<GeometryHead, CacheError> {
        let grouper = std::mem::replace(&mut self.grouper, Grouper::new(false));
        let chunk_cells = grouper.cells() as u64;
        let peak_open_chunk_bytes = grouper.peak_open_bytes() as u64;
        for chunk in grouper.finish() {
            self.append(chunk, body)?;
        }
        // `originShift` is zero, so the original bounds equal the shifted
        // ones, the relation the TS `CoordinateHandler` keeps; an empty model
        // is all zeros, as `getFinalCoordinateInfo`'s fallback.
        if self.min.iter().chain(&self.max).all(|v| v.is_finite()) {
            info.shifted_bounds = [self.min, self.max];
            info.original_bounds = [self.min, self.max];
        }
        let total_vertices = to_uint32(self.vertices);
        let total_triangles = to_uint32(self.triangles);

        let too_large = |at_least: u64| CacheError::TooLarge(at_least);
        let mut head = Buf::new();
        head.u32(u32::try_from(self.mesh_count).map_err(|_| too_large(self.mesh_count))?);
        head.u32(total_vertices);
        head.u32(total_triangles);
        coordinate_info::write(&mut head, &info);
        // v19 shared appearance source-index pool: empty, as no native mesh
        // carries canonical appearance provenance (see the crate docs).
        head.u32(0);
        head.u32(self.directory.len() as u32);
        let head_length = (head.len() + self.directory.len() * DIRECTORY_ENTRY_BYTES) as u64;
        let file_length = self.section_start + 4 + head_length + self.body_length;
        if file_length > self.limits.max_bytes {
            return Err(too_large(file_length));
        }

        let mut out = Buf::with_capacity(4 + head_length as usize);
        out.u32(u32::try_from(head_length).map_err(|_| too_large(file_length))?);
        out.bytes(&head.into_vec());
        for entry in &self.directory {
            let offset = 4 + head_length + entry.body_offset;
            out.f32s(&entry.aabb);
            out.u32(u32::try_from(offset).map_err(|_| too_large(file_length))?);
            out.u32(entry.stored_length);
            out.u32(entry.uncompressed_length);
            out.u32(entry.mesh_count);
            out.u32(entry.flags);
        }
        Ok(GeometryHead {
            bytes: out.into_vec(),
            body_length: self.body_length,
            mesh_count: self.mesh_count,
            skipped_meshes: self.skipped_meshes,
            chunk_count: self.directory.len() as u64,
            total_vertices,
            total_triangles,
            chunk_cells,
            peak_open_chunk_bytes,
        })
    }
}

#[cfg(test)]
#[path = "section_tests.rs"]
mod tests;
