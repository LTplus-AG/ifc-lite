// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5984: the finish columns on both Parquet transports. `metallic` and
//! `roughness` per mesh row (flat, both layouts) and per instance row
//! (optimized), NaN where unauthored and never null, an authored `0` kept.

use super::parquet::{serialize_to_parquet, serialize_to_parquet_shared_shapes};
use super::parquet_optimized::serialize_to_parquet_optimized_with_stats;
use crate::types::MeshData;
use arrow::array::{Array, Float32Array};
use arrow::record_batch::RecordBatch;
use bytes::Bytes;
use ifc_lite_processing::style::SpecularMaterial;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

/// Three meshes at distinct positions (so nothing dedups into another): a
/// glass with an authored roughness of exactly 0, a metal with no roughness,
/// and one with no finish at all.
fn meshes() -> Vec<MeshData> {
    let tri = |eid: u32, x: f32, finish: Option<SpecularMaterial>| {
        let mesh = ifc_lite_processing::MeshData::new(
            eid,
            "IfcWall".to_string(),
            vec![x, 0.0, 0.0, x + 1.0, 0.0, 0.0, x + 1.0, 1.0, 0.0],
            vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
            vec![0, 1, 2],
            [0.5, 0.5, 0.5, 1.0],
        );
        MeshData::with_finish(mesh, finish)
    };
    vec![
        tri(10, 0.0, Some(SpecularMaterial { metallic: None, roughness: Some(0.0) })),
        tri(11, 5.0, Some(SpecularMaterial { metallic: Some(1.0), roughness: None })),
        tri(12, 9.0, None),
    ]
}

fn read(bytes: Bytes) -> RecordBatch {
    let batches: Vec<RecordBatch> = ParquetRecordBatchReaderBuilder::try_new(bytes)
        .unwrap()
        .build()
        .unwrap()
        .map(|b| b.unwrap())
        .collect();
    arrow::compute::concat_batches(&batches[0].schema(), &batches).unwrap()
}

/// The standard transport's first section is the mesh table (length-prefixed).
fn flat_mesh_table(blob: &[u8]) -> RecordBatch {
    let len = u32::from_le_bytes(blob[0..4].try_into().unwrap()) as usize;
    read(Bytes::copy_from_slice(&blob[4..4 + len]))
}

fn optimized_instance_table(data: &[u8]) -> RecordBatch {
    let len = u32::from_le_bytes(data[2..6].try_into().unwrap()) as usize;
    let header = 2 + 5 * 4;
    read(Bytes::copy_from_slice(&data[header..header + len]))
}

fn assert_finish_columns(table: &RecordBatch, what: &str) {
    let col = |name: &str| {
        let array = table.column(table.schema().index_of(name).unwrap_or_else(|_| panic!("{what}: no {name}")));
        assert_eq!(array.null_count(), 0, "{what}: {name} must not be nullable (parquet-wasm leaks nulls)");
        array.as_any().downcast_ref::<Float32Array>().unwrap().clone()
    };
    let (metallic, roughness) = (col("metallic"), col("roughness"));
    assert_eq!(roughness.value(0), 0.0, "{what}: an authored 0 is a value");
    assert!(metallic.value(0).is_nan(), "{what}: unauthored metallic is NaN");
    assert_eq!(metallic.value(1), 1.0, "{what}");
    assert!(roughness.value(1).is_nan(), "{what}");
    assert!(metallic.value(2).is_nan() && roughness.value(2).is_nan(), "{what}: no finish at all");
}

#[test]
fn flat_parquet_carries_the_finish_in_both_layouts() {
    assert_finish_columns(&flat_mesh_table(&serialize_to_parquet(&meshes()).unwrap()), "flat");
    assert_finish_columns(&flat_mesh_table(&serialize_to_parquet_shared_shapes(&meshes()).unwrap()), "shared-shapes");
}

#[test]
fn optimized_parquet_carries_the_finish_per_instance() {
    let (data, _) = serialize_to_parquet_optimized_with_stats(&meshes(), false, None).unwrap();
    assert_finish_columns(&optimized_instance_table(&data), "optimized");
}

#[test]
fn json_mesh_omits_an_absent_finish_and_keeps_an_authored_zero() {
    let [glass, metal, plain]: [MeshData; 3] = meshes().try_into().unwrap();
    let glass = serde_json::to_value(&glass).unwrap();
    assert_eq!(glass["roughness"], 0.0);
    assert!(glass.get("metallic").is_none());
    assert_eq!(serde_json::to_value(&metal).unwrap()["metallic"], 1.0);
    let plain_json = serde_json::to_value(&plain).unwrap();
    assert!(plain_json.get("metallic").is_none() && plain_json.get("roughness").is_none());
    // Unchanged wire for a mesh without a finish: the processing mesh's own JSON.
    assert_eq!(plain_json, serde_json::to_value(&plain.mesh).unwrap());
    // And it reads back, finish included (the JSON cache replays this).
    let back: MeshData = serde_json::from_value(glass).unwrap();
    assert_eq!((back.metallic, back.roughness), (None, Some(0.0)));
}
