// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `parquet_stream_shapes.rs`: cross-batch shape sharing on the
//! streaming route (#5407). The route-level counterpart, on a real IFC through
//! the real handler, is `routes/parse/parquet_stream_cross_batch_tests.rs`.

use super::*;
use crate::services::parquet_test_fixtures::{
    bake_triangle, col, expected_yup, rot_z_mat4, rotated_repeats, CANON_TRIANGLE,
};
use crate::services::ParquetLayout;
use arrow::array::{Float32Array, Float64Array, UInt32Array};

fn cross_batch() -> StreamShapePlanner {
    StreamShapePlanner::new(ParquetLayout::SharedShapes, StreamShapes::CrossBatch)
}

/// Plan `meshes` one per batch and reconstruct every row's world vertices the
/// way a cross-batch client does: batch `k`'s vertex table is appended to what
/// batches `0..k` sent, at the base the batch states.
fn stream_one_per_batch(planner: &mut StreamShapePlanner, meshes: &[MeshData]) -> (Vec<Vec<[f32; 3]>>, Vec<usize>) {
    let mut store: Vec<[f32; 3]> = Vec::new();
    let mut world = Vec::new();
    let mut vertex_rows = Vec::new();
    for mesh in meshes.chunks(1) {
        let batch = planner.plan(mesh, None).unwrap();
        assert_eq!(batch.vertex_base as usize, store.len(), "the base must be what was sent");
        let (x, y, z) = (
            col::<Float32Array>(&batch.vertex, "x"),
            col::<Float32Array>(&batch.vertex, "y"),
            col::<Float32Array>(&batch.vertex, "z"),
        );
        store.extend((0..batch.vertex.num_rows()).map(|i| [x.value(i), y.value(i), z.value(i)]));
        vertex_rows.push(batch.vertex.num_rows());
        let (starts, counts) = (
            col::<UInt32Array>(&batch.mesh, "vertex_start"),
            col::<UInt32Array>(&batch.mesh, "vertex_count"),
        );
        let origin = [
            col::<Float64Array>(&batch.mesh, "origin_x"),
            col::<Float64Array>(&batch.mesh, "origin_y"),
            col::<Float64Array>(&batch.mesh, "origin_z"),
        ];
        let rot: Vec<Float32Array> = (0..9).map(|i| col::<Float32Array>(&batch.mesh, &format!("rot{i}"))).collect();
        for row in 0..batch.mesh.num_rows() {
            let r: Vec<f64> = rot.iter().map(|c| c.value(row) as f64).collect();
            let o: Vec<f64> = origin.iter().map(|c| c.value(row)).collect();
            let start = starts.value(row) as usize;
            world.push(
                store[start..start + counts.value(row) as usize]
                    .iter()
                    .map(|p| {
                        let p = p.map(f64::from);
                        [
                            (o[0] + r[0] * p[0] + r[1] * p[1] + r[2] * p[2]) as f32,
                            (o[1] + r[3] * p[0] + r[4] * p[1] + r[5] * p[2]) as f32,
                            (o[2] + r[6] * p[0] + r[7] * p[1] + r[8] * p[2]) as f32,
                        ]
                    })
                    .collect(),
            );
        }
    }
    (world, vertex_rows)
}

fn assert_within_1mm(actual: &[Vec<[f32; 3]>], expected: &[Vec<[f32; 3]>]) {
    assert_eq!(actual.len(), expected.len());
    for (m, (a, e)) in actual.iter().zip(expected).enumerate() {
        assert_eq!(a.len(), e.len(), "mesh {m} vertex count");
        for (v, (a, e)) in a.iter().zip(e).enumerate() {
            for axis in 0..3 {
                assert!((a[axis] - e[axis]).abs() < 1e-3, "mesh {m} vertex {v} axis {axis}: {a:?} vs {e:?}");
            }
        }
    }
}

/// Stage 1 across batches: three rotated occurrences of one mapped shape, one
/// per batch. None is bit-identical to another, so only the retained template
/// can share them; the second and third batches must send no vertices at all
/// and still reconstruct to each occurrence's own geometry.
#[test]
fn rotated_repeats_in_later_batches_point_at_the_first_batchs_block() {
    let meshes = rotated_repeats();
    let (world, vertex_rows) = stream_one_per_batch(&mut cross_batch(), &meshes);
    assert_eq!(vertex_rows, [3, 0, 0], "one triangle for the whole stream");
    assert_within_1mm(&world, &expected_yup(&meshes));
}

/// The bound, and what happens at it. With no room for a template nothing is
/// carried across a batch boundary: each rotated occurrence ships its own
/// vertices again, exactly as the batch-local stream would, and every one of
/// them still reconstructs. Past the budget sharing degrades; correctness
/// does not.
#[test]
fn past_the_template_budget_repeats_are_resent_and_still_correct() {
    let meshes = rotated_repeats();
    let mut planner = cross_batch();
    planner.template_budget = 0;
    let (world, vertex_rows) = stream_one_per_batch(&mut planner, &meshes);
    assert_eq!(vertex_rows, [3, 3, 3]);
    assert_eq!(planner.retained_bytes, 0);
    assert_within_1mm(&world, &expected_yup(&meshes));
}

/// Stage 2 across batches: bit-identical (origin-relative) copies with NO
/// instancing metadata, which the collator never sees. The content-hash
/// registry alone must share them, placing each by its own origin.
#[test]
fn bit_identical_repeats_share_by_content_hash_across_batches() {
    let meshes: Vec<MeshData> = (0..3)
        .map(|i| {
            let mut mesh = MeshData::new(
                200 + i,
                "IfcColumn".to_string(),
                bake_triangle(&CANON_TRIANGLE, &rot_z_mat4(0.0, [0.0; 3])),
                vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
                vec![0, 1, 2],
                [0.5, 0.5, 0.5, 1.0],
            );
            mesh.origin = [4.0 * f64::from(i), 1.0, 0.0];
            mesh
        })
        .collect();
    let expected: Vec<Vec<[f32; 3]>> = meshes
        .iter()
        .map(|m| {
            (0..3)
                .map(|v| {
                    let (x, y, z) = crate::services::axis::zup_to_yup(
                        m.positions[v * 3] + m.origin[0] as f32,
                        m.positions[v * 3 + 1] + m.origin[1] as f32,
                        m.positions[v * 3 + 2] + m.origin[2] as f32,
                    );
                    [x, y, z]
                })
                .collect()
        })
        .collect();
    let (world, vertex_rows) = stream_one_per_batch(&mut cross_batch(), &meshes);
    assert_eq!(vertex_rows, [3, 0, 0]);
    assert_within_1mm(&world, &expected);
}

/// Without the opt-in the planner is the stream's historical identity writer:
/// nothing shared, every batch self-contained in content, bases advancing past
/// every mesh. This is what the cache writer runs for a batch-local stream.
#[test]
fn the_batch_local_planner_shares_nothing() {
    let meshes = rotated_repeats();
    let mut planner = StreamShapePlanner::new(ParquetLayout::SharedShapes, StreamShapes::BatchLocal);
    let (world, vertex_rows) = stream_one_per_batch(&mut planner, &meshes);
    assert_eq!(vertex_rows, [3, 3, 3]);
    assert_within_1mm(&world, &expected_yup(&meshes));
}

/// Parity with the buffered route on real models (#5407's acceptance): a
/// cross-batch stream, planning batch by batch with the pipeline's own batch
/// sizes, must ship no more vertex rows than `POST /parse/parquet` plans for
/// the whole model at once. One fixture without a site rotation and one WITH
/// one, where rotated sharing depends on the stream seeing the frame before
/// its first batch (#4118).
///
/// Fixtures are not in the repo; a missing one SKIPS with a message.
#[test]
fn a_cross_batch_stream_ships_no_more_vertices_than_the_buffered_route() {
    use crate::services::parquet_instancing::baked_basis_zup;
    for fixture in [
        "ara3d/S_Office_Integrated Design Archi.ifc",
        "ara3d/FM_ARC_DigitalHub.ifc",
    ] {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/models").join(fixture);
        let Ok(content) = std::fs::read(&path) else {
            eprintln!("skipping cross-batch parity on {fixture}: fixture missing — run `pnpm fixtures`");
            continue;
        };
        let basis_slot = std::sync::Arc::new(std::sync::OnceLock::new());
        let mut batches: Vec<Vec<MeshData>> = Vec::new();
        let result = ifc_lite_processing::process_geometry_streaming_filtered_with_options(
            &content,
            crate::services::OpeningFilterMode::default(),
            ifc_lite_processing::StreamingOptions {
                // The server's defaults (`INITIAL_BATCH_SIZE` / `MAX_BATCH_SIZE`).
                initial_batch_size: 100,
                throughput_batch_size: 1000,
                retain_emitted_meshes: false,
                baked_basis_out: Some(basis_slot.clone()),
                ..Default::default()
            },
            |meshes, _, _| {
                if !meshes.is_empty() {
                    batches.push(meshes.to_vec());
                }
            },
            |_| {},
            |_| {},
        );
        assert!(batches.len() > 1, "{fixture} must stream in several batches");

        let mut planner = cross_batch();
        let streamed: usize = batches
            .iter()
            .map(|batch| planner.plan(batch, basis_slot.get()).unwrap().vertex.num_rows())
            .sum();

        let all: Vec<MeshData> = batches.into_iter().flatten().collect();
        let basis = baked_basis_zup(
            Some(result.mesh_coordinate_space),
            result.site_transform.as_deref(),
            result.metadata.coordinate_info.origin_shift,
        );
        let plan = ShapePlan::shared_shapes(&all, Some(&basis));
        let buffered: usize = plan.shape_meshes(&all).iter().map(|m| m.positions.len() / 3).sum();
        let unshared: usize = all.iter().map(|m| m.positions.len() / 3).sum();

        eprintln!("{fixture}: unshared {unshared}, buffered {buffered}, cross-batch stream {streamed} vertex rows");
        assert!(buffered < unshared / 2, "{fixture} must be a model with repeats to share");
        assert!(
            streamed <= buffered,
            "{fixture}: the cross-batch stream shipped {streamed} vertex rows, the buffered route {buffered}"
        );
    }
}
