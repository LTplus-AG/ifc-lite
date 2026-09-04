// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `parquet_replay_batches.rs`, split out (like
//! `parquet_tests.rs`) to keep the production module under the module-size
//! ratchet. `use super::*` keeps access to the parent's private helpers.

use super::*;
use crate::services::parquet::{serialize_to_parquet, StreamingParquetCacheWriter};
use crate::types::MeshData;

fn mesh(id: u32, verts: usize, tris: usize) -> MeshData {
    let mut positions = Vec::new();
    let mut normals = Vec::new();
    for i in 0..verts {
        positions.extend_from_slice(&[i as f32, 0.0, 0.0]);
        normals.extend_from_slice(&[0.0, 1.0, 0.0]);
    }
    let mut indices = Vec::new();
    for i in 0..tris {
        let base = (i % verts.max(1)) as u32;
        indices.extend_from_slice(&[base, base, base]);
    }
    MeshData::new(id, "IfcWall".to_string(), positions, normals, indices, [
        1.0, 0.0, 0.0, 1.0,
    ])
}

/// Two `append()` calls (two live stream batches) must split back into two
/// `ReplayBatch`es whose section blobs are byte-identical to what the live
/// per-batch serializer (`serialize_to_parquet`, batch-local offsets) would
/// have produced for that same slice of meshes - the offset re-basing must
/// be exact, not just decode-equivalent.
#[test]
fn splits_two_appended_batches_with_byte_identical_localized_output() {
    let batch_a = vec![mesh(1, 3, 1), mesh(2, 4, 2)];
    let batch_b = vec![mesh(3, 2, 1), mesh(4, 5, 3), mesh(5, 1, 0)];

    let mut writer = StreamingParquetCacheWriter::new().unwrap();
    writer.append(&batch_a).unwrap();
    writer.append(&batch_b).unwrap();
    let geometry = writer.finish().unwrap();

    let batches = split_into_batches(&geometry).expect("two row-group-aligned batches");
    assert_eq!(batches.len(), 2);
    assert_eq!(batches[0].mesh_count, 2);
    assert_eq!(batches[1].mesh_count, 3);

    let expected_a = serialize_to_parquet(&batch_a).unwrap();
    let expected_b = serialize_to_parquet(&batch_b).unwrap();
    assert_eq!(
        batches[0].data.as_ref(),
        expected_a.as_ref(),
        "batch 1 must match the live per-batch encoding byte for byte"
    );
    assert_eq!(
        batches[1].data.as_ref(),
        expected_b.as_ref(),
        "batch 2 must match the live per-batch encoding byte for byte"
    );

}

/// One `append()` call (a single live stream batch, e.g. a small file) has no
/// batch boundary to recover: the blob's single row group IS the whole model,
/// and re-encoding it would only reproduce the bytes the caller already holds.
/// `split_into_batches` reports that as `None` so the caller replays the
/// cached bytes directly instead of paying a decode + re-encode for nothing.
#[test]
fn a_single_appended_batch_has_no_boundary_to_recover() {
    let meshes = vec![mesh(1, 3, 1)];
    let mut writer = StreamingParquetCacheWriter::new().unwrap();
    writer.append(&meshes).unwrap();
    let geometry = writer.finish().unwrap();

    assert!(split_into_batches(&geometry).is_none());
}

/// The whole reconstruction rests on `StreamingParquetCacheWriter::append`
/// emitting exactly ONE row group per table per batch. arrow-rs otherwise
/// splits a single `write` once a table passes 1,048,576 rows, which the
/// VERTEX table (one row per vertex) crosses on ordinary large models long
/// before the mesh table (one row per mesh) does — the row-group counts then
/// disagree and the replay degrades silently to one oversized batch. This
/// pins the writer property that disables that split, with a batch big enough
/// to have triggered it.
#[test]
fn an_append_over_the_default_row_group_limit_still_writes_one_row_group() {
    // 1200 meshes x 1000 vertices = 1.2M vertex rows, past the 1,048,576
    // default, while the mesh table holds only 1200 rows.
    let big: Vec<MeshData> = (0..1200).map(|id| mesh(id, 1000, 1)).collect();
    let mut writer = StreamingParquetCacheWriter::new().unwrap();
    writer.append(&big).unwrap();
    writer.append(&[mesh(9999, 3, 1)]).unwrap();
    let geometry = writer.finish().unwrap();

    let batches = split_into_batches(&geometry)
        .expect("both appends must stay row-group-aligned across all three tables");
    assert_eq!(batches.len(), 2);
    assert_eq!(batches[0].mesh_count, 1200);
    assert_eq!(batches[1].mesh_count, 1);
}

/// A blob that isn't the triple-framed Parquet shape at all (garbage bytes,
/// or too short even for one length header) must return `None` so the
/// caller falls back to a single whole-geometry batch, never panic.
#[test]
fn returns_none_for_bytes_that_are_not_the_expected_framing() {
    assert!(split_into_batches(&[0xDE, 0xAD, 0xBE, 0xEF, 0x42]).is_none());
    assert!(split_into_batches(&[]).is_none());
    assert!(split_into_batches(&[1, 2, 3]).is_none());
}

/// A declared section length that runs past the buffer must not panic
/// slicing - same corrupt-blob contract as `cached_geometry_slice`.
#[test]
fn returns_none_for_a_declared_length_past_the_buffer() {
    let mut blob = 1_000_000u32.to_le_bytes().to_vec();
    blob.extend_from_slice(&[0xAA; 8]);
    assert!(split_into_batches(&blob).is_none());
}
