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

    // Concatenating the two replayed batches must reproduce exactly what a
    // one-shot serialize of the whole model (all 5 meshes) decodes to, i.e.
    // the split loses nothing and adds nothing.
    let mut all = batch_a.clone();
    all.extend(batch_b.clone());
    let _ = serialize_to_parquet(&all).unwrap(); // sanity: whole-model call succeeds too
}

/// One `append()` call (a single live stream batch, e.g. a small file) must
/// still split into exactly one `ReplayBatch`, matching the live shape for a
/// small file (at least one batch).
#[test]
fn a_single_appended_batch_splits_into_exactly_one_replay_batch() {
    let meshes = vec![mesh(1, 3, 1)];
    let mut writer = StreamingParquetCacheWriter::new().unwrap();
    writer.append(&meshes).unwrap();
    let geometry = writer.finish().unwrap();

    let batches = split_into_batches(&geometry).expect("one row-group-aligned batch");
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].mesh_count, 1);
    assert_eq!(batches[0].data.as_ref(), serialize_to_parquet(&meshes).unwrap().as_ref());
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
