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
//! index) — an invariant that writer pins by disabling the row-count-driven
//! row-group split. This module reads those boundaries back out: the
//! vertex/index tables are already batch-local (no offset is baked into their
//! columns), and the mesh table's `vertex_start` / `index_start` columns are
//! re-based from whole-model globals back to batch-local zero, so the
//! re-encoded per-batch blob matches what the live per-batch serializer
//! (`serialize_to_parquet`, base offsets 0/0) would have produced for that
//! same batch.

use super::parquet::{frame_sections, write_parquet_buffer};
use arrow::array::{Array, ArrayRef, UInt32Array};
use arrow::record_batch::RecordBatch;
use bytes::Bytes;
use parquet::arrow::arrow_reader::{
    ArrowReaderMetadata, ArrowReaderOptions, ParquetRecordBatchReaderBuilder,
};
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
/// Returns `None` when the blob carries no recoverable batch boundary — a
/// short/corrupt/foreign blob, or one written as a single row group (a
/// one-shot `serialize_to_parquet` cache entry, or a stream that emitted one
/// batch). In the single-row-group case re-encoding would only reproduce the
/// bytes the caller already holds, so falling back is both cheaper and
/// byte-equivalent.
pub fn split_into_batches(geometry: &[u8]) -> Option<Vec<ReplayBatch>> {
    let (mesh_bytes, vertex_bytes, index_bytes) = split_geometry_sections(geometry)?;
    let mesh = Section::open(mesh_bytes)?;
    let vertex = Section::open(vertex_bytes)?;
    let index = Section::open(index_bytes)?;

    let row_groups = mesh.row_groups();
    if row_groups <= 1 || vertex.row_groups() != row_groups || index.row_groups() != row_groups {
        return None;
    }

    let mut batches = Vec::with_capacity(row_groups);
    for i in 0..row_groups {
        let mesh_rb = mesh.read_row_group(i)?;
        let vertex_rb = vertex.read_row_group(i)?;
        let index_rb = index.read_row_group(i)?;

        // Equal row-group counts are only a proxy for alignment. Prove it
        // instead: this mesh row group's own `vertex_count` / `index_count`
        // columns must account for exactly the rows in the vertex / index
        // row groups beside it. (The index table is one row per TRIANGLE
        // while `index_count` counts indices, hence the /3.)
        let vertex_rows = column_sum(&mesh_rb, "vertex_count", 1)?;
        let index_rows = column_sum(&mesh_rb, "index_count", 3)?;
        if vertex_rows != vertex_rb.num_rows() as u64 || index_rows != index_rb.num_rows() as u64 {
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

/// One Parquet section of the cached blob, with its footer parsed ONCE.
/// Re-opening a `ParquetRecordBatchReaderBuilder` per row group re-parses
/// the whole footer each time, which is quadratic in the row-group count —
/// hundreds of milliseconds on a model that streamed a few hundred batches.
struct Section {
    bytes: Bytes,
    metadata: ArrowReaderMetadata,
}

impl Section {
    fn open(bytes: Bytes) -> Option<Self> {
        let metadata = ArrowReaderMetadata::load(&bytes, ArrowReaderOptions::new()).ok()?;
        Some(Self { bytes, metadata })
    }

    fn row_groups(&self) -> usize {
        self.metadata.metadata().num_row_groups()
    }

    /// Read row group `index` as one `RecordBatch`. The reader's batch size is
    /// pinned to the group's own row count so it yields a single batch instead
    /// of fragments that would then have to be copied back together.
    fn read_row_group(&self, index: usize) -> Option<RecordBatch> {
        let rows = self.metadata.metadata().row_group(index).num_rows();
        let rows = usize::try_from(rows).ok()?;
        let schema = self.metadata.schema().clone();
        let reader =
            ParquetRecordBatchReaderBuilder::new_with_metadata(self.bytes.clone(), self.metadata.clone())
                .with_row_groups(vec![index])
                .with_batch_size(rows.max(1))
                .build()
                .ok()?;
        let parts: Vec<RecordBatch> = reader.collect::<Result<_, _>>().ok()?;
        match parts.len() {
            1 => parts.into_iter().next(),
            _ => arrow::compute::concat_batches(&schema, &parts).ok(),
        }
    }
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

/// Sum a non-nullable `UInt32` mesh column, dividing each value by
/// `per_row` first. The division is PER ROW, not on the total, because
/// `build_mesh_tables` counts index-table rows the same way — one row per
/// `indices.len() / 3` per mesh, so a mesh whose index count is not a
/// multiple of 3 rounds down on its own, not against its neighbours.
fn column_sum(rb: &RecordBatch, name: &str, per_row: u32) -> Option<u64> {
    let idx = rb.schema().index_of(name).ok()?;
    let col = rb.column(idx).as_any().downcast_ref::<UInt32Array>()?;
    Some(col.values().iter().map(|v| u64::from(v / per_row)).sum())
}

/// Re-base a mesh-table row group's `vertex_start` / `index_start` columns
/// from whole-model globals back to batch-local zero, by subtracting the
/// group's own first-row values — the exact base offset
/// `StreamingParquetCacheWriter::append` fed into `build_mesh_tables` for that
/// batch. Every other column is untouched. Columns are resolved BY NAME, so a
/// schema reorder can never silently re-base the wrong one.
fn localize_mesh_batch(rb: &RecordBatch) -> Option<RecordBatch> {
    if rb.num_rows() == 0 {
        // `StreamingParquetCacheWriter::append` skips empty batches, so this
        // shouldn't happen; there is no first row to read a base offset from.
        return None;
    }
    let vertex_idx = rb.schema().index_of("vertex_start").ok()?;
    let index_idx = rb.schema().index_of("index_start").ok()?;
    let localized_v = rebase_to_zero(rb.column(vertex_idx))?;
    let localized_i = rebase_to_zero(rb.column(index_idx))?;

    let mut columns = rb.columns().to_vec();
    columns[vertex_idx] = localized_v;
    columns[index_idx] = localized_i;
    RecordBatch::try_new(rb.schema(), columns).ok()
}

/// Subtract a `UInt32` column's first value from every value. `checked_sub`
/// rather than `-`: on a foreign blob whose offsets are not non-decreasing
/// this would panic in debug and, with the release profile's
/// `overflow-checks = false`, WRAP to a ~4-billion offset that decodes as
/// valid geometry. `None` instead sends the caller to its fallback.
fn rebase_to_zero(column: &ArrayRef) -> Option<ArrayRef> {
    let values = column.as_any().downcast_ref::<UInt32Array>()?;
    let base = values.value(0);
    let rebased: Option<Vec<u32>> = values.values().iter().map(|v| v.checked_sub(base)).collect();
    Some(Arc::new(UInt32Array::from(rebased?)) as ArrayRef)
}

#[cfg(test)]
#[path = "parquet_replay_batches_tests.rs"]
mod parquet_replay_batches_tests;
