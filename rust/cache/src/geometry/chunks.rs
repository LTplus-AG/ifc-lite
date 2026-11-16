// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Chunk grouping, chunk AABBs and per-chunk storage: `groupMeshesIntoChunks`,
//! `chunkAabb` and `buildGeometrySectionV13`'s record build in
//! `sections/geometry-chunks.ts`.
//!
//! Grouping is single-pass over the meshes in the order given, which here is
//! the pipeline's emit order (pinned by the mesh-determinism contract), so
//! the chunk list is a pure function of the input and independent of thread
//! count. That is the canonical order; no batch-completion order reaches it.

use std::collections::HashMap;

use crate::format::{
    CHUNK_FLAG_DEFLATE_RAW, GEOMETRY_CHUNK_CELL_SIZE, GEOMETRY_CHUNK_COMPRESS_MIN_BYTES,
    GEOMETRY_CHUNK_SOFT_BYTES,
};
use crate::buf::Buf;
use super::record::CacheMesh;

/// A grid cell, or `None` for the TS `'nan'` cell. Each axis is
/// `floor(anchor / 32)` as f64 bits with the sign of zero folded, which is
/// exactly when the TS template-literal keys (`"cx,cy,cz"`) are equal.
type CellKey = Option<[u64; 3]>;

fn cell_key(mesh: &CacheMesh) -> CellKey {
    let anchor = mesh.anchor();
    let mut key = [0u64; 3];
    for axis in 0..3 {
        let cell = (anchor[axis] / GEOMETRY_CHUNK_CELL_SIZE).floor();
        if !cell.is_finite() {
            return None;
        }
        key[axis] = (cell + 0.0).to_bits();
    }
    Some(key)
}

/// Mesh indices per chunk, in the order the TS writer lays chunks out: each
/// chunk closed by the byte cap as it closes, then the still-open chunks in
/// their cell's FIRST insertion order (a JS `Map.set` on an existing key keeps
/// the key's original position).
pub(crate) fn group(meshes: &[CacheMesh]) -> Vec<Vec<usize>> {
    let mut slot_of: HashMap<CellKey, usize> = HashMap::new();
    let mut open: Vec<(Vec<usize>, usize)> = Vec::new();
    let mut closed: Vec<Vec<usize>> = Vec::new();
    for (at, mesh) in meshes.iter().enumerate() {
        let key = cell_key(mesh);
        let bytes = mesh.record_len();
        let slot = *slot_of.entry(key).or_insert_with(|| {
            open.push((Vec::new(), 0));
            open.len() - 1
        });
        let chunk = &mut open[slot];
        if chunk.1 > 0 && chunk.1 + bytes > GEOMETRY_CHUNK_SOFT_BYTES {
            closed.push(std::mem::take(&mut chunk.0));
            chunk.1 = 0;
        }
        chunk.0.push(at);
        chunk.1 += bytes;
    }
    closed.extend(open.into_iter().map(|(members, _)| members).filter(|m| !m.is_empty()));
    closed
}

/// `chunkAabb`: world (`origin + position`) bounds accumulated in f64 with
/// the TS comparison order (a NaN never updates a bound), zeros when the
/// chunk has no vertex, stored as f32.
pub(crate) fn aabb(meshes: &[CacheMesh], members: &[usize]) -> [f32; 6] {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for &at in members {
        let mesh = &meshes[at];
        for vertex in mesh.positions.chunks_exact(3) {
            for axis in 0..3 {
                let value = mesh.origin[axis] + f64::from(vertex[axis]);
                if value < min[axis] {
                    min[axis] = value;
                }
                if value > max[axis] {
                    max[axis] = value;
                }
            }
        }
    }
    if min[0] == f64::INFINITY {
        return [0.0; 6];
    }
    [min[0], min[1], min[2], max[0], max[1], max[2]].map(|v| v as f32)
}

/// One chunk record as stored.
pub(crate) struct StoredChunk {
    pub(crate) bytes: Vec<u8>,
    pub(crate) uncompressed_length: u32,
    pub(crate) mesh_count: u32,
    pub(crate) flags: u32,
    pub(crate) aabb: [f32; 6],
}

/// Serialize a chunk's records; above the size floor, deflate-raw it and keep
/// the compressed form only when strictly smaller (`chooseStoredGeometryChunk`).
pub(crate) fn store(meshes: &[CacheMesh], members: &[usize], compress: bool) -> StoredChunk {
    let mut buf = Buf::with_capacity(members.iter().map(|&at| meshes[at].record_len()).sum());
    for &at in members {
        meshes[at].write(&mut buf);
    }
    let raw = buf.into_vec();
    let uncompressed_length = raw.len() as u32;
    let mut stored = StoredChunk {
        bytes: raw,
        uncompressed_length,
        mesh_count: members.len() as u32,
        flags: 0,
        aabb: aabb(meshes, members),
    };
    if compress && stored.bytes.len() >= GEOMETRY_CHUNK_COMPRESS_MIN_BYTES {
        let deflated = deflate_raw(&stored.bytes);
        if deflated.len() < stored.bytes.len() {
            stored.bytes = deflated;
            stored.flags = CHUNK_FLAG_DEFLATE_RAW;
        }
    }
    stored
}

/// The writer's one chunk compressor: raw DEFLATE (no zlib header), the
/// `DeflateRaw` storage. The conformance gate reads its output length through
/// [`crate::deflate_raw_len`] to check a raw chunk was not compressible.
pub(crate) fn deflate_raw(bytes: &[u8]) -> Vec<u8> {
    miniz_oxide::deflate::compress_to_vec(bytes, 6)
}

#[cfg(test)]
#[path = "chunks_tests.rs"]
mod tests;
