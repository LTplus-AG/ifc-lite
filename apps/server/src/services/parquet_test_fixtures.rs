// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Fixtures and readers shared by the Parquet test modules.
//!
//! ONE definition of the rotated-repeat fixture, because two of the tests using
//! it assert the same claim about different writers: `/optimized` dedups three
//! rotated occurrences of one shape (#3575) and the flat `-parquet-v6` route
//! shares them (#3888), and "the flat route shares exactly what the optimized
//! route shares" only means something while both are handed the same meshes.
//! Two copies of `bake_triangle` that drifted would leave both tests green and
//! the claim untested.

use crate::services::axis::zup_to_yup;
use crate::types::MeshData;
use arrow::array::{Array, RecordBatch};
use bytes::Bytes;
use ifc_lite_geometry::InstanceMeta;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

/// Row-major mat4 (Z-up, `InstanceMeta::transform` convention): rotate `deg`
/// about Z, then translate by `t`.
pub(super) fn rot_z_mat4(deg: f64, t: [f64; 3]) -> [f64; 16] {
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
pub(super) fn bake_triangle(canonical: &[[f64; 3]; 3], m: &[f64; 16]) -> Vec<f32> {
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

pub(super) const CANON_TRIANGLE: [[f64; 3]; 3] =
    [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];

/// Three occurrences of one `IfcMappedItem` shape at 0/90/180 degrees about Z
/// — the "furniture, pipe runs, repeated structural members" case #3575 and
/// #3888 both report.
pub(super) fn rotated_repeats() -> Vec<MeshData> {
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

/// Each occurrence's ORIGINAL vertex positions in the Y-up wire frame — the
/// ground truth a reconstruction is checked against. The fixture bakes the
/// placement into the positions with a zero origin, so the expected world
/// position IS those positions, swapped.
pub(super) fn expected_yup(meshes: &[MeshData]) -> Vec<Vec<[f32; 3]>> {
    meshes
        .iter()
        .map(|m| {
            (0..m.positions.len() / 3)
                .map(|v| {
                    let (x, y, z) =
                        zup_to_yup(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]);
                    [x, y, z]
                })
                .collect()
        })
        .collect()
}

/// Decode one `[len][mesh][len][vertex][len][index]` blob into its three
/// tables, each with ALL its row groups concatenated.
///
/// Concatenated, not `.next()`: a writer that emits one row group per batch
/// (`StreamingParquetCacheWriter`) puts the second batch's rows in the second
/// group, and a reader taking only the first would assert against a prefix of
/// the table while reporting success.
pub(super) fn read_flat_sections(blob: &[u8]) -> Vec<RecordBatch> {
    let mut out = Vec::new();
    let mut off = 0usize;
    for _ in 0..3 {
        let len = u32::from_le_bytes(blob[off..off + 4].try_into().unwrap()) as usize;
        off += 4;
        let section = Bytes::copy_from_slice(&blob[off..off + len]);
        off += len;
        let batches: Vec<RecordBatch> = ParquetRecordBatchReaderBuilder::try_new(section)
            .unwrap()
            .build()
            .unwrap()
            .map(|b| b.unwrap())
            .collect();
        let schema = batches[0].schema();
        out.push(arrow::compute::concat_batches(&schema, &batches).unwrap());
    }
    assert_eq!(off, blob.len(), "trailing bytes after the three sections");
    out
}

/// One typed column of a batch, by name. One generic instead of the
/// `u32col`/`f32col`/`f64col` trio each test module was growing its own copy of.
pub(super) fn col<A: Array + Clone + 'static>(batch: &RecordBatch, name: &str) -> A {
    batch
        .column(batch.schema().index_of(name).expect(name))
        .as_any()
        .downcast_ref::<A>()
        .unwrap_or_else(|| panic!("column {name} is not the expected array type"))
        .clone()
}
