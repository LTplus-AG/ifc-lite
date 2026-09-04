// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `parquet_mesh_tables.rs` — the `-parquet-v6` shape plan
//! (issue #3888). Split into this ratchet-exempt sibling file, the same
//! pattern as `parquet_tests.rs` and `parquet_optimized_tests.rs`.

use super::*;
use crate::services::parquet::{
    serialize_to_parquet, serialize_to_parquet_shared_shapes, StreamingParquetCacheWriter,
};
use arrow::array::{Float32Array, Float64Array, UInt32Array};
use bytes::Bytes;
use ifc_lite_geometry::InstanceMeta;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

/// Row-major mat4 (Z-up, `InstanceMeta::transform` convention): rotate `deg`
/// about Z, then translate by `t`.
fn rot_z_mat4(deg: f64, t: [f64; 3]) -> [f64; 16] {
    let rad = deg.to_radians();
    let (s, c) = (rad.sin(), rad.cos());
    #[rustfmt::skip]
    let m = [
        c,  -s, 0.0, t[0],
        s,   c, 0.0, t[1],
        0.0, 0.0, 1.0, t[2],
        0.0, 0.0, 0.0, 1.0,
    ];
    m
}

/// Bake a canonical (source-coords) triangle through a row-major mat4.
fn bake_triangle(canonical: &[[f64; 3]; 3], m: &[f64; 16]) -> Vec<f32> {
    let r = [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]];
    let t = [m[3], m[7], m[11]];
    let mut out = Vec::with_capacity(9);
    for p in canonical {
        for (row, t_i) in r.iter().zip(t.iter()) {
            out.push((row[0] * p[0] + row[1] * p[1] + row[2] * p[2] + t_i) as f32);
        }
    }
    out
}

const CANON_TRIANGLE: [[f64; 3]; 3] = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];

/// Three occurrences of one `IfcMappedItem` shape at 0/90/180 degrees about Z.
fn rotated_repeats() -> Vec<MeshData> {
    [
        rot_z_mat4(0.0, [0.0, 0.0, 0.0]),
        rot_z_mat4(90.0, [5.0, 0.0, 0.0]),
        rot_z_mat4(180.0, [0.0, 5.0, 0.0]),
    ]
    .iter()
    .enumerate()
    .map(|(i, m)| {
        MeshData::new(
            100 + i as u32,
            "IfcFurniture".to_string(),
            bake_triangle(&CANON_TRIANGLE, m),
            vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
            vec![0, 1, 2],
            [0.6, 0.4, 0.2, 1.0],
        )
        .with_instance(Some(InstanceMeta {
            transform: *m,
            local_transform: None,
            canonical_transform: None,
            rep_identity: 777,
            instanceable: true,
        }))
    })
    .collect()
}

/// Unframe `[mesh_len][mesh][vertex_len][vertex][index_len][index]` and read
/// the mesh + vertex tables back.
fn read_flat_tables(blob: &Bytes) -> (arrow::record_batch::RecordBatch, arrow::record_batch::RecordBatch) {
    let batch = |bytes: Bytes| {
        ParquetRecordBatchReaderBuilder::try_new(bytes)
            .unwrap()
            .build()
            .unwrap()
            .map(|b| b.unwrap())
            .next()
            .unwrap()
    };
    let mesh_len = u32::from_le_bytes(blob[0..4].try_into().unwrap()) as usize;
    let mesh_bytes = Bytes::copy_from_slice(&blob[4..4 + mesh_len]);
    let vertex_at = 4 + mesh_len;
    let vertex_len =
        u32::from_le_bytes(blob[vertex_at..vertex_at + 4].try_into().unwrap()) as usize;
    let vertex_bytes = Bytes::copy_from_slice(&blob[vertex_at + 4..vertex_at + 4 + vertex_len]);
    (batch(mesh_bytes), batch(vertex_bytes))
}

fn u32col(batch: &arrow::record_batch::RecordBatch, name: &str) -> UInt32Array {
    batch
        .column(batch.schema().index_of(name).expect(name))
        .as_any()
        .downcast_ref::<UInt32Array>()
        .unwrap()
        .clone()
}

fn f32col(batch: &arrow::record_batch::RecordBatch, name: &str) -> Float32Array {
    batch
        .column(batch.schema().index_of(name).expect(name))
        .as_any()
        .downcast_ref::<Float32Array>()
        .unwrap()
        .clone()
}

fn f64col(batch: &arrow::record_batch::RecordBatch, name: &str) -> Float64Array {
    batch
        .column(batch.schema().index_of(name).expect(name))
        .as_any()
        .downcast_ref::<Float64Array>()
        .unwrap()
        .clone()
}

/// RED/GREEN for issue #3888, mirroring `/optimized`'s
/// `rotated_mapped_item_repeats_dedup_and_reconstruct_correctly`.
///
/// Three rotated occurrences of one shape must (a) point at ONE shared block
/// of vertices — the same `vertex_start` on all three rows, one shape's worth
/// of vertex rows in the table — and (b) reconstruct to each occurrence's
/// ORIGINAL world position through `world = origin + R * p`, within 1 mm.
///
/// Both halves are needed and neither implies the other: sharing without a
/// correct rotation draws all three occurrences on top of each other (the
/// "N slabs collapse to one" shape of #1841), and a correct rotation without
/// sharing is v5 with nine wasted columns.
#[test]
fn rotated_repeats_share_one_vertex_block_and_reconstruct_within_1mm() {
    let meshes = rotated_repeats();
    // Ground truth: the baked positions ARE the Z-up world here (origin is
    // [0,0,0]), so the expected Y-up world is that, swapped.
    let expected_yup: Vec<Vec<[f32; 3]>> = meshes
        .iter()
        .map(|m| {
            (0..3)
                .map(|v| {
                    let (x, y, z) = crate::services::axis::zup_to_yup(
                        m.positions[v * 3],
                        m.positions[v * 3 + 1],
                        m.positions[v * 3 + 2],
                    );
                    [x, y, z]
                })
                .collect()
        })
        .collect();

    let blob = serialize_to_parquet_shared_shapes(&meshes).unwrap();
    let (mesh_batch, vertex_batch) = read_flat_tables(&blob);

    assert_eq!(mesh_batch.num_rows(), 3, "every occurrence keeps its own row");
    let vertex_starts = u32col(&mesh_batch, "vertex_start");
    let vertex_counts = u32col(&mesh_batch, "vertex_count");
    assert_eq!(
        vertex_starts.values(),
        &[0, 0, 0],
        "three occurrences of one shape must point at ONE shared vertex block"
    );
    assert_eq!(vertex_counts.values(), &[3, 3, 3]);
    assert_eq!(
        vertex_batch.num_rows(),
        3,
        "only the template's three vertices may be written, not 3 x 3"
    );

    let (ox, oy, oz) = (
        f64col(&mesh_batch, "origin_x"),
        f64col(&mesh_batch, "origin_y"),
        f64col(&mesh_batch, "origin_z"),
    );
    let rot: Vec<Float32Array> = (0..9).map(|i| f32col(&mesh_batch, &format!("rot{i}"))).collect();
    let (vx, vy, vz) = (
        f32col(&vertex_batch, "x"),
        f32col(&vertex_batch, "y"),
        f32col(&vertex_batch, "z"),
    );

    for (i, expected) in expected_yup.iter().enumerate() {
        let origin = [ox.value(i), oy.value(i), oz.value(i)];
        let r: Vec<f64> = (0..9).map(|k| rot[k].value(i) as f64).collect();
        for (v, want) in expected.iter().enumerate() {
            let start = vertex_starts.value(i) as usize + v;
            let p = [
                vx.value(start) as f64,
                vy.value(start) as f64,
                vz.value(start) as f64,
            ];
            let world = [
                origin[0] + r[0] * p[0] + r[1] * p[1] + r[2] * p[2],
                origin[1] + r[3] * p[0] + r[4] * p[1] + r[5] * p[2],
                origin[2] + r[6] * p[0] + r[7] * p[1] + r[8] * p[2],
            ];
            for axis in 0..3 {
                assert!(
                    (world[axis] - want[axis] as f64).abs() < 1e-3,
                    "occurrence {i} vertex {v} axis {axis}: reconstructed {} vs original {}",
                    world[axis],
                    want[axis]
                );
            }
        }
    }
}

/// A model with nothing to share must come out byte-for-byte as `-parquet-v5`
/// did, apart from the nine identity rotation columns.
///
/// Compared against the identity plan rather than against a hand-written
/// expectation: the identity plan IS the v5 layout (`serialize_to_parquet`,
/// which the streaming route still calls, is built on it), so this asserts the
/// two agree on every other column rather than restating what they should say.
#[test]
fn zero_reuse_model_matches_the_v5_layout_with_identity_rotations() {
    // Distinct shapes, distinct origins, no `InstanceMeta` -> nothing to share.
    let meshes: Vec<MeshData> = (0..4u32)
        .map(|i| {
            let x = i as f32;
            MeshData::new(
                i + 1,
                "IfcWall".to_string(),
                vec![x, 0.0, 0.0, x + 1.0, 0.0, 0.0, x + 1.0, 1.0, 0.0],
                vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
                vec![0, 1, 2],
                [0.5, 0.5, 0.5, 1.0],
            )
            .with_origin([i as f64, 2.0 * i as f64, 3.0])
        })
        .collect();

    let plan = ShapePlan::shared_shapes(&meshes);
    assert_eq!(
        plan.shape_count(),
        meshes.len(),
        "nothing is shareable here, so every mesh must emit its own geometry"
    );

    let v5 = serialize_to_parquet(&meshes).unwrap();
    let v6 = serialize_to_parquet_shared_shapes(&meshes).unwrap();
    assert_eq!(
        v5, v6,
        "with no shape to share the v6 writer must produce the identity-plan bytes"
    );

    let (mesh_batch, _) = read_flat_tables(&v6);
    let rot: Vec<Float32Array> = (0..9).map(|i| f32col(&mesh_batch, &format!("rot{i}"))).collect();
    let identity = [1.0f32, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    for row in 0..mesh_batch.num_rows() {
        for (k, want) in identity.iter().enumerate() {
            assert_eq!(
                rot[k].value(row),
                *want,
                "row {row} rot{k} must be identity on an unshared row"
            );
        }
    }
}

/// The streaming writer keeps the v5 (identity) plan: sharing there could only
/// ever be batch-local, and #3888 scopes the first change to the non-streaming
/// route. Pinned because the two writers now differ only by which plan they
/// pass, which is one argument away from silently changing the streamed wire.
#[test]
fn the_streaming_writer_does_not_share_shapes() {
    let meshes = rotated_repeats();
    let mut writer = StreamingParquetCacheWriter::new().unwrap();
    writer.append(&meshes).unwrap();
    let blob = writer.finish().unwrap();
    let (mesh_batch, vertex_batch) = read_flat_tables(&blob);
    assert_eq!(
        u32col(&mesh_batch, "vertex_start").values(),
        &[0, 3, 6],
        "the streamed layout must stay one block per mesh"
    );
    assert_eq!(vertex_batch.num_rows(), 9);
}

/// Size ratchet on a real model (issue #3888 asks for 2.4x-4.3x on models with
/// repeats). Asserts the v6 blob is at most 40% of the v5 one — a ceiling, so
/// it fails if sharing stops working, not if it improves.
///
/// The fixture is not in the repo; a missing one SKIPS with a message rather
/// than passing quietly, the same shape as `beam_winding_consistency`.
#[test]
fn v6_is_at_most_40_percent_of_v5_on_a_real_model() {
    const FIXTURE: &str = "../../tests/models/ara3d/S_Office_Integrated Design Archi.ifc";
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(FIXTURE);
    let content = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "skipping parquet v6 size ratchet: fixture missing at {} — run \
                 `node scripts/fixtures/fetch-fixtures.mjs \"ara3d/S_Office_Integrated Design Archi.ifc\"`",
                path.display()
            );
            return;
        }
        Err(e) => panic!("failed to read fixture {}: {e}", path.display()),
    };

    let result = ifc_lite_processing::process_geometry_filtered_with_quality(
        &content,
        crate::services::OpeningFilterMode::default(),
        ifc_lite_processing::TessellationQuality::default(),
    );
    assert!(
        !result.meshes.is_empty(),
        "the fixture produced no meshes; the ratio below would be meaningless"
    );

    let v5 = serialize_to_parquet(&result.meshes).unwrap().len();
    let v6 = serialize_to_parquet_shared_shapes(&result.meshes).unwrap().len();
    let ratio = v6 as f64 / v5 as f64;
    eprintln!("MEASURED v5={v5} v6={v6} ratio={ratio:.4}");
    assert!(
        ratio <= 0.40,
        "v6 must be at most 40% of the flat v5 blob on this model: v5={v5} v6={v6} ratio={ratio:.3}"
    );
}
