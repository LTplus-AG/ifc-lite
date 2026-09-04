// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Splits a cached combined-geometry Parquet blob back into the per-batch
//! chunks a live parse would have streamed, so a cache hit on
//! `POST /api/v1/parse/parquet-stream` can replay the same `Start` / `Batch`+
//! `Progress` / `Complete` event shape as a miss (issue #3895) instead of one
//! oversized `Batch`.
//!
//! `StreamingParquetCacheWriter` (`parquet.rs`) appends one Parquet row group
//! per live stream batch to each of the three section tables (mesh / vertex /
//! index), so the original batch boundaries are still there in the cached
//! blob's row-group layout. This module reads them back out: for each row
//! group, the vertex/index tables are already batch-local (no offset is
//! baked into their columns), and the mesh table's `vertex_start` /
//! `index_start` columns are re-based from whole-model globals back to
//! batch-local zero, so the re-encoded per-batch blob matches what the live
//! per-batch serializer (`serialize_to_parquet`, base offsets 0/0) would have
//! produced for that same batch.

use super::parquet::{frame_sections, write_parquet_buffer};
use arrow::array::UInt32Array;
use arrow::record_batch::RecordBatch;
use bytes::Bytes;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use std::sync::Arc;

/// One reconstructed batch, ready to base64-encode into a `Batch` SSE event.
pub struct ReplayBatch {
    /// A complete `[mesh_len][mesh][vertex_len][vertex][index_len][index]`
    /// section blob for just this batch, in the same framing a live
    /// per-batch `Batch` event carries.
    pub data: Bytes,
    pub mesh_count: usize,
}

/// Split a cached geometry blob (the inner section framing
/// `cached_geometry_slice` returns) back into per-original-batch chunks.
///
/// Returns `None` when the blob doesn't decode as three same-row-group-count
/// Parquet sections — a short/corrupt/foreign blob — so the caller can fall
/// back to replaying the whole geometry as a single batch rather than error
/// out.
pub fn split_into_batches(geometry: &[u8]) -> Option<Vec<ReplayBatch>> {
    let (mesh_bytes, vertex_bytes, index_bytes) = split_geometry_sections(geometry)?;

    let mesh_builder = ParquetRecordBatchReaderBuilder::try_new(mesh_bytes.clone()).ok()?;
    let vertex_builder = ParquetRecordBatchReaderBuilder::try_new(vertex_bytes.clone()).ok()?;
    let index_builder = ParquetRecordBatchReaderBuilder::try_new(index_bytes.clone()).ok()?;

    let row_groups = mesh_builder.metadata().num_row_groups();
    if row_groups == 0
        || vertex_builder.metadata().num_row_groups() != row_groups
        || index_builder.metadata().num_row_groups() != row_groups
    {
        // Not the shape `StreamingParquetCacheWriter` produces (or a single
        // legacy/non-streamed row group) - let the caller fall back.
        return None;
    }

    let mut batches = Vec::with_capacity(row_groups);
    for i in 0..row_groups {
        let mesh_rb = read_row_group(&mesh_bytes, i)?;
        let vertex_rb = read_row_group(&vertex_bytes, i)?;
        let index_rb = read_row_group(&index_bytes, i)?;
        if mesh_rb.num_rows() == 0 {
            // `StreamingParquetCacheWriter::append` skips empty batches, so
            // this shouldn't happen; treat it as unrecoverable rather than
            // guess at a base offset with no rows to read one from.
            return None;
        }

        let localized_mesh = localize_mesh_batch(&mesh_rb)?;
        let mesh_buf = write_parquet_buffer(&localized_mesh).ok()?;
        let vertex_buf = write_parquet_buffer(&vertex_rb).ok()?;
        let index_buf = write_parquet_buffer(&index_rb).ok()?;
        let framed = frame_sections(&mesh_buf, &vertex_buf, &index_buf).ok()?;

        batches.push(ReplayBatch {
            data: framed,
            mesh_count: localized_mesh.num_rows(),
        });
    }
    Some(batches)
}

/// Split the triple-framed `[mesh_len][mesh][vertex_len][vertex][index_len]
/// [index]` geometry blob into its three sections. `None` on any short or
/// mismatched-length framing, or trailing bytes past the third section.
fn split_geometry_sections(geometry: &[u8]) -> Option<(Bytes, Bytes, Bytes)> {
    let mut off = 0usize;
    let mesh = take_length_prefixed(geometry, &mut off)?;
    let vertex = take_length_prefixed(geometry, &mut off)?;
    let index = take_length_prefixed(geometry, &mut off)?;
    if off != geometry.len() {
        return None;
    }
    Some((mesh, vertex, index))
}

fn take_length_prefixed(blob: &[u8], off: &mut usize) -> Option<Bytes> {
    let header = blob.get(*off..off.checked_add(4)?)?;
    let len = u32::from_le_bytes(header.try_into().ok()?) as usize;
    let start = *off + 4;
    let end = start.checked_add(len)?;
    let section = blob.get(start..end)?;
    *off = end;
    Some(Bytes::copy_from_slice(section))
}

/// Read row group `index` out of a Parquet buffer as one concatenated
/// `RecordBatch` (the reader's own `batch_size` can split a row group across
/// several yielded batches).
fn read_row_group(bytes: &Bytes, index: usize) -> Option<RecordBatch> {
    let builder = ParquetRecordBatchReaderBuilder::try_new(bytes.clone()).ok()?;
    let schema = builder.schema().clone();
    let reader = builder.with_row_groups(vec![index]).build().ok()?;
    let parts: Vec<RecordBatch> = reader.collect::<Result<_, _>>().ok()?;
    if parts.is_empty() {
        return RecordBatch::try_new(schema, vec![]).ok();
    }
    arrow::compute::concat_batches(&schema, &parts).ok()
}

/// Re-base a mesh-table row group's `vertex_start`/`index_start` columns
/// (`mesh_schema()` columns 2 and 4) from whole-model globals back to
/// batch-local zero, by subtracting the group's own first-row values - the
/// exact base offset `StreamingParquetCacheWriter::append` fed into
/// `build_mesh_tables` for that batch. Every other column is untouched.
fn localize_mesh_batch(rb: &RecordBatch) -> Option<RecordBatch> {
    let vertex_start = rb.column(2).as_any().downcast_ref::<UInt32Array>()?;
    let index_start = rb.column(4).as_any().downcast_ref::<UInt32Array>()?;
    let base_v = vertex_start.value(0);
    let base_i = index_start.value(0);

    let localized_v: UInt32Array = vertex_start.iter().map(|v| v.map(|v| v - base_v)).collect();
    let localized_i: UInt32Array = index_start.iter().map(|v| v.map(|v| v - base_i)).collect();

    let mut columns = rb.columns().to_vec();
    columns[2] = Arc::new(localized_v);
    columns[4] = Arc::new(localized_i);
    RecordBatch::try_new(rb.schema(), columns).ok()
}

#[cfg(test)]
#[path = "parquet_replay_batches_tests.rs"]
mod parquet_replay_batches_tests;
