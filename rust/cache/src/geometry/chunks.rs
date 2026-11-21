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
//!
//! [`Grouper`] is that pass made incremental, so the in-memory writer and the
//! streaming one run the same code (#9584): each mesh is serialized into its
//! cell's open chunk as it arrives, a chunk the byte cap closes is handed back
//! at once (it is final, and its place in the output is the order of
//! closing), and [`Grouper::finish`] hands back the chunks still open in their
//! cell's first-insertion order. Nothing but the open chunks' records is held.

use std::collections::HashMap;

use super::record::CacheMesh;
use crate::buf::Buf;
use crate::format::{
    CHUNK_FLAG_DEFLATE_RAW, GEOMETRY_CHUNK_CELL_SIZE, GEOMETRY_CHUNK_COMPRESS_MIN_BYTES,
    GEOMETRY_CHUNK_SOFT_BYTES,
};

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

/// One cell's chunk while it is open: its serialized records and the running
/// `chunkAabb` of what it holds.
struct OpenChunk {
    records: Buf,
    mesh_count: u32,
    min: [f64; 3],
    max: [f64; 3],
}

impl OpenChunk {
    fn new() -> Self {
        Self { records: Buf::new(), mesh_count: 0, min: [f64::INFINITY; 3], max: [f64::NEG_INFINITY; 3] }
    }

    /// Append one record. The bounds are `chunkAabb`'s loop, one member at a
    /// time in member order: world (`origin + position`) in f64 with the TS
    /// comparison order, so a NaN never updates a bound.
    fn add(&mut self, mesh: &CacheMesh) {
        for vertex in mesh.positions.chunks_exact(3) {
            for (axis, coordinate) in vertex.iter().enumerate() {
                let value = mesh.origin[axis] + f64::from(*coordinate);
                if value < self.min[axis] {
                    self.min[axis] = value;
                }
                if value > self.max[axis] {
                    self.max[axis] = value;
                }
            }
        }
        mesh.write(&mut self.records);
        self.mesh_count += 1;
    }

    /// The stored AABB: zeros when the chunk has no vertex, else f32.
    fn aabb(&self) -> [f32; 6] {
        if self.min[0] == f64::INFINITY {
            return [0.0; 6];
        }
        let [min, max] = [self.min, self.max];
        [min[0], min[1], min[2], max[0], max[1], max[2]].map(|v| v as f32)
    }
}

/// One chunk record as stored.
pub(crate) struct StoredChunk {
    pub(crate) bytes: Vec<u8>,
    pub(crate) uncompressed_length: u32,
    pub(crate) mesh_count: u32,
    pub(crate) flags: u32,
    pub(crate) aabb: [f32; 6],
}

/// Close a chunk: above the size floor, deflate-raw its records and keep the
/// compressed form only when strictly smaller (`chooseStoredGeometryChunk`).
fn store(chunk: OpenChunk, compress: bool) -> StoredChunk {
    let aabb = chunk.aabb();
    let raw = chunk.records.into_vec();
    let mut stored = StoredChunk {
        uncompressed_length: raw.len() as u32,
        bytes: raw,
        mesh_count: chunk.mesh_count,
        flags: 0,
        aabb,
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

/// The incremental `groupMeshesIntoChunks`: chunks closed by the byte cap in
/// the order they close, then the still-open chunks in their cell's FIRST
/// insertion order (a JS `Map.set` on an existing key keeps the key's
/// original position, so a cell reopened after the cap keeps its slot).
pub(crate) struct Grouper {
    slot_of: HashMap<CellKey, usize>,
    open: Vec<OpenChunk>,
    compress: bool,
    /// Record bytes held across the open chunks now, and the most so far.
    open_bytes: usize,
    peak_open_bytes: usize,
}

impl Grouper {
    pub(crate) fn new(compress: bool) -> Self {
        Self { slot_of: HashMap::new(), open: Vec::new(), compress, open_bytes: 0, peak_open_bytes: 0 }
    }

    /// Add one mesh; returns the chunk its arrival closed, if any.
    pub(crate) fn push(&mut self, mesh: &CacheMesh) -> Option<StoredChunk> {
        let key = cell_key(mesh);
        let bytes = mesh.record_len();
        let open = &mut self.open;
        let slot = *self.slot_of.entry(key).or_insert_with(|| {
            open.push(OpenChunk::new());
            open.len() - 1
        });
        let chunk = &mut self.open[slot];
        let held = chunk.records.len();
        let closed = if held > 0 && held + bytes > GEOMETRY_CHUNK_SOFT_BYTES {
            self.open_bytes -= held;
            Some(store(std::mem::replace(chunk, OpenChunk::new()), self.compress))
        } else {
            None
        };
        chunk.add(mesh);
        self.open_bytes += bytes;
        self.peak_open_bytes = self.peak_open_bytes.max(self.open_bytes);
        closed
    }

    /// Distinct cells seen. A cell's slot is never released, so this bounds
    /// how many chunks can be open at once.
    pub(crate) fn cells(&self) -> usize {
        self.open.len()
    }

    /// The most record bytes the open chunks held at once.
    pub(crate) fn peak_open_bytes(&self) -> usize {
        self.peak_open_bytes
    }

    /// The chunks still open, in their cell's first-insertion order.
    pub(crate) fn finish(self) -> impl Iterator<Item = StoredChunk> {
        let compress = self.compress;
        self.open.into_iter().filter(|chunk| chunk.mesh_count > 0).map(move |chunk| store(chunk, compress))
    }
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
