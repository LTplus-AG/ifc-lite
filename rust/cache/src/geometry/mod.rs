// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The chunked geometry section (`buildGeometrySectionV13`):
//!
//!   headLength u32   (bytes after this field, up to the first chunk)
//!   meshCount u32, totalVertices u32, totalTriangles u32,
//!   coordinateInfo, sourceIndexPool (v19: count u32 + arrays),
//!   chunkCount u32, directory[chunkCount] x 44 bytes
//!     { aabbMin f32x3, aabbMax f32x3, byteOffset u32 (from section start),
//!       byteLength u32 (stored), uncompressedLength u32, meshCount u32,
//!       flags u32 }
//!   chunk records, back to back from `4 + headLength`

pub(crate) mod chunks;
pub(crate) mod coordinate_info;
pub(crate) mod record;

use crate::buf::{to_uint32, Buf};
use coordinate_info::CoordinateInfo;
use record::CacheMesh;

/// `validateMeshes`' sanity caps.
const MAX_VERTEX_COUNT: usize = 100_000_000;
const MAX_INDEX_COUNT: usize = 300_000_000;
const DIRECTORY_ENTRY_BYTES: usize = 44;

pub(crate) struct GeometrySection {
    pub(crate) bytes: Vec<u8>,
    pub(crate) mesh_count: u32,
    pub(crate) total_vertices: u32,
    pub(crate) total_triangles: u32,
    pub(crate) chunk_count: u32,
    /// Meshes `validateMeshes` would have dropped.
    pub(crate) skipped_meshes: u32,
}

/// `validateMeshes`: drop a mesh with absurd counts or with normals that do
/// not pair with its positions, and total what survives. The triangle total
/// sums `indexCount / 3` as f64 and is stored through `ToUint32`, like TS.
fn validate(meshes: Vec<CacheMesh>) -> (Vec<CacheMesh>, u32, u32, u32) {
    let before = meshes.len();
    let valid: Vec<CacheMesh> = meshes
        .into_iter()
        .filter(|mesh| {
            mesh.positions.len() / 3 <= MAX_VERTEX_COUNT
                && mesh.indices.len() <= MAX_INDEX_COUNT
                && mesh.normals.len() == mesh.positions.len()
        })
        .collect();
    let vertices: f64 = valid.iter().map(|m| m.positions.len() as f64 / 3.0).sum();
    let triangles: f64 = valid.iter().map(|m| m.indices.len() as f64 / 3.0).sum();
    let skipped = (before - valid.len()) as u32;
    (valid, to_uint32(vertices), to_uint32(triangles), skipped)
}

pub(crate) fn build(meshes: Vec<CacheMesh>, info: &CoordinateInfo, compress: bool) -> GeometrySection {
    let (meshes, total_vertices, total_triangles, skipped_meshes) = validate(meshes);
    let stored: Vec<chunks::StoredChunk> = chunks::group(&meshes)
        .iter()
        .map(|members| chunks::store(&meshes, members, compress))
        .collect();

    let mut head = Buf::new();
    head.u32(meshes.len() as u32);
    head.u32(total_vertices);
    head.u32(total_triangles);
    coordinate_info::write(&mut head, info);
    // v19 shared appearance source-index pool: empty, as no native mesh
    // carries canonical appearance provenance (see the crate docs).
    head.u32(0);
    head.u32(stored.len() as u32);
    let head_length = head.len() + stored.len() * DIRECTORY_ENTRY_BYTES;

    let body: usize = stored.iter().map(|chunk| chunk.bytes.len()).sum();
    let mut out = Buf::with_capacity(4 + head_length + body);
    out.u32(head_length as u32);
    out.bytes(&head.into_vec());
    let mut offset = 4 + head_length;
    for chunk in &stored {
        out.f32s(&chunk.aabb);
        out.u32(offset as u32);
        out.u32(chunk.bytes.len() as u32);
        out.u32(chunk.uncompressed_length);
        out.u32(chunk.mesh_count);
        out.u32(chunk.flags);
        offset += chunk.bytes.len();
    }
    for chunk in &stored {
        out.bytes(&chunk.bytes);
    }
    GeometrySection {
        bytes: out.into_vec(),
        mesh_count: meshes.len() as u32,
        total_vertices,
        total_triangles,
        chunk_count: stored.len() as u32,
        skipped_meshes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use record::tests::sample;

    #[test]
    fn the_first_chunk_starts_right_after_the_head() {
        let section = build(vec![sample(1, [0.0; 3]), sample(2, [99.0, 0.0, 0.0])], &CoordinateInfo::default(), true);
        let bytes = &section.bytes;
        let word = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
        let head_length = word(0);
        let directory = 4 + head_length - 2 * DIRECTORY_ENTRY_BYTES;
        assert_eq!(word(directory - 4), 2, "chunkCount");
        let first = directory + 24;
        assert_eq!(word(first), 4 + head_length, "chunk 0 anchors at the head end");
        let second = first + DIRECTORY_ENTRY_BYTES;
        assert_eq!(word(second), word(first) + word(first + 4), "contiguous");
        assert_eq!(word(second) + word(second + 4), bytes.len());
    }

    #[test]
    fn a_mesh_whose_normals_do_not_pair_is_dropped_from_counts_and_chunks() {
        let mut broken = sample(2, [0.0; 3]);
        broken.normals.pop();
        let section = build(vec![sample(1, [0.0; 3]), broken], &CoordinateInfo::default(), false);
        assert_eq!((section.mesh_count, section.skipped_meshes), (1, 1));
        assert_eq!((section.total_vertices, section.total_triangles), (3, 1));
    }
}
