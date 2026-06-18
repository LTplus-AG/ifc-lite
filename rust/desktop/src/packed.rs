// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Packed geometry shard binary encoder.
//!
//! This produces the exact little-endian layout decoded by
//! `packages/geometry/src/packed-geometry-decoder.ts`
//! (`decodePackedGeometryCacheShard`). Keeping a single batch in one contiguous
//! buffer lets the TypeScript side build cheap `TypedArray` views over it (one
//! copy across the Tauri IPC boundary instead of per-mesh JSON), which is the
//! whole point of the packed path.
//!
//! Layout (all little-endian, `u32` words unless noted):
//!
//! ```text
//! Header (8 words): magic, version, meshCount, positionsLen, normalsLen,
//!                   indicesLen, processed, total
//! Mesh table (meshCount × 11 words): expressId, posOff, posLen, nrmOff, nrmLen,
//!                   idxOff, idxLen, color.r, color.g, color.b, color.a (colours
//!                   are f32 bit-patterns)
//! Data: positions (f32 × positionsLen), normals (f32 × normalsLen),
//!       indices (u32 × indicesLen)
//! ```
//!
//! `posOff`/`posLen` (and the normal/index pair) are **element** offsets/lengths
//! into the pooled arrays — the decoder reads `positions.subarray(posOff, posOff
//! + posLen)`. Indices stay **local** to each mesh's own vertex range (0-based);
//! they are not rebased into the pool, because each mesh receives its own
//! positions sub-view.

use crate::convert::WireMesh;

/// `"IFCB"` little-endian — the shard magic the TS decoder validates.
pub const SHARD_MAGIC: u32 = 0x4946_4342;
/// Shard format version. Bump in lockstep with the TS decoder's `version` guard.
pub const SHARD_VERSION: u32 = 1;

const HEADER_WORDS: usize = 8;
const MESH_RECORD_WORDS: usize = 11;

#[inline]
fn push_u32(buf: &mut Vec<u8>, v: u32) {
    buf.extend_from_slice(&v.to_le_bytes());
}

#[inline]
fn push_f32(buf: &mut Vec<u8>, v: f32) {
    buf.extend_from_slice(&v.to_le_bytes());
}

/// Encode one batch of [`WireMesh`] into a packed shard buffer.
///
/// `processed`/`total` populate the shard's progress header (the decoder surfaces
/// them as `GeometryBatch.progress`).
pub fn encode_shard(meshes: &[WireMesh], processed: usize, total: usize) -> Vec<u8> {
    let mesh_count = meshes.len();
    let positions_len: usize = meshes.iter().map(|m| m.positions.len()).sum();
    let normals_len: usize = meshes.iter().map(|m| m.normals.len()).sum();
    let indices_len: usize = meshes.iter().map(|m| m.indices.len()).sum();

    let table_bytes = (HEADER_WORDS + mesh_count * MESH_RECORD_WORDS) * 4;
    let data_bytes = (positions_len + normals_len + indices_len) * 4;
    let mut buf = Vec::with_capacity(table_bytes + data_bytes);

    // ── Header ──
    push_u32(&mut buf, SHARD_MAGIC);
    push_u32(&mut buf, SHARD_VERSION);
    push_u32(&mut buf, mesh_count as u32);
    push_u32(&mut buf, positions_len as u32);
    push_u32(&mut buf, normals_len as u32);
    push_u32(&mut buf, indices_len as u32);
    push_u32(&mut buf, processed as u32);
    push_u32(&mut buf, total as u32);

    // ── Mesh table (running element offsets into the pooled data arrays) ──
    let mut pos_off = 0u32;
    let mut nrm_off = 0u32;
    let mut idx_off = 0u32;
    for mesh in meshes {
        push_u32(&mut buf, mesh.express_id);
        push_u32(&mut buf, pos_off);
        push_u32(&mut buf, mesh.positions.len() as u32);
        push_u32(&mut buf, nrm_off);
        push_u32(&mut buf, mesh.normals.len() as u32);
        push_u32(&mut buf, idx_off);
        push_u32(&mut buf, mesh.indices.len() as u32);
        for channel in mesh.color {
            push_f32(&mut buf, channel);
        }
        pos_off += mesh.positions.len() as u32;
        nrm_off += mesh.normals.len() as u32;
        idx_off += mesh.indices.len() as u32;
    }

    // ── Data: positions, then normals, then indices (matches decoder offsets) ──
    for mesh in meshes {
        for &v in &mesh.positions {
            push_f32(&mut buf, v);
        }
    }
    for mesh in meshes {
        for &v in &mesh.normals {
            push_f32(&mut buf, v);
        }
    }
    for mesh in meshes {
        for &v in &mesh.indices {
            push_u32(&mut buf, v);
        }
    }

    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire(express_id: u32, positions: Vec<f32>, normals: Vec<f32>, indices: Vec<u32>, color: [f32; 4]) -> WireMesh {
        WireMesh { express_id, ifc_type: "IfcWall".to_string(), positions, normals, indices, color }
    }

    /// A faithful port of `decodePackedGeometryCacheShard` (the TS decoder), used
    /// to prove the encoder round-trips through the exact wire contract. If this
    /// drifts from the TS file, the format guard below is the canary.
    fn decode(buf: &[u8]) -> (Vec<WireMesh>, u32, u32) {
        let rd_u32 = |off: usize| u32::from_le_bytes(buf[off..off + 4].try_into().unwrap());
        let rd_f32 = |off: usize| f32::from_le_bytes(buf[off..off + 4].try_into().unwrap());

        assert_eq!(rd_u32(0), SHARD_MAGIC, "bad magic");
        assert_eq!(rd_u32(4), SHARD_VERSION, "bad version");
        let mesh_count = rd_u32(8) as usize;
        let positions_len = rd_u32(12) as usize;
        let normals_len = rd_u32(16) as usize;
        let _indices_len = rd_u32(20) as usize;
        let processed = rd_u32(24);
        let total = rd_u32(28);

        let table_words = mesh_count * MESH_RECORD_WORDS;
        let data_byte_offset = (HEADER_WORDS + table_words) * 4;
        let positions_offset = data_byte_offset;
        let normals_offset = positions_offset + positions_len * 4;
        let indices_offset = normals_offset + normals_len * 4;

        let mut meshes = Vec::with_capacity(mesh_count);
        for m in 0..mesh_count {
            let base = (HEADER_WORDS + m * MESH_RECORD_WORDS) * 4;
            let express_id = rd_u32(base);
            let pos_off = rd_u32(base + 4) as usize;
            let pos_len = rd_u32(base + 8) as usize;
            let nrm_off = rd_u32(base + 12) as usize;
            let nrm_len = rd_u32(base + 16) as usize;
            let idx_off = rd_u32(base + 20) as usize;
            let idx_len = rd_u32(base + 24) as usize;
            let color = [rd_f32(base + 28), rd_f32(base + 32), rd_f32(base + 36), rd_f32(base + 40)];

            let positions = (0..pos_len)
                .map(|i| rd_f32(positions_offset + (pos_off + i) * 4))
                .collect();
            let normals = (0..nrm_len)
                .map(|i| rd_f32(normals_offset + (nrm_off + i) * 4))
                .collect();
            let indices = (0..idx_len)
                .map(|i| rd_u32(indices_offset + (idx_off + i) * 4))
                .collect();

            meshes.push(wire(express_id, positions, normals, indices, color));
        }
        (meshes, processed, total)
    }

    #[test]
    fn header_fields_are_written_in_order() {
        let m = wire(42, vec![1.0, 2.0, 3.0], vec![0.0, 0.0, 1.0], vec![0], [0.1, 0.2, 0.3, 1.0]);
        let buf = encode_shard(std::slice::from_ref(&m), 17, 99);
        let rd = |off: usize| u32::from_le_bytes(buf[off..off + 4].try_into().unwrap());
        assert_eq!(rd(0), 0x4946_4342); // magic "IFCB"
        assert_eq!(rd(4), 1); // version
        assert_eq!(rd(8), 1); // meshCount
        assert_eq!(rd(12), 3); // positionsLen
        assert_eq!(rd(16), 3); // normalsLen
        assert_eq!(rd(20), 1); // indicesLen
        assert_eq!(rd(24), 17); // processed
        assert_eq!(rd(28), 99); // total
    }

    #[test]
    fn round_trips_a_multi_mesh_batch() {
        let meshes = vec![
            wire(1, vec![0.0, 1.0, 2.0, 3.0, 4.0, 5.0], vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0], vec![0, 1], [1.0, 0.0, 0.0, 1.0]),
            wire(2, vec![9.0, 8.0, 7.0], vec![0.0, 0.0, 1.0], vec![0, 0, 0], [0.25, 0.5, 0.75, 0.5]),
            // A degenerate empty mesh must not corrupt later offsets.
            wire(3, vec![], vec![], vec![], [0.0, 0.0, 0.0, 1.0]),
            wire(4, vec![100.0, 200.0, 300.0], vec![0.0, 1.0, 0.0], vec![2, 1, 0], [0.9, 0.9, 0.9, 1.0]),
        ];
        let buf = encode_shard(&meshes, 4, 4);
        let (decoded, processed, total) = decode(&buf);
        assert_eq!(processed, 4);
        assert_eq!(total, 4);
        assert_eq!(decoded, meshes);
    }

    #[test]
    fn empty_batch_is_just_a_header() {
        let buf = encode_shard(&[], 0, 0);
        assert_eq!(buf.len(), HEADER_WORDS * 4);
        let (decoded, _, _) = decode(&buf);
        assert!(decoded.is_empty());
    }

    #[test]
    fn buffer_length_matches_declared_layout() {
        let meshes = vec![
            wire(1, vec![0.0, 1.0, 2.0], vec![0.0, 0.0, 1.0], vec![0, 1, 2], [1.0, 1.0, 1.0, 1.0]),
            wire(2, vec![3.0, 4.0, 5.0, 6.0, 7.0, 8.0], vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0], vec![0, 1], [1.0, 0.0, 0.0, 1.0]),
        ];
        let positions_len = 3 + 6;
        let normals_len = 3 + 6;
        let indices_len = 3 + 2;
        let expected = (HEADER_WORDS + meshes.len() * MESH_RECORD_WORDS) * 4
            + (positions_len + normals_len + indices_len) * 4;
        assert_eq!(encode_shard(&meshes, 2, 2).len(), expected);
    }
}
