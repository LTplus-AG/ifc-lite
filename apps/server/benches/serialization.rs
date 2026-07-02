// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Benchmark comparing serialization formats for mesh geometry data.
//!
//! Compares:
//! 1. JSON (serde_json) - baseline
//! 2. Basic Parquet - columnar format
//! 3. Optimized Parquet (ara3d BOS) - quantized, deduplicated, instanced
//!
//! Run with: cargo bench -p ifc-lite-server --bench serialization

// `criterion::black_box` is deprecated in favor of `std::hint::black_box`, but
// the pinned criterion version still exposes only its own re-export here.
#![allow(deprecated)]

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};

// We need to access the server's internal modules
// Since this is a binary crate, we'll define the necessary types here

/// Mesh data structure (same as server's MeshData)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MeshData {
    pub express_id: u32,
    pub ifc_type: String,
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub indices: Vec<u32>,
    pub color: [f32; 4],
}

impl MeshData {
    pub fn new(
        express_id: u32,
        ifc_type: String,
        positions: Vec<f32>,
        normals: Vec<f32>,
        indices: Vec<u32>,
        color: [f32; 4],
    ) -> Self {
        Self {
            express_id,
            ifc_type,
            positions,
            normals,
            indices,
            color,
        }
    }
}

/// Generate synthetic mesh data for benchmarking.
fn generate_meshes(
    mesh_count: usize,
    vertices_per_mesh: usize,
    duplicate_ratio: f32,
) -> Vec<MeshData> {
    let mut meshes = Vec::with_capacity(mesh_count);
    let unique_count = (mesh_count as f32 * (1.0 - duplicate_ratio)) as usize;
    let unique_count = unique_count.max(1);

    // Create unique base meshes
    let mut base_meshes: Vec<MeshData> = Vec::with_capacity(unique_count);
    for i in 0..unique_count {
        let positions: Vec<f32> = (0..vertices_per_mesh * 3)
            .map(|j| ((i * 1000 + j) as f32) * 0.001)
            .collect();
        let normals: Vec<f32> = (0..vertices_per_mesh * 3)
            .map(|j| if j % 3 == 2 { 1.0 } else { 0.0 })
            .collect();
        let triangles = vertices_per_mesh / 3;
        let indices: Vec<u32> = (0..triangles * 3)
            .map(|j| (j % vertices_per_mesh) as u32)
            .collect();

        base_meshes.push(MeshData::new(
            i as u32,
            format!("IfcWall_{}", i % 10),
            positions,
            normals,
            indices,
            [0.8, 0.8, 0.8, 1.0],
        ));
    }

    // Generate meshes with duplicates
    for i in 0..mesh_count {
        let base_idx = i % unique_count;
        let mut mesh = base_meshes[base_idx].clone();
        mesh.express_id = i as u32;
        meshes.push(mesh);
    }

    meshes
}

/// JSON serialization (baseline)
fn serialize_json(meshes: &[MeshData]) -> Vec<u8> {
    serde_json::to_vec(meshes).unwrap()
}

/// Basic Parquet serialization
fn serialize_parquet_basic(meshes: &[MeshData]) -> Vec<u8> {
    use arrow::array::{Float32Array, StringArray, UInt32Array};
    use arrow::datatypes::{DataType, Field, Schema};
    use arrow::record_batch::RecordBatch;
    use parquet::arrow::ArrowWriter;
    use parquet::basic::Compression;
    use parquet::file::properties::WriterProperties;
    use std::io::Cursor;
    use std::sync::Arc;

    let total_vertices: usize = meshes.iter().map(|m| m.positions.len() / 3).sum();
    let total_triangles: usize = meshes.iter().map(|m| m.indices.len() / 3).sum();
    let mesh_count = meshes.len();

    // Mesh metadata
    let mut express_ids = Vec::with_capacity(mesh_count);
    let mut ifc_types = Vec::with_capacity(mesh_count);
    let mut vertex_starts = Vec::with_capacity(mesh_count);
    let mut vertex_counts = Vec::with_capacity(mesh_count);
    let mut index_starts = Vec::with_capacity(mesh_count);
    let mut index_counts = Vec::with_capacity(mesh_count);
    let mut color_r = Vec::with_capacity(mesh_count);
    let mut color_g = Vec::with_capacity(mesh_count);
    let mut color_b = Vec::with_capacity(mesh_count);
    let mut color_a = Vec::with_capacity(mesh_count);

    // Vertex data
    let mut pos_x = Vec::with_capacity(total_vertices);
    let mut pos_y = Vec::with_capacity(total_vertices);
    let mut pos_z = Vec::with_capacity(total_vertices);
    let mut norm_x = Vec::with_capacity(total_vertices);
    let mut norm_y = Vec::with_capacity(total_vertices);
    let mut norm_z = Vec::with_capacity(total_vertices);

    // Index data
    let mut idx_0 = Vec::with_capacity(total_triangles);
    let mut idx_1 = Vec::with_capacity(total_triangles);
    let mut idx_2 = Vec::with_capacity(total_triangles);

    let mut vertex_offset: u32 = 0;
    let mut index_offset: u32 = 0;

    for mesh in meshes {
        let vert_count = mesh.positions.len() / 3;
        let tri_count = mesh.indices.len() / 3;

        express_ids.push(mesh.express_id);
        ifc_types.push(mesh.ifc_type.as_str());
        vertex_starts.push(vertex_offset);
        vertex_counts.push(vert_count as u32);
        index_starts.push(index_offset);
        index_counts.push(mesh.indices.len() as u32);
        color_r.push(mesh.color[0]);
        color_g.push(mesh.color[1]);
        color_b.push(mesh.color[2]);
        color_a.push(mesh.color[3]);

        for i in 0..vert_count {
            pos_x.push(mesh.positions[i * 3]);
            pos_y.push(mesh.positions[i * 3 + 1]);
            pos_z.push(mesh.positions[i * 3 + 2]);
            norm_x.push(mesh.normals[i * 3]);
            norm_y.push(mesh.normals[i * 3 + 1]);
            norm_z.push(mesh.normals[i * 3 + 2]);
        }

        for i in 0..tri_count {
            idx_0.push(mesh.indices[i * 3]);
            idx_1.push(mesh.indices[i * 3 + 1]);
            idx_2.push(mesh.indices[i * 3 + 2]);
        }

        vertex_offset += vert_count as u32;
        index_offset += mesh.indices.len() as u32;
    }

    // Create schemas
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
    )
    .unwrap();

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
    )
    .unwrap();

    let index_batch = RecordBatch::try_new(
        index_schema.clone(),
        vec![
            Arc::new(UInt32Array::from(idx_0)),
            Arc::new(UInt32Array::from(idx_1)),
            Arc::new(UInt32Array::from(idx_2)),
        ],
    )
    .unwrap();

    let mut output = Vec::new();

    // Write each table
    for batch in [&mesh_batch, &vertex_batch, &index_batch] {
        let mut buffer = Vec::new();
        let cursor = Cursor::new(&mut buffer);
        let props = WriterProperties::builder()
            .set_compression(Compression::ZSTD(Default::default()))
            .set_dictionary_enabled(true)
            .build();
        let mut writer = ArrowWriter::try_new(cursor, batch.schema(), Some(props)).unwrap();
        writer.write(batch).unwrap();
        writer.close().unwrap();

        output.extend_from_slice(&(buffer.len() as u32).to_le_bytes());
        output.extend_from_slice(&buffer);
    }

    output
}

/// Optimized Parquet serialization (ara3d BOS format)
fn serialize_parquet_optimized(meshes: &[MeshData]) -> Vec<u8> {
    use arrow::array::{Int32Array, StringArray, UInt32Array, UInt8Array};
    use arrow::datatypes::{DataType, Field, Schema};
    use arrow::record_batch::RecordBatch;
    use parquet::arrow::ArrowWriter;
    use parquet::basic::Compression;
    use parquet::file::properties::WriterProperties;
    use std::collections::HashMap;
    use std::hash::{Hash, Hasher};
    use std::io::Cursor;
    use std::sync::Arc;

    const VERTEX_MULTIPLIER: f32 = 10_000.0;

    // Hash helpers
    fn hash_f32_slice(data: &[f32]) -> u64 {
        use std::collections::hash_map::DefaultHasher;
        let mut hasher = DefaultHasher::new();
        for item in data {
            item.to_bits().hash(&mut hasher);
        }
        hasher.finish()
    }

    fn hash_u32_slice(data: &[u32]) -> u64 {
        use std::collections::hash_map::DefaultHasher;
        let mut hasher = DefaultHasher::new();
        for item in data {
            item.hash(&mut hasher);
        }
        hasher.finish()
    }

    #[inline]
    fn quantize_position(value: f32) -> i32 {
        (value * VERTEX_MULTIPLIER).round() as i32
    }

    #[inline]
    fn color_to_byte(value: f32) -> u8 {
        (value.clamp(0.0, 1.0) * 255.0).round() as u8
    }

    #[derive(Clone, Copy, PartialEq, Eq, Hash)]
    struct MaterialKey {
        r: u8,
        g: u8,
        b: u8,
        a: u8,
    }

    // Deduplicate meshes and materials
    let mut unique_meshes: Vec<&MeshData> = Vec::new();
    let mut mesh_lookup: HashMap<(u64, u64), u32> = HashMap::new();
    let mut unique_materials: Vec<MaterialKey> = Vec::new();
    let mut material_lookup: HashMap<MaterialKey, u32> = HashMap::new();

    let mut instance_entity_ids: Vec<u32> = Vec::with_capacity(meshes.len());
    let mut instance_ifc_types: Vec<&str> = Vec::with_capacity(meshes.len());
    let mut instance_mesh_indices: Vec<u32> = Vec::with_capacity(meshes.len());
    let mut instance_material_indices: Vec<u32> = Vec::with_capacity(meshes.len());

    for mesh in meshes {
        let positions_hash = hash_f32_slice(&mesh.positions);
        let indices_hash = hash_u32_slice(&mesh.indices);
        let geo_key = (positions_hash, indices_hash);

        let mesh_idx = *mesh_lookup.entry(geo_key).or_insert_with(|| {
            let idx = unique_meshes.len() as u32;
            unique_meshes.push(mesh);
            idx
        });

        let mat_key = MaterialKey {
            r: color_to_byte(mesh.color[0]),
            g: color_to_byte(mesh.color[1]),
            b: color_to_byte(mesh.color[2]),
            a: color_to_byte(mesh.color[3]),
        };
        let material_idx = *material_lookup.entry(mat_key).or_insert_with(|| {
            let idx = unique_materials.len() as u32;
            unique_materials.push(mat_key);
            idx
        });

        instance_entity_ids.push(mesh.express_id);
        instance_ifc_types.push(&mesh.ifc_type);
        instance_mesh_indices.push(mesh_idx);
        instance_material_indices.push(material_idx);
    }

    // Build vertex and index buffers
    let total_vertices: usize = unique_meshes.iter().map(|m| m.positions.len() / 3).sum();
    let total_indices: usize = unique_meshes.iter().map(|m| m.indices.len()).sum();

    let mut vertex_x: Vec<i32> = Vec::with_capacity(total_vertices);
    let mut vertex_y: Vec<i32> = Vec::with_capacity(total_vertices);
    let mut vertex_z: Vec<i32> = Vec::with_capacity(total_vertices);
    let mut indices: Vec<u32> = Vec::with_capacity(total_indices);

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

        for i in 0..vert_count {
            vertex_x.push(quantize_position(mesh.positions[i * 3]));
            vertex_y.push(quantize_position(mesh.positions[i * 3 + 1]));
            vertex_z.push(quantize_position(mesh.positions[i * 3 + 2]));
        }

        indices.extend_from_slice(&mesh.indices);

        vertex_offset += vert_count as u32;
        index_offset += mesh.indices.len() as u32;
    }

    // Create schemas
    let instance_schema = Arc::new(Schema::new(vec![
        Field::new("entity_id", DataType::UInt32, false),
        Field::new("ifc_type", DataType::Utf8, false),
        Field::new("mesh_index", DataType::UInt32, false),
        Field::new("material_index", DataType::UInt32, false),
    ]));

    let mesh_schema = Arc::new(Schema::new(vec![
        Field::new("vertex_offset", DataType::UInt32, false),
        Field::new("vertex_count", DataType::UInt32, false),
        Field::new("index_offset", DataType::UInt32, false),
        Field::new("index_count", DataType::UInt32, false),
    ]));

    let material_schema = Arc::new(Schema::new(vec![
        Field::new("r", DataType::UInt8, false),
        Field::new("g", DataType::UInt8, false),
        Field::new("b", DataType::UInt8, false),
        Field::new("a", DataType::UInt8, false),
    ]));

    let vertex_schema = Arc::new(Schema::new(vec![
        Field::new("x", DataType::Int32, false),
        Field::new("y", DataType::Int32, false),
        Field::new("z", DataType::Int32, false),
    ]));

    let index_schema = Arc::new(Schema::new(vec![Field::new("i", DataType::UInt32, false)]));

    let instance_batch = RecordBatch::try_new(
        instance_schema,
        vec![
            Arc::new(UInt32Array::from(instance_entity_ids)),
            Arc::new(StringArray::from(instance_ifc_types)),
            Arc::new(UInt32Array::from(instance_mesh_indices)),
            Arc::new(UInt32Array::from(instance_material_indices)),
        ],
    )
    .unwrap();

    let mesh_batch = RecordBatch::try_new(
        mesh_schema,
        vec![
            Arc::new(UInt32Array::from(mesh_vertex_offsets)),
            Arc::new(UInt32Array::from(mesh_vertex_counts)),
            Arc::new(UInt32Array::from(mesh_index_offsets)),
            Arc::new(UInt32Array::from(mesh_index_counts)),
        ],
    )
    .unwrap();

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
    )
    .unwrap();

    let vertex_batch = RecordBatch::try_new(
        vertex_schema,
        vec![
            Arc::new(Int32Array::from(vertex_x)),
            Arc::new(Int32Array::from(vertex_y)),
            Arc::new(Int32Array::from(vertex_z)),
        ],
    )
    .unwrap();

    let index_batch =
        RecordBatch::try_new(index_schema, vec![Arc::new(UInt32Array::from(indices))]).unwrap();

    // Write output
    let mut output = Vec::new();
    output.push(2u8); // version
    output.push(0u8); // flags (no normals)

    let batches = [
        &instance_batch,
        &mesh_batch,
        &material_batch,
        &vertex_batch,
        &index_batch,
    ];
    let mut lengths = Vec::new();

    for batch in &batches {
        let mut buffer = Vec::new();
        let cursor = Cursor::new(&mut buffer);
        let props = WriterProperties::builder()
            .set_compression(Compression::ZSTD(Default::default()))
            .set_dictionary_enabled(true)
            .build();
        let mut writer = ArrowWriter::try_new(cursor, batch.schema(), Some(props)).unwrap();
        writer.write(batch).unwrap();
        writer.close().unwrap();
        lengths.push(buffer);
    }

    // Write lengths first
    for buf in &lengths {
        output.extend_from_slice(&(buf.len() as u32).to_le_bytes());
    }
    // Then data
    for buf in lengths {
        output.extend_from_slice(&buf);
    }

    output
}

fn bench_serialization(c: &mut Criterion) {
    let mut group = c.benchmark_group("serialization");

    // Test different scenarios
    let scenarios = [
        // (meshes, vertices_per_mesh, duplicate_ratio, name)
        (100, 100, 0.0, "100_meshes_no_dup"),
        (100, 100, 0.8, "100_meshes_80%_dup"),
        (1000, 100, 0.0, "1k_meshes_no_dup"),
        (1000, 100, 0.8, "1k_meshes_80%_dup"),
        (1000, 500, 0.0, "1k_meshes_500v_no_dup"),
        (1000, 500, 0.8, "1k_meshes_500v_80%_dup"),
        (10000, 100, 0.0, "10k_meshes_no_dup"),
        (10000, 100, 0.9, "10k_meshes_90%_dup"),
    ];

    for (mesh_count, vertices_per_mesh, dup_ratio, name) in scenarios {
        let meshes = generate_meshes(mesh_count, vertices_per_mesh, dup_ratio);
        let total_vertices: usize = meshes.iter().map(|m| m.positions.len() / 3).sum();

        group.throughput(Throughput::Elements(total_vertices as u64));

        group.bench_with_input(BenchmarkId::new("json", name), &meshes, |b, meshes| {
            b.iter(|| serialize_json(black_box(meshes)))
        });

        group.bench_with_input(
            BenchmarkId::new("parquet_basic", name),
            &meshes,
            |b, meshes| b.iter(|| serialize_parquet_basic(black_box(meshes))),
        );

        group.bench_with_input(
            BenchmarkId::new("parquet_optimized", name),
            &meshes,
            |b, meshes| b.iter(|| serialize_parquet_optimized(black_box(meshes))),
        );
    }

    group.finish();
}

fn bench_output_size(_c: &mut Criterion) {
    // Report sizes (not a real benchmark, but useful for comparison)
    println!("\n╔════════════════════════════════════════════════════════════════════════════╗");
    println!("║                    SERIALIZATION OUTPUT SIZE COMPARISON                   ║");
    println!("╠════════════════════════════════════════════════════════════════════════════╣");
    println!(
        "║ {:30} │ {:10} │ {:10} │ {:10} │ {:6} ║",
        "Scenario", "JSON", "Parquet", "Optimized", "Ratio"
    );
    println!("╠════════════════════════════════════════════════════════════════════════════╣");

    let scenarios = [
        (100, 100, 0.0, "100 meshes, no dup"),
        (100, 100, 0.8, "100 meshes, 80% dup"),
        (1000, 100, 0.0, "1k meshes, no dup"),
        (1000, 100, 0.8, "1k meshes, 80% dup"),
        (1000, 500, 0.0, "1k meshes, 500v, no dup"),
        (1000, 500, 0.8, "1k meshes, 500v, 80% dup"),
        (10000, 100, 0.0, "10k meshes, no dup"),
        (10000, 100, 0.9, "10k meshes, 90% dup"),
    ];

    for (mesh_count, vertices_per_mesh, dup_ratio, name) in scenarios {
        let meshes = generate_meshes(mesh_count, vertices_per_mesh, dup_ratio);

        let json_size = serialize_json(&meshes).len();
        let parquet_size = serialize_parquet_basic(&meshes).len();
        let optimized_size = serialize_parquet_optimized(&meshes).len();

        let ratio = json_size as f64 / optimized_size as f64;

        println!(
            "║ {:30} │ {:>10} │ {:>10} │ {:>10} │ {:>5.1}x ║",
            name,
            format_size(json_size),
            format_size(parquet_size),
            format_size(optimized_size),
            ratio
        );
    }

    println!("╚════════════════════════════════════════════════════════════════════════════╝\n");
}

fn format_size(bytes: usize) -> String {
    if bytes >= 1_000_000 {
        format!("{:.1} MB", bytes as f64 / 1_000_000.0)
    } else if bytes >= 1_000 {
        format!("{:.1} KB", bytes as f64 / 1_000.0)
    } else {
        format!("{} B", bytes)
    }
}

criterion_group!(benches, bench_output_size, bench_serialization);
criterion_main!(benches);
