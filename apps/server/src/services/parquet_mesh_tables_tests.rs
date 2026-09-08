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
use crate::services::ParquetLayout;
use crate::services::parquet_test_fixtures::{
    col, expected_yup, read_flat_sections, rotated_repeats,
};
use arrow::array::{Float32Array, Float64Array, RecordBatch, UInt32Array};

/// The nine `rot0..rot8` columns of a mesh table, in order.
fn rotation_columns(batch: &RecordBatch) -> Vec<Float32Array> {
    (0..9).map(|i| col::<Float32Array>(batch, &format!("rot{i}"))).collect()
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
    let expected = expected_yup(&meshes);

    let blob = serialize_to_parquet_shared_shapes(&meshes).unwrap();
    let sections = read_flat_sections(&blob);
    let (mesh_batch, vertex_batch) = (&sections[0], &sections[1]);

    assert_eq!(mesh_batch.num_rows(), 3, "every occurrence keeps its own row");
    let vertex_starts = col::<UInt32Array>(mesh_batch, "vertex_start");
    let vertex_counts = col::<UInt32Array>(mesh_batch, "vertex_count");
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
        col::<Float64Array>(mesh_batch, "origin_x"),
        col::<Float64Array>(mesh_batch, "origin_y"),
        col::<Float64Array>(mesh_batch, "origin_z"),
    );
    let rot = rotation_columns(mesh_batch);
    let (vx, vy, vz) = (
        col::<Float32Array>(vertex_batch, "x"),
        col::<Float32Array>(vertex_batch, "y"),
        col::<Float32Array>(vertex_batch, "z"),
    );

    for (i, expected) in expected.iter().enumerate() {
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

/// A model with nothing to share must produce the v5 layout, and the v6 blob
/// for the same model must differ from it ONLY by the identity rotation
/// columns.
///
/// Two claims, and the second is what the opt-in rests on. The default request
/// must be byte-identical to what this route emitted before #3888 (asserted by
/// comparing against the same `serialize_to_parquet` the streaming route still
/// calls), and the opt-in request on a repeat-free model must carry the same
/// vertex layout with nine identity columns bolted on — not a reordered or
/// re-planned table that merely happens to render the same.
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
        plan.shape_count(&meshes),
        meshes.len(),
        "nothing is shareable here, so every mesh must emit its own geometry"
    );

    let v5 = serialize_to_parquet(&meshes).unwrap();
    let v6 = serialize_to_parquet_shared_shapes(&meshes).unwrap();

    let v5_tables = read_flat_sections(&v5);
    let v6_tables = read_flat_sections(&v6);
    // Vertex and index tables must be untouched: nothing was shared, so no
    // block moved.
    assert_eq!(v5_tables[1], v6_tables[1], "vertex table must be unchanged");
    assert_eq!(v5_tables[2], v6_tables[2], "index table must be unchanged");

    // The v5 mesh table must carry NO rotation columns at all — that is what
    // makes a default request decode on a client that predates #3888.
    let v5_names: Vec<String> = v5_tables[0]
        .schema()
        .fields()
        .iter()
        .map(|f| f.name().clone())
        .collect();
    assert!(
        !v5_names.iter().any(|n| n.starts_with("rot")),
        "the default layout must not emit rotation columns: {v5_names:?}"
    );

    // ...and the v6 mesh table must be that same table plus nine columns.
    let v6_names: Vec<String> = v6_tables[0]
        .schema()
        .fields()
        .iter()
        .map(|f| f.name().clone())
        .collect();
    assert_eq!(v6_names[..v5_names.len()], v5_names[..]);
    assert_eq!(v6_names.len(), v5_names.len() + 9);
    for (i, column) in v5_tables[0].columns().iter().enumerate() {
        assert_eq!(column, v6_tables[0].column(i), "column {} diverged", v5_names[i]);
    }

    let rot = rotation_columns(&v6_tables[0]);
    let identity = [1.0f32, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    for row in 0..v6_tables[0].num_rows() {
        for (k, want) in identity.iter().enumerate() {
            assert_eq!(
                rot[k].value(row),
                *want,
                "row {row} rot{k} must be identity on an unshared row"
            );
        }
    }
}

/// The opt-in, end to end on the bytes (issue #3888).
///
/// The SAME meshes — a model that DOES have shareable repeats, so the two
/// layouts genuinely diverge — serialized under each layout. Without the
/// signal: no rotation columns, no sharing, byte-identical to the pre-#3888
/// output. With it: rotation columns and one shared block.
///
/// The fixture matters. Run against a repeat-free model this test would pass
/// with the sharing code deleted, because both layouts would emit one block per
/// mesh and only the columns would differ.
#[test]
fn the_layout_signal_decides_sharing_and_the_rotation_columns() {
    let meshes = rotated_repeats();

    let default_blob = serialize_to_parquet(&meshes).unwrap();
    let opted_blob = serialize_to_parquet_shared_shapes(&meshes).unwrap();

    let default_mesh = &read_flat_sections(&default_blob)[0];
    let default_names: Vec<String> = default_mesh
        .schema()
        .fields()
        .iter()
        .map(|f| f.name().clone())
        .collect();
    assert!(
        !default_names.iter().any(|n| n.starts_with("rot")),
        "a request without the signal must get no rotation columns: {default_names:?}"
    );
    assert_eq!(
        col::<UInt32Array>(default_mesh, "vertex_start").values(),
        &[0, 3, 6],
        "a request without the signal must get one vertex block per mesh"
    );
    assert_eq!(read_flat_sections(&default_blob)[1].num_rows(), 9);

    let opted = read_flat_sections(&opted_blob);
    let opted_mesh = &opted[0];
    assert_eq!(
        rotation_columns(opted_mesh).len(),
        9,
        "a request with the signal must get the rotation columns"
    );
    assert_eq!(
        col::<UInt32Array>(opted_mesh, "vertex_start").values(),
        &[0, 0, 0],
        "a request with the signal must get the shared block"
    );
    assert_eq!(opted[1].num_rows(), 3);

    assert_ne!(
        default_blob, opted_blob,
        "the two layouts must not produce the same bytes on a model with repeats"
    );
}

/// The streaming writer honours the signal for the SCHEMA even though it can
/// never share: everything stored under the v6 key has to be a v6 payload, and
/// everything under v5 has to be free of the columns a pre-#3888 client would
/// not expect.
#[test]
fn the_streaming_writer_follows_the_layout_signal() {
    let meshes = rotated_repeats();
    for (layout, wants_rotation) in [
        (ParquetLayout::Flat, false),
        (ParquetLayout::SharedShapes, true),
    ] {
        let mut writer = StreamingParquetCacheWriter::new(layout).unwrap();
        writer.append(&meshes).unwrap();
        let sections = read_flat_sections(&writer.finish().unwrap());
        let names: Vec<String> = sections[0]
            .schema()
            .fields()
            .iter()
            .map(|f| f.name().clone())
            .collect();
        assert_eq!(
            names.iter().any(|n| n.starts_with("rot")),
            wants_rotation,
            "{layout:?} produced the wrong mesh-table schema: {names:?}"
        );
        // Never shares, under either layout.
        assert_eq!(
            col::<UInt32Array>(&sections[0], "vertex_start").values(),
            &[0, 3, 6]
        );
    }
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
