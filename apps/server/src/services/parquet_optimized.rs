// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Optimized Parquet serialization using ara3d BimOpenSchema format.
//!
//! Key optimizations over basic Parquet:
//! 1. Integer quantized vertices (10,000x multiplier = 0.1mm precision)
//! 2. Mesh deduplication via content hashing (instancing)
//! 3. Byte colors (0-255) instead of float (0-1)
//! 4. Optional normals (can compute on client)
//! 5. Material deduplication
//!
//! Typical additional compression: 3-5x over basic Parquet format.

use crate::types::MeshData;
use arrow::array::{Float32Array, Int32Array, StringArray, UInt32Array, UInt8Array};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use bytes::Bytes;
use parquet::arrow::ArrowWriter;
use parquet::basic::Compression;
use parquet::file::properties::WriterProperties;
use parquet::schema::types::ColumnPath;
use rustc_hash::FxHashMap;
use std::hash::{Hash, Hasher};
use std::io::Cursor;
use std::sync::Arc;

use super::ParquetError;

/// Vertex multiplier for integer quantization.
/// 10,000 = 0.1mm precision, which is sufficient for BIM.
pub const VERTEX_MULTIPLIER: f32 = 10_000.0;

/// Hash key for mesh geometry (for deduplication).
#[derive(Clone, PartialEq, Eq)]
struct MeshGeometryKey {
    /// Quantized positions as bytes for hashing
    positions_hash: u64,
    /// Quantized indices hash
    indices_hash: u64,
}

impl Hash for MeshGeometryKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.positions_hash.hash(state);
        self.indices_hash.hash(state);
    }
}

/// Compute a fast hash of a u32 slice.
fn hash_u32_slice(data: &[u32]) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    let mut hasher = DefaultHasher::new();
    for item in data {
        item.hash(&mut hasher);
    }
    hasher.finish()
}

/// Compute a fast hash of a f32 slice (using bit representation).
fn hash_f32_slice(data: &[f32]) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    let mut hasher = DefaultHasher::new();
    for item in data {
        // Convert f32 to bits for hashing (handles NaN consistently)
        item.to_bits().hash(&mut hasher);
    }
    hasher.finish()
}

/// Quantize a float position to integer (0.1mm precision).
#[inline]
fn quantize_position(value: f32) -> i32 {
    (value * VERTEX_MULTIPLIER).round() as i32
}

/// Convert float color (0-1) to byte (0-255).
#[inline]
fn color_to_byte(value: f32) -> u8 {
    (value.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// Material key for deduplication.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct MaterialKey {
    r: u8,
    g: u8,
    b: u8,
    a: u8,
}

impl MaterialKey {
    fn from_color(color: &[f32; 4]) -> Self {
        Self {
            r: color_to_byte(color[0]),
            g: color_to_byte(color[1]),
            b: color_to_byte(color[2]),
            a: color_to_byte(color[3]),
        }
    }
}

/// Serialize mesh data to optimized Parquet format (ara3d BOS-compatible).
///
/// Format:
/// 1. Instances table (entity → mesh, material indices)
/// 2. Meshes table (unique geometries)
/// 3. Materials table (unique colors)
/// 4. Vertices table (quantized integers)
/// 5. Indices table
///
/// This enables significant deduplication for IFC files where many elements
/// share the same geometry (windows, doors, standard components).
pub fn serialize_to_parquet_optimized(
    meshes: &[MeshData],
    include_normals: bool,
) -> Result<Bytes, ParquetError> {
    // Phase 1: Deduplicate meshes and materials
    let mut unique_meshes: Vec<&MeshData> = Vec::new();
    let mut mesh_lookup: FxHashMap<MeshGeometryKey, u32> = FxHashMap::default();
    let mut unique_materials: Vec<MaterialKey> = Vec::new();
    let mut material_lookup: FxHashMap<MaterialKey, u32> = FxHashMap::default();

    // Instance data
    let mut instance_entity_ids: Vec<u32> = Vec::with_capacity(meshes.len());
    let mut instance_ifc_types: Vec<&str> = Vec::with_capacity(meshes.len());
    let mut instance_mesh_indices: Vec<u32> = Vec::with_capacity(meshes.len());
    let mut instance_material_indices: Vec<u32> = Vec::with_capacity(meshes.len());

    for mesh in meshes {
        // Compute geometry hash for deduplication
        let positions_hash = hash_f32_slice(&mesh.positions);
        let indices_hash = hash_u32_slice(&mesh.indices);
        let geo_key = MeshGeometryKey {
            positions_hash,
            indices_hash,
        };

        // Get or create mesh index
        let mesh_idx = *mesh_lookup.entry(geo_key).or_insert_with(|| {
            let idx = unique_meshes.len() as u32;
            unique_meshes.push(mesh);
            idx
        });

        // Get or create material index
        let mat_key = MaterialKey::from_color(&mesh.color);
        let material_idx = *material_lookup.entry(mat_key).or_insert_with(|| {
            let idx = unique_materials.len() as u32;
            unique_materials.push(mat_key);
            idx
        });

        // Record instance
        instance_entity_ids.push(mesh.express_id);
        instance_ifc_types.push(&mesh.ifc_type);
        instance_mesh_indices.push(mesh_idx);
        instance_material_indices.push(material_idx);
    }

    // Phase 2: Build vertex and index buffers from unique meshes
    let total_vertices: usize = unique_meshes.iter().map(|m| m.positions.len() / 3).sum();
    let total_indices: usize = unique_meshes.iter().map(|m| m.indices.len()).sum();

    // Quantized vertex data
    let mut vertex_x: Vec<i32> = Vec::with_capacity(total_vertices);
    let mut vertex_y: Vec<i32> = Vec::with_capacity(total_vertices);
    let mut vertex_z: Vec<i32> = Vec::with_capacity(total_vertices);

    // Optional normals (as floats, since normals don't benefit from quantization)
    let mut normal_x: Vec<f32> = if include_normals {
        Vec::with_capacity(total_vertices)
    } else {
        Vec::new()
    };
    let mut normal_y: Vec<f32> = if include_normals {
        Vec::with_capacity(total_vertices)
    } else {
        Vec::new()
    };
    let mut normal_z: Vec<f32> = if include_normals {
        Vec::with_capacity(total_vertices)
    } else {
        Vec::new()
    };

    // Index buffer
    let mut indices: Vec<u32> = Vec::with_capacity(total_indices);

    // Mesh offsets
    let mut mesh_vertex_offsets: Vec<u32> = Vec::with_capacity(unique_meshes.len());
    let mut mesh_vertex_counts: Vec<u32> = Vec::with_capacity(unique_meshes.len());
    let mut mesh_index_offsets: Vec<u32> = Vec::with_capacity(unique_meshes.len());
    let mut mesh_index_counts: Vec<u32> = Vec::with_capacity(unique_meshes.len());

    let mut vertex_offset: u32 = 0;
    let mut index_offset: u32 = 0;

    for mesh in &unique_meshes {
        let vert_count = mesh.positions.len() / 3;

        mesh_vertex_offsets.push(vertex_offset);
        mesh_vertex_counts.push(vert_count as u32);
        mesh_index_offsets.push(index_offset);
        mesh_index_counts.push(mesh.indices.len() as u32);

        // Some IFC pipelines (e.g. advanced_brep) yield meshes with positions
        // but no normals; pad with zeros so the schema's non-null columns stay valid.
        let mesh_has_normals = mesh.normals.len() == mesh.positions.len();
        if include_normals && !mesh_has_normals && !mesh.normals.is_empty() {
            tracing::warn!(
                express_id = mesh.express_id,
                ifc_type = %mesh.ifc_type,
                positions = mesh.positions.len(),
                normals = mesh.normals.len(),
                "Mesh normals length mismatch; emitting zero normals"
            );
        }

        // Quantize and store vertices with Z-up to Y-up transform
        // OPTIMIZATION: Apply coordinate transform server-side to eliminate client per-vertex loops
        // IFC uses Z-up, WebGL uses Y-up. Transform: X stays same, new Y = old Z, new Z = -old Y
        for i in 0..vert_count {
            vertex_x.push(quantize_position(mesh.positions[i * 3])); // X stays the same
            vertex_y.push(quantize_position(mesh.positions[i * 3 + 2])); // New Y = old Z (vertical)
            vertex_z.push(quantize_position(-mesh.positions[i * 3 + 1])); // New Z = -old Y (depth)

            if include_normals {
                if mesh_has_normals {
                    normal_x.push(mesh.normals[i * 3]); // X stays the same
                    normal_y.push(mesh.normals[i * 3 + 2]); // New Y = old Z
                    normal_z.push(-mesh.normals[i * 3 + 1]); // New Z = -old Y
                } else {
                    normal_x.push(0.0);
                    normal_y.push(0.0);
                    normal_z.push(0.0);
                }
            }
        }

        // Store indices
        indices.extend_from_slice(&mesh.indices);

        vertex_offset += vert_count as u32;
        index_offset += mesh.indices.len() as u32;
    }

    // Phase 3: Create Parquet tables

    // Instance table schema
    let instance_schema = Arc::new(Schema::new(vec![
        Field::new("entity_id", DataType::UInt32, false),
        Field::new("ifc_type", DataType::Utf8, false),
        Field::new("mesh_index", DataType::UInt32, false),
        Field::new("material_index", DataType::UInt32, false),
    ]));

    let instance_batch = RecordBatch::try_new(
        instance_schema,
        vec![
            Arc::new(UInt32Array::from(instance_entity_ids)),
            Arc::new(StringArray::from(instance_ifc_types)),
            Arc::new(UInt32Array::from(instance_mesh_indices)),
            Arc::new(UInt32Array::from(instance_material_indices)),
        ],
    )?;

    // Mesh table schema
    let mesh_schema = Arc::new(Schema::new(vec![
        Field::new("vertex_offset", DataType::UInt32, false),
        Field::new("vertex_count", DataType::UInt32, false),
        Field::new("index_offset", DataType::UInt32, false),
        Field::new("index_count", DataType::UInt32, false),
    ]));

    let mesh_batch = RecordBatch::try_new(
        mesh_schema,
        vec![
            Arc::new(UInt32Array::from(mesh_vertex_offsets)),
            Arc::new(UInt32Array::from(mesh_vertex_counts)),
            Arc::new(UInt32Array::from(mesh_index_offsets)),
            Arc::new(UInt32Array::from(mesh_index_counts)),
        ],
    )?;

    // Material table schema (byte colors)
    let material_schema = Arc::new(Schema::new(vec![
        Field::new("r", DataType::UInt8, false),
        Field::new("g", DataType::UInt8, false),
        Field::new("b", DataType::UInt8, false),
        Field::new("a", DataType::UInt8, false),
    ]));

    let material_batch = RecordBatch::try_new(
        material_schema,
        vec![
            Arc::new(UInt8Array::from(
                unique_materials.iter().map(|m| m.r).collect::<Vec<_>>(),
            )),
            Arc::new(UInt8Array::from(
                unique_materials.iter().map(|m| m.g).collect::<Vec<_>>(),
            )),
            Arc::new(UInt8Array::from(
                unique_materials.iter().map(|m| m.b).collect::<Vec<_>>(),
            )),
            Arc::new(UInt8Array::from(
                unique_materials.iter().map(|m| m.a).collect::<Vec<_>>(),
            )),
        ],
    )?;

    // Vertex table schema (quantized integers)
    let vertex_schema = if include_normals {
        Arc::new(Schema::new(vec![
            Field::new("x", DataType::Int32, false),
            Field::new("y", DataType::Int32, false),
            Field::new("z", DataType::Int32, false),
            Field::new("nx", DataType::Float32, false),
            Field::new("ny", DataType::Float32, false),
            Field::new("nz", DataType::Float32, false),
        ]))
    } else {
        Arc::new(Schema::new(vec![
            Field::new("x", DataType::Int32, false),
            Field::new("y", DataType::Int32, false),
            Field::new("z", DataType::Int32, false),
        ]))
    };

    let vertex_batch = if include_normals {
        RecordBatch::try_new(
            vertex_schema,
            vec![
                Arc::new(Int32Array::from(vertex_x)),
                Arc::new(Int32Array::from(vertex_y)),
                Arc::new(Int32Array::from(vertex_z)),
                Arc::new(Float32Array::from(normal_x)),
                Arc::new(Float32Array::from(normal_y)),
                Arc::new(Float32Array::from(normal_z)),
            ],
        )?
    } else {
        RecordBatch::try_new(
            vertex_schema,
            vec![
                Arc::new(Int32Array::from(vertex_x)),
                Arc::new(Int32Array::from(vertex_y)),
                Arc::new(Int32Array::from(vertex_z)),
            ],
        )?
    };

    // Index table schema
    let index_schema = Arc::new(Schema::new(vec![Field::new("i", DataType::UInt32, false)]));

    let index_batch =
        RecordBatch::try_new(index_schema, vec![Arc::new(UInt32Array::from(indices))])?;

    // Phase 4: Write to binary format
    // Header: [version:u8][flags:u8][instance_len:u32][mesh_len:u32][material_len:u32][vertex_len:u32][index_len:u32]
    // Then: [instance_parquet][mesh_parquet][material_parquet][vertex_parquet][index_parquet]
    let mut output = Vec::new();

    // Version 2 = optimized format
    output.push(2u8);
    // Flags: bit 0 = has_normals
    output.push(if include_normals { 1u8 } else { 0u8 });

    // Write tables
    let instance_parquet = write_parquet_buffer(&instance_batch)?;
    output.extend_from_slice(&(instance_parquet.len() as u32).to_le_bytes());

    let mesh_parquet = write_parquet_buffer(&mesh_batch)?;
    output.extend_from_slice(&(mesh_parquet.len() as u32).to_le_bytes());

    let material_parquet = write_parquet_buffer(&material_batch)?;
    output.extend_from_slice(&(material_parquet.len() as u32).to_le_bytes());

    let vertex_parquet = write_parquet_buffer(&vertex_batch)?;
    output.extend_from_slice(&(vertex_parquet.len() as u32).to_le_bytes());

    let index_parquet = write_parquet_buffer(&index_batch)?;
    output.extend_from_slice(&(index_parquet.len() as u32).to_le_bytes());

    // Append all parquet data
    output.extend_from_slice(&instance_parquet);
    output.extend_from_slice(&mesh_parquet);
    output.extend_from_slice(&material_parquet);
    output.extend_from_slice(&vertex_parquet);
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
                | DataType::UInt8
                | DataType::Int8
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

/// Statistics about the optimized serialization.
#[derive(Debug, Clone, serde::Serialize)]
pub struct OptimizedStats {
    /// Number of input meshes
    pub input_meshes: usize,
    /// Number of unique meshes after deduplication
    pub unique_meshes: usize,
    /// Number of unique materials
    pub unique_materials: usize,
    /// Mesh reuse ratio (higher = more instancing)
    pub mesh_reuse_ratio: f32,
    /// Whether normals are included
    pub has_normals: bool,
}

/// Serialize with stats.
pub fn serialize_to_parquet_optimized_with_stats(
    meshes: &[MeshData],
    include_normals: bool,
) -> Result<(Bytes, OptimizedStats), ParquetError> {
    // First pass: count unique meshes/materials
    let mut mesh_hashes: FxHashMap<(u64, u64), u32> = FxHashMap::default();
    let mut material_keys: FxHashMap<MaterialKey, u32> = FxHashMap::default();

    for mesh in meshes {
        let pos_hash = hash_f32_slice(&mesh.positions);
        let idx_hash = hash_u32_slice(&mesh.indices);
        mesh_hashes.entry((pos_hash, idx_hash)).or_insert(0);

        let mat_key = MaterialKey::from_color(&mesh.color);
        material_keys.entry(mat_key).or_insert(0);
    }

    let unique_mesh_count = mesh_hashes.len();
    let unique_material_count = material_keys.len();

    let data = serialize_to_parquet_optimized(meshes, include_normals)?;

    let stats = OptimizedStats {
        input_meshes: meshes.len(),
        unique_meshes: unique_mesh_count,
        unique_materials: unique_material_count,
        mesh_reuse_ratio: if unique_mesh_count > 0 {
            meshes.len() as f32 / unique_mesh_count as f32
        } else {
            1.0
        },
        has_normals: include_normals,
    };

    Ok((data, stats))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_optimized_parquet_serialization() {
        // Create test data with some duplicate meshes
        let wall_positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0];
        let wall_normals = vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
        let wall_indices = vec![0, 1, 2];
        let wall_color = [0.8, 0.8, 0.8, 1.0];

        let meshes = vec![
            // Two walls with same geometry (should be deduplicated)
            MeshData::new(
                1,
                "IfcWall".to_string(),
                wall_positions.clone(),
                wall_normals.clone(),
                wall_indices.clone(),
                wall_color,
            ),
            MeshData::new(
                2,
                "IfcWall".to_string(),
                wall_positions.clone(),
                wall_normals.clone(),
                wall_indices.clone(),
                wall_color,
            ),
            // Different geometry
            MeshData::new(
                3,
                "IfcSlab".to_string(),
                vec![0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 2.0, 2.0, 0.0, 0.0, 2.0, 0.0],
                vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
                vec![0, 1, 2, 0, 2, 3],
                [0.5, 0.5, 0.5, 1.0],
            ),
        ];

        let (data, stats) = serialize_to_parquet_optimized_with_stats(&meshes, false).unwrap();

        // Should deduplicate the two identical walls
        assert_eq!(stats.input_meshes, 3);
        assert_eq!(stats.unique_meshes, 2);
        assert_eq!(stats.unique_materials, 2);
        assert!(stats.mesh_reuse_ratio > 1.0);

        // Should be very compact
        // Note: Parquet has fixed overhead, so small test data may be larger
        assert!(
            data.len() < 5000,
            "Expected compact output, got {} bytes",
            data.len()
        );
    }

    #[test]
    fn test_quantization() {
        assert_eq!(quantize_position(1.0), 10_000);
        assert_eq!(quantize_position(0.0001), 1); // 0.1mm
        assert_eq!(quantize_position(-1.5), -15_000);
    }

    #[test]
    fn test_color_to_byte() {
        assert_eq!(color_to_byte(0.0), 0);
        assert_eq!(color_to_byte(1.0), 255);
        assert_eq!(color_to_byte(0.5), 128);
    }

    /// Regression test for #586: meshes with positions but no normals
    /// (e.g. `advanced_brep.ifc`) used to panic when `include_normals = true`.
    #[test]
    fn test_optimized_serialize_mesh_without_normals() {
        let meshes = vec![MeshData::new(
            42,
            "IfcAdvancedBrep".to_string(),
            vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0],
            Vec::new(),
            vec![0, 1, 2],
            [0.8, 0.8, 0.8, 1.0],
        )];

        // Both code paths must survive empty normals.
        assert!(serialize_to_parquet_optimized_with_stats(&meshes, false).is_ok());
        assert!(serialize_to_parquet_optimized_with_stats(&meshes, true).is_ok());
    }
}
