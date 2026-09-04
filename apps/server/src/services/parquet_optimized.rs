// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Optimized Parquet serialization using ara3d BimOpenSchema format.
//!
//! Key optimizations over basic Parquet: integer quantized vertices (10,000x
//! multiplier = 0.1mm precision), mesh dedup via content hashing PLUS
//! rotation-aware representation-identity dedup (#3575), byte colors
//! (0-255 instead of float 0-1), optional normals, material dedup.
//!
//! Typical additional compression: 3-5x over basic Parquet format.

use crate::services::axis::{zup_to_yup, zup_to_yup_f64};
use crate::services::parquet_schema::{instance_schema, ABSENT_SOURCE_ID};
use crate::types::MeshData;
use arrow::array::{Float32Array, Float64Array, Int32Array, StringArray, UInt32Array, UInt8Array};
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

use super::parquet::check_u32_len;
use super::ParquetError;

use crate::services::parquet_instancing::{
    collate_rotation_aware_placements, optimized_wire_version, rotation_zup_to_yup,
    IDENTITY_ROTATION,
};

/// Vertex multiplier for integer quantization. 10,000 = 0.1mm precision.
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

/// Serialize mesh data to optimized Parquet format (ara3d BOS-compatible):
/// instances table (entity → mesh/material index, origin, rotation), meshes
/// table (unique geometries), materials table, vertices table (quantized
/// integers), indices table. Dedup covers both bit-identical placements
/// (content hash) and, as of issue #3575, one shape at DIFFERENT rotations
/// (`IfcMappedItem` / shared `IfcRepresentationMap` reuse — furniture, pipe
/// runs, repeated structural members).
///
/// Not `pub`: [`serialize_to_parquet_optimized_with_stats`] below is the only
/// caller, wrapping this to report the unique mesh/material counts THIS same
/// dedup pass produces. A separate content-hash-only stats pass used to live
/// here and would have kept `mesh_reuse_ratio` pinned at ~1.0 even after this
/// fix started deduplicating rotated instances — exactly the blind spot
/// #3575 closes.
fn serialize_to_parquet_optimized(
    meshes: &[MeshData],
    include_normals: bool,
) -> Result<(Bytes, usize, usize), ParquetError> {
    // Rotation-aware dedup (#3575): occurrences of one representation at
    // DIFFERENT orientations. Content-hashing baked vertices (below) can
    // never merge these — rotation is baked into the vertex values.
    let rotated_placements = collate_rotation_aware_placements(meshes);

    // Phase 1: Deduplicate meshes and materials
    let mut unique_meshes: Vec<&MeshData> = Vec::new();
    let mut mesh_lookup: FxHashMap<MeshGeometryKey, u32> = FxHashMap::default();
    // Rotation-aware groups key by the TEMPLATE's index in `meshes`, not by
    // content hash: the template geometry is what every occurrence in the
    // group was verified against.
    let mut template_lookup: FxHashMap<usize, u32> = FxHashMap::default();
    let mut unique_materials: Vec<MaterialKey> = Vec::new();
    let mut material_lookup: FxHashMap<MaterialKey, u32> = FxHashMap::default();

    // Instance data
    let mut instance_entity_ids: Vec<u32> = Vec::with_capacity(meshes.len());
    let mut instance_ifc_types: Vec<&str> = Vec::with_capacity(meshes.len());
    let mut instance_mesh_indices: Vec<u32> = Vec::with_capacity(meshes.len());
    let mut instance_material_indices: Vec<u32> = Vec::with_capacity(meshes.len());
    // Per-instance placement + provenance (issue #1841). Dedup merges meshes
    // whose vertex buffers are bit-identical — which, in an origin-relative
    // frame, is exactly two occurrences of the same shape at DIFFERENT origins.
    // Without a per-instance origin those repeats all render at the shared
    // template coordinates ("N slabs collapse to one"). Carrying the origin (in
    // the same Y-up frame as the vertices) lets the client place each instance
    // via world = origin + template_position. Zero for world-baked meshes.
    let mut instance_origin_x: Vec<f64> = Vec::with_capacity(meshes.len());
    let mut instance_origin_y: Vec<f64> = Vec::with_capacity(meshes.len());
    let mut instance_origin_z: Vec<f64> = Vec::with_capacity(meshes.len());
    let mut instance_geometry_class: Vec<u8> = Vec::with_capacity(meshes.len());
    // PER INSTANCE, not per template (#3215): the dedup key is vertex data, so
    // two instances sharing a template can come from different source items.
    let mut instance_geometry_item_ids: Vec<u32> = Vec::with_capacity(meshes.len());
    let mut instance_material_ids: Vec<u32> = Vec::with_capacity(meshes.len());
    // Per-instance rotation (#3575), row-major 3x3, Y-up: world = origin +
    // R * template_position. Identity where no verified placement applies.
    let mut instance_rotation: [Vec<f32>; 9] = Default::default();
    // Gates both the wire version and the rotation columns' presence -- see `optimized_wire_version`.
    let mut emitted_non_identity_rotation = false;

    for (mesh_index, mesh) in meshes.iter().enumerate() {
        let (mesh_idx, origin_yup, rotation_yup) = match rotated_placements.get(&mesh_index) {
            Some(placement) => {
                let template = &meshes[placement.template_mesh_index];
                let idx = *template_lookup
                    .entry(placement.template_mesh_index)
                    .or_insert_with(|| {
                        let idx = unique_meshes.len() as u32;
                        unique_meshes.push(template);
                        idx
                    });
                (idx, zup_to_yup_f64(placement.origin_zup), rotation_zup_to_yup(&placement.rotation_zup))
            }
            None => {
                let geo_key = MeshGeometryKey {
                    positions_hash: hash_f32_slice(&mesh.positions),
                    indices_hash: hash_u32_slice(&mesh.indices),
                };
                let idx = *mesh_lookup.entry(geo_key).or_insert_with(|| {
                    let idx = unique_meshes.len() as u32;
                    unique_meshes.push(mesh);
                    idx
                });
                (idx, zup_to_yup_f64(mesh.origin), IDENTITY_ROTATION)
            }
        };

        // Get or create material index
        let mat_key = MaterialKey::from_color(&mesh.color);
        let material_idx = *material_lookup.entry(mat_key).or_insert_with(|| {
            let idx = unique_materials.len() as u32;
            unique_materials.push(mat_key);
            idx
        });

        // Record instance. Origin is emitted in the same Z-up→Y-up frame as the
        // vertices (X stays, new Y = old Z, new Z = -old Y) so the client
        // reconstructs world = origin + R * template_position in Y-up.
        instance_entity_ids.push(mesh.express_id);
        instance_ifc_types.push(&mesh.ifc_type);
        instance_mesh_indices.push(mesh_idx);
        instance_material_indices.push(material_idx);
        instance_origin_x.push(origin_yup[0]);
        instance_origin_y.push(origin_yup[1]);
        instance_origin_z.push(origin_yup[2]);
        instance_geometry_class.push(mesh.geometry_class);
        instance_geometry_item_ids.push(mesh.geometry_item_id.unwrap_or(ABSENT_SOURCE_ID));
        instance_material_ids.push(mesh.material_id.unwrap_or(ABSENT_SOURCE_ID));
        emitted_non_identity_rotation |= rotation_yup != IDENTITY_ROTATION;
        for (col, value) in instance_rotation.iter_mut().zip(rotation_yup.iter()) {
            col.push(*value);
        }
    }

    // Phase 2: Build vertex and index buffers from unique meshes
    let total_vertices: usize = unique_meshes.iter().map(|m| m.positions.len() / 3).sum();
    let total_indices: usize = unique_meshes.iter().map(|m| m.indices.len()).sum();

    // Quantized vertex data
    let mut vertex_x: Vec<i32> = Vec::with_capacity(total_vertices);
    let mut vertex_y: Vec<i32> = Vec::with_capacity(total_vertices);
    let mut vertex_z: Vec<i32> = Vec::with_capacity(total_vertices);

    // Optional normals (as floats, since normals don't benefit from quantization)
    let normals_capacity = if include_normals { total_vertices } else { 0 };
    let mut normal_x: Vec<f32> = Vec::with_capacity(normals_capacity);
    let mut normal_y: Vec<f32> = Vec::with_capacity(normals_capacity);
    let mut normal_z: Vec<f32> = Vec::with_capacity(normals_capacity);

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

        // Quantize and store vertices in the Y-up wire frame (services::axis),
        // server-side so the client needs no per-vertex loop.
        for i in 0..vert_count {
            let (x, y, z) = zup_to_yup(
                mesh.positions[i * 3],
                mesh.positions[i * 3 + 1],
                mesh.positions[i * 3 + 2],
            );
            vertex_x.push(quantize_position(x));
            vertex_y.push(quantize_position(y));
            vertex_z.push(quantize_position(z));

            if include_normals {
                if mesh_has_normals {
                    let (x, y, z) = zup_to_yup(
                        mesh.normals[i * 3],
                        mesh.normals[i * 3 + 1],
                        mesh.normals[i * 3 + 2],
                    );
                    normal_x.push(x);
                    normal_y.push(y);
                    normal_z.push(z);
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

    // A v2-shaped payload carries no rotation columns (`optimized_wire_version`).
    let rotation_column_count = if emitted_non_identity_rotation { 9 } else { 0 };
    let instance_schema = instance_schema(emitted_non_identity_rotation);

    let instance_columns: Vec<Arc<dyn arrow::array::Array>> = vec![
        Arc::new(UInt32Array::from(instance_entity_ids)) as Arc<dyn arrow::array::Array>,
        Arc::new(StringArray::from(instance_ifc_types)),
        Arc::new(UInt32Array::from(instance_mesh_indices)),
        Arc::new(UInt32Array::from(instance_material_indices)),
        Arc::new(Float64Array::from(instance_origin_x)),
        Arc::new(Float64Array::from(instance_origin_y)),
        Arc::new(Float64Array::from(instance_origin_z)),
        Arc::new(UInt8Array::from(instance_geometry_class)),
        Arc::new(UInt32Array::from(instance_geometry_item_ids)),
        Arc::new(UInt32Array::from(instance_material_ids)),
    ]
    .into_iter()
    .chain(instance_rotation.into_iter().take(rotation_column_count).map(|col| Arc::new(Float32Array::from(col)) as Arc<dyn arrow::array::Array>))
    .collect();

    let instance_batch = RecordBatch::try_new(instance_schema, instance_columns)?;

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
            Arc::new(UInt8Array::from(unique_materials.iter().map(|m| m.r).collect::<Vec<_>>())),
            Arc::new(UInt8Array::from(unique_materials.iter().map(|m| m.g).collect::<Vec<_>>())),
            Arc::new(UInt8Array::from(unique_materials.iter().map(|m| m.b).collect::<Vec<_>>())),
            Arc::new(UInt8Array::from(unique_materials.iter().map(|m| m.a).collect::<Vec<_>>())),
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
    let instance_parquet = write_parquet_buffer(&instance_batch)?;
    let mesh_parquet = write_parquet_buffer(&mesh_batch)?;
    let material_parquet = write_parquet_buffer(&material_batch)?;
    let vertex_parquet = write_parquet_buffer(&vertex_batch)?;
    let index_parquet = write_parquet_buffer(&index_batch)?;

    let data = assemble_optimized_output(
        optimized_wire_version(emitted_non_identity_rotation),
        include_normals,
        &instance_parquet,
        &mesh_parquet,
        &material_parquet,
        &vertex_parquet,
        &index_parquet,
    )?;
    Ok((data, unique_meshes.len(), unique_materials.len()))
}

/// Validate the five optimized-writer section lengths against the u32 wire
/// limit. Takes plain lengths, not byte slices, so a >4 GiB test case is just
/// the number `u32::MAX as usize + 1` — no multi-gigabyte buffer needed.
fn check_optimized_section_lengths(
    instance_len: usize, mesh_len: usize, material_len: usize, vertex_len: usize, index_len: usize,
) -> Result<(), ParquetError> {
    let sections = [
        ("instance", instance_len), ("mesh", mesh_len), ("material", material_len),
        ("vertex", vertex_len), ("index", index_len),
    ];
    for (name, len) in sections {
        check_u32_len(name, len)?;
    }
    Ok(())
}

/// Header: `[version:u8][flags:u8][instance_len:u32][mesh_len:u32][material_len:u32][vertex_len:u32][index_len:u32]`
/// Then: `[instance_parquet][mesh_parquet][material_parquet][vertex_parquet][index_parquet]`
///
/// Each section length is a wire-format u32: fail loud via
/// `check_optimized_section_lengths` instead of silently truncating a >4 GiB
/// section into a corrupt length prefix that disagrees with the bytes
/// appended below. Mirrors the guard `parquet::frame_sections`/
/// `frame_combined_sections` apply to the non-optimized writer's sections.
fn assemble_optimized_output(
    version: u8,
    include_normals: bool,
    instance_parquet: &[u8],
    mesh_parquet: &[u8],
    material_parquet: &[u8],
    vertex_parquet: &[u8],
    index_parquet: &[u8],
) -> Result<Bytes, ParquetError> {
    check_optimized_section_lengths(
        instance_parquet.len(),
        mesh_parquet.len(),
        material_parquet.len(),
        vertex_parquet.len(),
        index_parquet.len(),
    )?;

    let mut output = Vec::with_capacity(
        2 + 20 + instance_parquet.len() + mesh_parquet.len() + material_parquet.len()
            + vertex_parquet.len() + index_parquet.len(),
    );

    output.push(version);
    // Flags: bit 0 = has_normals
    output.push(if include_normals { 1u8 } else { 0u8 });

    output.extend_from_slice(&(instance_parquet.len() as u32).to_le_bytes());
    output.extend_from_slice(&(mesh_parquet.len() as u32).to_le_bytes());
    output.extend_from_slice(&(material_parquet.len() as u32).to_le_bytes());
    output.extend_from_slice(&(vertex_parquet.len() as u32).to_le_bytes());
    output.extend_from_slice(&(index_parquet.len() as u32).to_le_bytes());

    output.extend_from_slice(instance_parquet);
    output.extend_from_slice(mesh_parquet);
    output.extend_from_slice(material_parquet);
    output.extend_from_slice(vertex_parquet);
    output.extend_from_slice(index_parquet);

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
    let (data, unique_mesh_count, unique_material_count) =
        serialize_to_parquet_optimized(meshes, include_normals)?;

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
#[path = "parquet_optimized_tests.rs"]
mod optimized_tests;
