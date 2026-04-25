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
    // Calculate totals for pre-allocation
    let total_vertices: usize = meshes.iter().map(|m| m.positions.len() / 3).sum();
    let total_triangles: usize = meshes.iter().map(|m| m.indices.len() / 3).sum();
    let mesh_count = meshes.len();

    // Phase 1: Compute cumulative offsets (must be sequential)
    let mut vertex_offsets = Vec::with_capacity(mesh_count);
    let mut index_offsets = Vec::with_capacity(mesh_count);
    let mut vertex_offset: u32 = 0;
    let mut index_offset: u32 = 0;

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

    // Use separate schemas for each table type
    let mesh_schema = Arc::new(Schema::new(vec![
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
    ]));

    let vertex_schema = Arc::new(Schema::new(vec![
        Field::new("x", DataType::Float32, false),
        Field::new("y", DataType::Float32, false),
        Field::new("z", DataType::Float32, false),
        Field::new("nx", DataType::Float32, false),
        Field::new("ny", DataType::Float32, false),
        Field::new("nz", DataType::Float32, false),
    ]));

    let index_schema = Arc::new(Schema::new(vec![
        Field::new("i0", DataType::UInt32, false),
        Field::new("i1", DataType::UInt32, false),
        Field::new("i2", DataType::UInt32, false),
    ]));

    // Create record batches
    let mesh_batch = RecordBatch::try_new(
        mesh_schema.clone(),
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
        vertex_schema.clone(),
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
        index_schema.clone(),
        vec![
            Arc::new(UInt32Array::from(idx_0)),
            Arc::new(UInt32Array::from(idx_1)),
            Arc::new(UInt32Array::from(idx_2)),
        ],
    )?;

    // Write to a custom binary format with multiple Parquet sections
    // Format: [mesh_parquet_len:u32][mesh_parquet][vertex_parquet_len:u32][vertex_parquet][index_parquet_len:u32][index_parquet]
    let mut output = Vec::new();

    // Write mesh Parquet
    let mesh_parquet = write_parquet_buffer(&mesh_batch)?;
    output.extend_from_slice(&(mesh_parquet.len() as u32).to_le_bytes());
    output.extend_from_slice(&mesh_parquet);

    // Write vertex Parquet
    let vertex_parquet = write_parquet_buffer(&vertex_batch)?;
    output.extend_from_slice(&(vertex_parquet.len() as u32).to_le_bytes());
    output.extend_from_slice(&vertex_parquet);

    // Write index Parquet
    let index_parquet = write_parquet_buffer(&index_batch)?;
    output.extend_from_slice(&(index_parquet.len() as u32).to_le_bytes());
    output.extend_from_slice(&index_parquet);

    Ok(Bytes::from(output))
}

/// Write a RecordBatch to a Parquet buffer with LZ4 compression.
/// Dictionary encoding is disabled for numeric columns (floats, integers) as they
/// have high entropy and dictionary encoding provides no benefit while adding significant overhead.
fn write_parquet_buffer(batch: &RecordBatch) -> Result<Vec<u8>, ParquetError> {
    let mut buffer = Vec::new();
    let cursor = Cursor::new(&mut buffer);

    // Build WriterProperties with dictionary disabled for numeric columns
    let mut props_builder = WriterProperties::builder()
        .set_compression(Compression::LZ4_RAW)
        .set_dictionary_enabled(true); // Default: enabled for strings

    // Disable dictionary encoding for all numeric columns (floats and integers)
    // This dramatically speeds up serialization for high-entropy data like vertex coordinates
    for field in batch.schema().fields() {
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

    let props = props_builder.build();

    let mut writer = ArrowWriter::try_new(cursor, batch.schema(), Some(props))?;
    writer.write(batch)?;
    writer.close()?;

    Ok(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parquet_serialization() {
        let meshes = vec![
            MeshData::new(
                1,
                "IfcWall".to_string(),
                vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0],
                vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
                vec![0, 1, 2],
                [0.8, 0.8, 0.8, 1.0],
            ),
            MeshData::new(
                2,
                "IfcSlab".to_string(),
                vec![0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 2.0, 2.0, 0.0, 0.0, 2.0, 0.0],
                vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
                vec![0, 1, 2, 0, 2, 3],
                [0.5, 0.5, 0.5, 1.0],
            ),
        ];

        let result = serialize_to_parquet(&meshes);
        assert!(result.is_ok());

        let data = result.unwrap();
        // Should be much smaller than JSON equivalent
        // Note: Parquet has fixed overhead (~4KB headers), so small test data may appear larger
        // Real-world compression is 15x+ on actual IFC geometry data
        assert!(
            data.len() < 10000,
            "Expected compact output, got {} bytes",
            data.len()
        );
    }

    /// Regression test for #586: meshes with positions but no normals
    /// (e.g. `advanced_brep.ifc`) used to panic with "index out of bounds"
    /// inside the rayon worker, taking down the server process.
    #[test]
    fn test_serialize_mesh_without_normals() {
        let meshes = vec![MeshData::new(
            42,
            "IfcAdvancedBrep".to_string(),
            vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0],
            Vec::new(), // no normals — must not panic
            vec![0, 1, 2],
            [0.8, 0.8, 0.8, 1.0],
        )];

        let result = serialize_to_parquet(&meshes);
        assert!(
            result.is_ok(),
            "serialize_to_parquet should not panic on empty normals: {:?}",
            result.err()
        );
    }
}
