// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Parquet serialization for efficient mesh data transfer.
//!
//! Uses columnar format (ara3d BOS-compatible) for dramatically better compression
//! compared to JSON serialization. Typical compression ratios:
//! - JSON: ~30KB per mesh with ~500 vertices
//! - Parquet: ~2KB per mesh (15x smaller)

use crate::types::MeshData;
use arrow::array::{Float32Array, StringArray, UInt32Array};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use bytes::Bytes;
use parquet::arrow::ArrowWriter;
use parquet::basic::Compression;
use parquet::file::properties::WriterProperties;
use parquet::schema::types::ColumnPath;
use rayon::prelude::*;
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
// The per-mesh column tuple type is explicit on purpose; aliasing it would hide
// the parallel (positions, normals, colors, ...) column layout.
#[allow(clippy::type_complexity)]
pub fn serialize_to_parquet(meshes: &[MeshData]) -> Result<Bytes, ParquetError> {
    let (mesh_batch, vertex_batch, index_batch) = build_mesh_tables(meshes, 0, 0)?;

    // Write to a custom binary format with multiple Parquet sections
    // Format: [mesh_parquet_len:u32][mesh_parquet][vertex_parquet_len:u32][vertex_parquet][index_parquet_len:u32][index_parquet]
    let mesh_parquet = write_parquet_buffer(&mesh_batch)?;
    let vertex_parquet = write_parquet_buffer(&vertex_batch)?;
    let index_parquet = write_parquet_buffer(&index_batch)?;
    frame_sections(&mesh_parquet, &vertex_parquet, &index_parquet)
}

/// Fail loud instead of silently truncating a wire-format `u32` length
/// prefix when a section exceeds 4 GiB.
fn check_u32_len(name: &str, len: usize) -> Result<(), ParquetError> {
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
fn frame_sections(mesh: &[u8], vertex: &[u8], index: &[u8]) -> Result<Bytes, ParquetError> {
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

/// Build the three Arrow tables (mesh metadata / vertices / indices) for a
/// slice of meshes. `base_vertex_offset` / `base_index_offset` seed the
/// mesh-table `vertex_start` / `index_start` columns so an incremental caller
/// (the streaming cache writer) emits GLOBAL whole-model offsets while the
/// per-batch client blobs keep batch-local ones (bases 0/0). The Z-up to Y-up
/// transform lives here, in one place, for both paths.
// The per-mesh column tuple type is explicit on purpose; aliasing it would hide
// the parallel (positions, normals, colors, ...) column layout.
#[allow(clippy::type_complexity)]
fn build_mesh_tables(
    meshes: &[MeshData],
    base_vertex_offset: u32,
    base_index_offset: u32,
) -> Result<(RecordBatch, RecordBatch, RecordBatch), ParquetError> {
    // Calculate totals for pre-allocation
    let total_vertices: usize = meshes.iter().map(|m| m.positions.len() / 3).sum();
    let total_triangles: usize = meshes.iter().map(|m| m.indices.len() / 3).sum();
    let mesh_count = meshes.len();

    // Phase 1: Compute cumulative offsets (must be sequential)
    let mut vertex_offsets = Vec::with_capacity(mesh_count);
    let mut index_offsets = Vec::with_capacity(mesh_count);
    let mut vertex_offset: u32 = base_vertex_offset;
    let mut index_offset: u32 = base_index_offset;

    for mesh in meshes {
        vertex_offsets.push(vertex_offset);
        index_offsets.push(index_offset);
        vertex_offset += (mesh.positions.len() / 3) as u32;
        index_offset += mesh.indices.len() as u32;
    }

    // Phase 2: Extract mesh metadata in parallel
    let metadata: Vec<_> = meshes
        .par_iter()
        .zip(vertex_offsets.par_iter())
        .zip(index_offsets.par_iter())
        .map(|((mesh, &v_start), &i_start)| {
            let vert_count = mesh.positions.len() / 3;
            (
                mesh.express_id,
                mesh.ifc_type.as_str(),
                v_start,
                vert_count as u32,
                i_start,
                mesh.indices.len() as u32,
                mesh.color,
            )
        })
        .collect();

    // Unpack metadata into separate vectors
    let mut express_ids = Vec::with_capacity(mesh_count);
    let mut ifc_types: Vec<&str> = Vec::with_capacity(mesh_count);
    let mut vertex_starts = Vec::with_capacity(mesh_count);
    let mut vertex_counts = Vec::with_capacity(mesh_count);
    let mut index_starts = Vec::with_capacity(mesh_count);
    let mut index_counts = Vec::with_capacity(mesh_count);
    let mut color_r = Vec::with_capacity(mesh_count);
    let mut color_g = Vec::with_capacity(mesh_count);
    let mut color_b = Vec::with_capacity(mesh_count);
    let mut color_a = Vec::with_capacity(mesh_count);

    for (eid, itype, vstart, vcount, istart, icount, color) in metadata {
        express_ids.push(eid);
        ifc_types.push(itype);
        vertex_starts.push(vstart);
        vertex_counts.push(vcount);
        index_starts.push(istart);
        index_counts.push(icount);
        color_r.push(color[0]);
        color_g.push(color[1]);
        color_b.push(color[2]);
        color_a.push(color[3]);
    }

    // Phase 3: Extract vertex and index data in parallel chunks
    // Process meshes in parallel, then flatten results
    // OPTIMIZATION: Apply Z-up to Y-up coordinate transform server-side
    // This eliminates per-vertex loops on the client (IFC uses Z-up, WebGL uses Y-up)
    // Transform: X stays same, new Y = old Z, new Z = -old Y
    let vertex_data: Vec<(Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>)> = meshes
        .par_iter()
        .map(|mesh| {
            let vert_count = mesh.positions.len() / 3;
            let mut px = Vec::with_capacity(vert_count);
            let mut py = Vec::with_capacity(vert_count);
            let mut pz = Vec::with_capacity(vert_count);
            let mut nx = Vec::with_capacity(vert_count);
            let mut ny = Vec::with_capacity(vert_count);
            let mut nz = Vec::with_capacity(vert_count);

            // Some IFC pipelines (e.g. advanced_brep) yield meshes with positions
            // but no normals. The schema below requires non-null normal columns,
            // so pad with zeros and let the client recompute them from positions.
            let has_normals = mesh.normals.len() == mesh.positions.len();
            if !has_normals && !mesh.normals.is_empty() {
                tracing::warn!(
                    express_id = mesh.express_id,
                    ifc_type = %mesh.ifc_type,
                    positions = mesh.positions.len(),
                    normals = mesh.normals.len(),
                    "Mesh normals length mismatch; emitting zero normals"
                );
            }

            for i in 0..vert_count {
                // Position: Z-up to Y-up transform
                px.push(mesh.positions[i * 3]); // X stays the same
                py.push(mesh.positions[i * 3 + 2]); // New Y = old Z (vertical)
                pz.push(-mesh.positions[i * 3 + 1]); // New Z = -old Y (depth)

                if has_normals {
                    // Normal: Same transform as position
                    nx.push(mesh.normals[i * 3]); // X stays the same
                    ny.push(mesh.normals[i * 3 + 2]); // New Y = old Z
                    nz.push(-mesh.normals[i * 3 + 1]); // New Z = -old Y
                } else {
                    nx.push(0.0);
                    ny.push(0.0);
                    nz.push(0.0);
                }
            }
            (px, py, pz, nx, ny, nz)
        })
        .collect();

    // Flatten vertex data
    let mut pos_x = Vec::with_capacity(total_vertices);
    let mut pos_y = Vec::with_capacity(total_vertices);
    let mut pos_z = Vec::with_capacity(total_vertices);
    let mut norm_x = Vec::with_capacity(total_vertices);
    let mut norm_y = Vec::with_capacity(total_vertices);
    let mut norm_z = Vec::with_capacity(total_vertices);

    for (px, py, pz, nx, ny, nz) in vertex_data {
        pos_x.extend(px);
        pos_y.extend(py);
        pos_z.extend(pz);
        norm_x.extend(nx);
        norm_y.extend(ny);
        norm_z.extend(nz);
    }

    // Extract index data in parallel
    let index_data: Vec<(Vec<u32>, Vec<u32>, Vec<u32>)> = meshes
        .par_iter()
        .map(|mesh| {
            let tri_count = mesh.indices.len() / 3;
            let mut i0 = Vec::with_capacity(tri_count);
            let mut i1 = Vec::with_capacity(tri_count);
            let mut i2 = Vec::with_capacity(tri_count);

            for i in 0..tri_count {
                i0.push(mesh.indices[i * 3]);
                i1.push(mesh.indices[i * 3 + 1]);
                i2.push(mesh.indices[i * 3 + 2]);
            }
            (i0, i1, i2)
        })
        .collect();

    // Flatten index data
    let mut idx_0 = Vec::with_capacity(total_triangles);
    let mut idx_1 = Vec::with_capacity(total_triangles);
    let mut idx_2 = Vec::with_capacity(total_triangles);

    for (i0, i1, i2) in index_data {
        idx_0.extend(i0);
        idx_1.extend(i1);
        idx_2.extend(i2);
    }

    // Create record batches
    let mesh_batch = RecordBatch::try_new(
        mesh_schema(),
        vec![
            Arc::new(UInt32Array::from(express_ids)),
            Arc::new(StringArray::from(ifc_types)),
            Arc::new(UInt32Array::from(vertex_starts)),
            Arc::new(UInt32Array::from(vertex_counts)),
            Arc::new(UInt32Array::from(index_starts)),
            Arc::new(UInt32Array::from(index_counts)),
            Arc::new(Float32Array::from(color_r)),
            Arc::new(Float32Array::from(color_g)),
            Arc::new(Float32Array::from(color_b)),
            Arc::new(Float32Array::from(color_a)),
        ],
    )?;

    let vertex_batch = RecordBatch::try_new(
        vertex_schema(),
        vec![
            Arc::new(Float32Array::from(pos_x)),
            Arc::new(Float32Array::from(pos_y)),
            Arc::new(Float32Array::from(pos_z)),
            Arc::new(Float32Array::from(norm_x)),
            Arc::new(Float32Array::from(norm_y)),
            Arc::new(Float32Array::from(norm_z)),
        ],
    )?;

    let index_batch = RecordBatch::try_new(
        index_schema(),
        vec![
            Arc::new(UInt32Array::from(idx_0)),
            Arc::new(UInt32Array::from(idx_1)),
            Arc::new(UInt32Array::from(idx_2)),
        ],
    )?;

    Ok((mesh_batch, vertex_batch, index_batch))
}

fn mesh_schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("express_id", DataType::UInt32, false),
        Field::new("ifc_type", DataType::Utf8, false),
        Field::new("vertex_start", DataType::UInt32, false),
        Field::new("vertex_count", DataType::UInt32, false),
        Field::new("index_start", DataType::UInt32, false),
        Field::new("index_count", DataType::UInt32, false),
        Field::new("color_r", DataType::Float32, false),
        Field::new("color_g", DataType::Float32, false),
        Field::new("color_b", DataType::Float32, false),
        Field::new("color_a", DataType::Float32, false),
    ]))
}

fn vertex_schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("x", DataType::Float32, false),
        Field::new("y", DataType::Float32, false),
        Field::new("z", DataType::Float32, false),
        Field::new("nx", DataType::Float32, false),
        Field::new("ny", DataType::Float32, false),
        Field::new("nz", DataType::Float32, false),
    ]))
}

fn index_schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("i0", DataType::UInt32, false),
        Field::new("i1", DataType::UInt32, false),
        Field::new("i2", DataType::UInt32, false),
    ]))
}

/// Incremental whole-model cache writer for the streaming endpoint: each
/// batch's columns are appended as one Parquet row group per table, so no
/// `MeshData` has to be retained past the batch that produced it (previously
/// the endpoint kept a FULL second copy of the model's meshes just to
/// re-serialize them at Complete). The mesh-table `vertex_start`/`index_start`
/// columns carry GLOBAL offsets (whole-model), matching what the one-shot
/// `serialize_to_parquet` emits for the cached fast-path replay.
pub struct StreamingParquetCacheWriter {
    mesh_w: ArrowWriter<Vec<u8>>,
    vert_w: ArrowWriter<Vec<u8>>,
    idx_w: ArrowWriter<Vec<u8>>,
    vertex_offset: u32,
    index_offset: u32,
    mesh_count: usize,
}

impl StreamingParquetCacheWriter {
    pub fn new() -> Result<Self, ParquetError> {
        fn writer(schema: Arc<Schema>) -> Result<ArrowWriter<Vec<u8>>, ParquetError> {
            let props = writer_props(&schema);
            Ok(ArrowWriter::try_new(Vec::new(), schema, Some(props))?)
        }
        Ok(Self {
            mesh_w: writer(mesh_schema())?,
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
        let (mesh_batch, vertex_batch, index_batch) =
            build_mesh_tables(meshes, self.vertex_offset, self.index_offset)?;
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
fn write_parquet_buffer(batch: &RecordBatch) -> Result<Vec<u8>, ParquetError> {
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
        );

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
