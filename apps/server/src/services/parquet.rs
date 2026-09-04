// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Parquet serialization for efficient mesh data transfer.
//!
//! Uses columnar format (ara3d BOS-compatible) for dramatically better compression
//! compared to JSON serialization. Typical compression ratios:
//! - JSON: ~30KB per mesh with ~500 vertices
//! - Parquet: ~2KB per mesh (15x smaller)

use crate::services::parquet_layout::ParquetLayout;
use crate::services::parquet_mesh_tables::{build_mesh_tables, ShapePlan};
use crate::services::parquet_schema::{index_schema, mesh_schema, vertex_schema};
use crate::types::MeshData;
use arrow::datatypes::{DataType, Schema};
use arrow::record_batch::RecordBatch;
use bytes::Bytes;
use parquet::arrow::ArrowWriter;
use parquet::basic::Compression;
use parquet::file::properties::WriterProperties;
use parquet::schema::types::ColumnPath;
use std::io::Cursor;
use std::sync::Arc;
use thiserror::Error;

/// Errors during Parquet serialization.
#[derive(Debug, Error)]
pub enum ParquetError {
    #[error("Format overflow: {0}")]
    Overflow(String),
    #[error("Arrow error: {0}")]
    Arrow(#[from] arrow::error::ArrowError),
    #[error("Parquet error: {0}")]
    Parquet(#[from] parquet::errors::ParquetError),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

/// Serialize mesh data to Parquet format.
///
/// Creates a single Parquet file with multiple row groups:
/// 1. Mesh metadata (ExpressId, IfcType, offsets, colors)
/// 2. Vertex data (X, Y, Z, NormalX, NormalY, NormalZ) - columnar
/// 3. Index data (I0, I1, I2) - columnar triangles
///
/// This format is compatible with ara3d BOS and provides excellent compression
/// for geometry data through columnar storage and dictionary encoding.
pub fn serialize_to_parquet(meshes: &[MeshData]) -> Result<Bytes, ParquetError> {
    serialize_with_plan(meshes, &ShapePlan::Identity, ParquetLayout::Flat)
}

/// Serialize one batch under the layout the client asked for, sharing nothing.
///
/// The streaming route's per-batch blobs: `SharedShapes` here means only that
/// the mesh table carries identity `rot0..rot8`, since sharing across a batch
/// boundary is not something a per-batch writer can see.
pub fn serialize_batch_with_layout(
    meshes: &[MeshData],
    layout: ParquetLayout,
) -> Result<Bytes, ParquetError> {
    serialize_with_plan(meshes, &ShapePlan::Identity, layout)
}

/// Serialize mesh data with rotation-aware shape sharing (issue #3888). Same
/// tables and framing as [`serialize_to_parquet`]; see `mesh_schema()` in
/// `services::parquet_schema` for what the layout means on the wire.
///
/// Separate from [`serialize_to_parquet`] rather than replacing it: the
/// streaming route serializes ONE BATCH at a time, where sharing could only
/// ever be batch-local, so it keeps calling the identity-plan serializer.
pub fn serialize_to_parquet_shared_shapes(meshes: &[MeshData]) -> Result<Bytes, ParquetError> {
    serialize_with_plan(
        meshes,
        &ShapePlan::shared_shapes(meshes),
        ParquetLayout::SharedShapes,
    )
}

fn serialize_with_plan(
    meshes: &[MeshData],
    plan: &ShapePlan,
    layout: ParquetLayout,
) -> Result<Bytes, ParquetError> {
    let (mesh_batch, vertex_batch, index_batch) = build_mesh_tables(meshes, plan, layout, 0, 0)?;

    // Write to a custom binary format with multiple Parquet sections
    // Format: [mesh_parquet_len:u32][mesh_parquet][vertex_parquet_len:u32][vertex_parquet][index_parquet_len:u32][index_parquet]
    let mesh_parquet = write_parquet_buffer(&mesh_batch)?;
    let vertex_parquet = write_parquet_buffer(&vertex_batch)?;
    let index_parquet = write_parquet_buffer(&index_batch)?;
    frame_sections(&mesh_parquet, &vertex_parquet, &index_parquet)
}

/// Fail loud instead of silently truncating a wire-format `u32` length
/// prefix when a section exceeds 4 GiB.
///
/// `pub(crate)` so `parquet_optimized`'s length-prefixed sections (the same
/// `[len:u32][bytes]` wire shape) can share this guard instead of growing an
/// unguarded sibling copy of the cast.
pub(crate) fn check_u32_len(name: &str, len: usize) -> Result<(), ParquetError> {
    if u32::try_from(len).is_err() {
        return Err(ParquetError::Overflow(format!(
            "{name} section is {len} bytes, over the u32 wire-format limit"
        )));
    }
    Ok(())
}

/// Assemble the three Parquet buffers into the length-prefixed section layout
/// shared by the whole-model serializer and the incremental cache writer.
/// Section lengths are u32 on the wire; fail loud instead of truncating a
/// section over 4 GiB into a silently corrupt blob.
pub(super) fn frame_sections(mesh: &[u8], vertex: &[u8], index: &[u8]) -> Result<Bytes, ParquetError> {
    check_u32_len("mesh", mesh.len())?;
    check_u32_len("vertex", vertex.len())?;
    check_u32_len("index", index.len())?;
    let mut output = Vec::with_capacity(12 + mesh.len() + vertex.len() + index.len());
    output.extend_from_slice(&(mesh.len() as u32).to_le_bytes());
    output.extend_from_slice(mesh);
    output.extend_from_slice(&(vertex.len() as u32).to_le_bytes());
    output.extend_from_slice(vertex);
    output.extend_from_slice(&(index.len() as u32).to_le_bytes());
    output.extend_from_slice(index);
    Ok(Bytes::from(output))
}

/// Assemble the three Parquet buffers directly into the OUTER combined
/// framing the parse endpoints wrap the geometry blob in:
/// `[geo_len:u32][geo_bytes][data_model_len=0:u32]`, where `geo_bytes` is
/// exactly `frame_sections`'s `[mesh_len][mesh][vertex_len][vertex][index_len][index]`
/// layout. Endpoints that don't attach a data model inline (the streamed
/// cache fill) previously called `frame_sections` for the inner blob and then
/// copied that whole blob a second time into an outer `Vec` to add the
/// `[geo_len]...[dm_len=0]` wrapper. Writing both frames into one
/// pre-sized allocation skips that second copy; the resulting bytes are
/// identical to the old two-copy path.
fn frame_combined_sections(mesh: &[u8], vertex: &[u8], index: &[u8]) -> Result<Bytes, ParquetError> {
    check_u32_len("mesh", mesh.len())?;
    check_u32_len("vertex", vertex.len())?;
    check_u32_len("index", index.len())?;
    let inner_len = 12 + mesh.len() + vertex.len() + index.len();
    check_u32_len("geometry", inner_len)?;
    let mut output = Vec::with_capacity(4 + inner_len + 4);
    output.extend_from_slice(&(inner_len as u32).to_le_bytes());
    output.extend_from_slice(&(mesh.len() as u32).to_le_bytes());
    output.extend_from_slice(mesh);
    output.extend_from_slice(&(vertex.len() as u32).to_le_bytes());
    output.extend_from_slice(vertex);
    output.extend_from_slice(&(index.len() as u32).to_le_bytes());
    output.extend_from_slice(index);
    output.extend_from_slice(&0u32.to_le_bytes());
    Ok(Bytes::from(output))
}

/// Incremental whole-model cache writer for the streaming endpoint: each
/// batch's columns are appended as one Parquet row group per table, so no
/// `MeshData` has to be retained past the batch that produced it (previously
/// the endpoint kept a FULL second copy of the model's meshes just to
/// re-serialize them at Complete). The mesh-table `vertex_start`/`index_start`
/// columns carry GLOBAL offsets (whole-model), matching what the one-shot
/// `serialize_to_parquet` emits for the cached fast-path replay.
pub struct StreamingParquetCacheWriter {
    layout: ParquetLayout,
    mesh_w: ArrowWriter<Vec<u8>>,
    vert_w: ArrowWriter<Vec<u8>>,
    idx_w: ArrowWriter<Vec<u8>>,
    vertex_offset: u32,
    index_offset: u32,
    mesh_count: usize,
}

impl StreamingParquetCacheWriter {
    pub fn new(layout: ParquetLayout) -> Result<Self, ParquetError> {
        fn writer(schema: Arc<Schema>) -> Result<ArrowWriter<Vec<u8>>, ParquetError> {
            // One `append` must produce exactly ONE row group per table, or
            // the cached blob loses the batch boundaries
            // `parquet_replay_batches` recovers on a cache hit (#3895):
            // arrow-rs otherwise splits a `write` at 1,048,576 rows, which the
            // vertex table crosses on large models. `append` flushes per batch.
            let props = writer_props(&schema)
                .into_builder()
                .set_max_row_group_row_count(None)
                .build();
            Ok(ArrowWriter::try_new(Vec::new(), schema, Some(props))?)
        }
        Ok(Self {
            layout,
            mesh_w: writer(mesh_schema(layout.has_rotation()))?,
            vert_w: writer(vertex_schema())?,
            idx_w: writer(index_schema())?,
            vertex_offset: 0,
            index_offset: 0,
            mesh_count: 0,
        })
    }

    /// Append one batch as one row group per table, advancing the global
    /// offsets. The meshes can be dropped by the caller afterwards.
    pub fn append(&mut self, meshes: &[MeshData]) -> Result<(), ParquetError> {
        if meshes.is_empty() {
            return Ok(());
        }
        let (mesh_batch, vertex_batch, index_batch) = build_mesh_tables(
            meshes,
            &ShapePlan::Identity,
            self.layout,
            self.vertex_offset,
            self.index_offset,
        )?;
        self.mesh_w.write(&mesh_batch)?;
        self.mesh_w.flush()?;
        self.vert_w.write(&vertex_batch)?;
        self.vert_w.flush()?;
        self.idx_w.write(&index_batch)?;
        self.idx_w.flush()?;
        for mesh in meshes {
            // The mesh-table start columns are u32; a model that overflows
            // them must fail the cache fill loudly, not wrap into offsets
            // that decode as garbage.
            let verts = u32::try_from(mesh.positions.len() / 3)
                .ok()
                .and_then(|v| self.vertex_offset.checked_add(v));
            let idxs = u32::try_from(mesh.indices.len())
                .ok()
                .and_then(|v| self.index_offset.checked_add(v));
            match (verts, idxs) {
                (Some(v), Some(i)) => {
                    self.vertex_offset = v;
                    self.index_offset = i;
                }
                _ => {
                    return Err(ParquetError::Overflow(
                        "global vertex/index offsets exceed u32".to_string(),
                    ));
                }
            }
        }
        self.mesh_count += meshes.len();
        Ok(())
    }

    /// Total meshes appended so far.
    pub fn mesh_count(&self) -> usize {
        self.mesh_count
    }

    /// Close all three writers and assemble the `[len][mesh][len][vert][len][idx]`
    /// section blob, identical in framing to `serialize_to_parquet`.
    ///
    /// Test-only (`#[cfg(test)]`): no production caller needs the bare inner
    /// blob anymore (the parquet-stream route uses `finish_combined()`), so it
    /// stays out of the production binary. It survives as the direct
    /// counterpart to `serialize_to_parquet` for
    /// `incremental_writer_matches_one_shot_serializer`, which pins the
    /// incremental writer's decode-equivalence independent of the outer frame.
    #[cfg(test)]
    pub fn finish(self) -> Result<Bytes, ParquetError> {
        let mesh = self.mesh_w.into_inner()?;
        let vertex = self.vert_w.into_inner()?;
        let index = self.idx_w.into_inner()?;
        frame_sections(&mesh, &vertex, &index)
    }

    /// Close all three writers and assemble the OUTER combined
    /// `[geo_len][geo_bytes][data_model_len=0]` blob the parquet-stream route
    /// caches, in one allocation. Equivalent to wrapping `finish()`'s output
    /// with the route's `[geo_len]...[dm_len=0]` framing, but without
    /// copying the inner geometry blob a second time to do it.
    pub fn finish_combined(self) -> Result<Bytes, ParquetError> {
        let mesh = self.mesh_w.into_inner()?;
        let vertex = self.vert_w.into_inner()?;
        let index = self.idx_w.into_inner()?;
        frame_combined_sections(&mesh, &vertex, &index)
    }
}

/// Write a RecordBatch to a Parquet buffer with LZ4 compression.
/// Dictionary encoding is disabled for numeric columns (floats, integers) as they
/// have high entropy and dictionary encoding provides no benefit while adding significant overhead.
pub(super) fn write_parquet_buffer(batch: &RecordBatch) -> Result<Vec<u8>, ParquetError> {
    let mut buffer = Vec::new();
    let cursor = Cursor::new(&mut buffer);
    let props = writer_props(&batch.schema());
    let mut writer = ArrowWriter::try_new(cursor, batch.schema(), Some(props))?;
    writer.write(batch)?;
    writer.close()?;

    Ok(buffer)
}

/// Writer properties shared by the one-shot and incremental writers: LZ4, and
/// dictionary encoding disabled for numeric columns (high-entropy vertex data
/// gains nothing from a dictionary while paying significant overhead).
///
/// `rot0..rot8` are the exception, and the reason is the justification above
/// read backwards. They are the LOWEST-entropy columns in the schema: identity
/// on every row of an identity-plan payload (every streamed batch, and every
/// v6 model with nothing to share), and one of a handful of distinct values on
/// a shared one. Dictionary plus RLE is exactly what that shape is for, where
/// the numeric opt-out would write nine plain f32 per row -- 3.6 MB per 100k
/// rows handed to the compressor for a column with one value in it.
fn writer_props(schema: &Schema) -> WriterProperties {
    let mut props_builder = WriterProperties::builder()
        .set_compression(Compression::LZ4_RAW)
        .set_dictionary_enabled(true); // Default: enabled for strings

    for field in schema.fields() {
        let is_numeric = matches!(
            field.data_type(),
            DataType::Float32
                | DataType::Float64
                | DataType::UInt32
                | DataType::UInt64
                | DataType::Int32
                | DataType::Int64
        ) && !field.name().starts_with("rot");

        if is_numeric {
            props_builder = props_builder
                .set_column_dictionary_enabled(ColumnPath::from(field.name().as_str()), false);
        }
    }

    props_builder.build()
}

// The unit tests live in the ratchet-exempt sibling file `parquet_tests.rs`
// (kept out of this module to stay under the module-size budget). `#[path]`
// points at the sibling while it remains a child module, so `use super::*`
// still reaches this file's private helpers.
#[cfg(test)]
#[path = "parquet_tests.rs"]
mod parquet_tests;
