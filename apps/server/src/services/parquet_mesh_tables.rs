// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The flat transport's three Arrow tables, packed from a SHAPE PLAN
//! (`parquet_shape_plan.rs`) that decides which mesh row draws which block of
//! vertex/index rows.
//!
//! Split out of `parquet.rs`, which keeps the wire framing and the writers.
//! The seam is the plan: above it decides what to emit, below it packs
//! columns. The default layout is the case where that decision is the identity
//! (row `i` owns block `i`); `shared-shapes` (#3888) adds the case where
//! several rows share one block and a per-row rotation places each of them,
//! and the cross-batch stream (#5407) the case where that block was written by
//! an earlier batch.

use crate::services::parquet::ParquetError;
use crate::services::parquet_layout::ParquetLayout;
use crate::services::parquet_shape_plan::{ShapePlan, ShapeRef};
use crate::services::parquet_vertex_columns::{shape_vertices, VertexColumns};
use crate::services::parquet_schema::{
    index_schema, mesh_schema, vertex_schema, MeshRow, RowPlacement, ABSENT_SOURCE_ID,
};
use crate::types::MeshData;
use arrow::array::{Float32Array, Float64Array, StringArray, UInt8Array, UInt32Array};
use arrow::record_batch::RecordBatch;
use rayon::prelude::*;
use std::sync::Arc;

/// Build the three Arrow tables (mesh metadata / vertices / indices) for a
/// slice of meshes under `plan`. `base_vertex_offset` / `base_index_offset`
/// seed the mesh-table `vertex_start` / `index_start` columns so an
/// incremental caller (the streaming cache writer) emits GLOBAL whole-model
/// offsets while the per-batch client blobs keep batch-local ones (bases 0/0).
/// The Z-up to Y-up transform lives here, in one place, for both paths.
pub(super) fn build_mesh_tables(
    meshes: &[MeshData],
    plan: &ShapePlan,
    layout: ParquetLayout,
    base_vertex_offset: u32,
    base_index_offset: u32,
) -> Result<(RecordBatch, RecordBatch, RecordBatch), ParquetError> {
    // A `Shared` plan indexes the exact slice it was planned from, and nothing
    // in the signature ties the two together: a plan applied to a different
    // slice reads as plausible geometry, not as a failure.
    debug_assert!(
        plan.row_count().is_none_or(|n| n == meshes.len()),
        "shape plan was built from a different mesh slice"
    );
    let shape_meshes = plan.shape_meshes(meshes);
    let total_vertices: usize = shape_meshes.iter().map(|m| m.positions.len() / 3).sum();
    let total_triangles: usize = shape_meshes.iter().map(|m| m.indices.len() / 3).sum();
    let mesh_count = meshes.len();

    // Phase 1: cumulative offsets over the EMITTED shapes (must be sequential).
    let mut shape_vertex_start = Vec::with_capacity(shape_meshes.len());
    let mut shape_index_start = Vec::with_capacity(shape_meshes.len());
    let mut vertex_offset: u32 = base_vertex_offset;
    let mut index_offset: u32 = base_index_offset;
    for shape in &shape_meshes {
        shape_vertex_start.push(vertex_offset);
        shape_index_start.push(index_offset);
        vertex_offset += (shape.positions.len() / 3) as u32;
        index_offset += shape.indices.len() as u32;
    }

    // Phase 2: extract mesh metadata in parallel.
    let metadata: Vec<MeshRow<'_>> = (0..mesh_count)
        .into_par_iter()
        .map(|i| {
            let (shape, origin, rotation) = plan.row(meshes, i);
            let placement = match shape {
                ShapeRef::Slot(slot) => RowPlacement {
                    v_start: shape_vertex_start[slot],
                    vert_count: (shape_meshes[slot].positions.len() / 3) as u32,
                    i_start: shape_index_start[slot],
                    index_count: shape_meshes[slot].indices.len() as u32,
                    origin,
                    rotation,
                },
                // Written by an earlier stream batch (#5407): its range is
                // already whole-stream, so it is carried through untouched.
                ShapeRef::Emitted(emitted) => RowPlacement {
                    v_start: emitted.vertex_start,
                    vert_count: emitted.vertex_count,
                    i_start: emitted.index_start,
                    index_count: emitted.index_count,
                    origin,
                    rotation,
                },
            };
            MeshRow::new(&meshes[i], placement)
        })
        .collect();

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
    let mut origin_x = Vec::with_capacity(mesh_count);
    let mut origin_y = Vec::with_capacity(mesh_count);
    let mut origin_z = Vec::with_capacity(mesh_count);
    let mut geometry_class = Vec::with_capacity(mesh_count);
    let mut geometry_item_ids: Vec<u32> = Vec::with_capacity(mesh_count);
    let mut material_ids: Vec<u32> = Vec::with_capacity(mesh_count);
    let mut rotation: [Vec<f32>; 9] = std::array::from_fn(|_| Vec::with_capacity(mesh_count));

    for m in metadata {
        express_ids.push(m.express_id);
        ifc_types.push(m.ifc_type);
        vertex_starts.push(m.v_start);
        vertex_counts.push(m.vert_count);
        index_starts.push(m.i_start);
        index_counts.push(m.index_count);
        color_r.push(m.color[0]);
        color_g.push(m.color[1]);
        color_b.push(m.color[2]);
        color_a.push(m.color[3]);
        origin_x.push(m.origin[0]);
        origin_y.push(m.origin[1]);
        origin_z.push(m.origin[2]);
        geometry_class.push(m.geometry_class);
        geometry_item_ids.push(m.geometry_item_id.unwrap_or(ABSENT_SOURCE_ID));
        material_ids.push(m.material_id.unwrap_or(ABSENT_SOURCE_ID));
        for (column, value) in rotation.iter_mut().zip(m.rotation.iter()) {
            column.push(*value);
        }
    }

    // Phase 3: vertex and index data, in parallel over the EMITTED shapes.
    // The Z-up to Y-up transform is applied server-side so no client repeats
    // it per vertex (IFC is Z-up, WebGL is Y-up: new Y = old Z, new Z = -old Y).
    let vertex_data: Vec<VertexColumns> =
        shape_meshes.par_iter().map(|mesh| shape_vertices(mesh)).collect();

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

    let index_data: Vec<(Vec<u32>, Vec<u32>, Vec<u32>)> = shape_meshes
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

    let mut idx_0 = Vec::with_capacity(total_triangles);
    let mut idx_1 = Vec::with_capacity(total_triangles);
    let mut idx_2 = Vec::with_capacity(total_triangles);
    for (i0, i1, i2) in index_data {
        idx_0.extend(i0);
        idx_1.extend(i1);
        idx_2.extend(i2);
    }

    let mut mesh_columns: Vec<arrow::array::ArrayRef> = vec![
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
        Arc::new(Float64Array::from(origin_x)),
        Arc::new(Float64Array::from(origin_y)),
        Arc::new(Float64Array::from(origin_z)),
        Arc::new(UInt8Array::from(geometry_class)),
        Arc::new(UInt32Array::from(geometry_item_ids)),
        Arc::new(UInt32Array::from(material_ids)),
    ];
    if layout.has_rotation() {
        for column in rotation {
            mesh_columns.push(Arc::new(Float32Array::from(column)));
        }
    }
    let mesh_batch = RecordBatch::try_new(mesh_schema(layout.has_rotation()), mesh_columns)?;

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

// The unit tests live in the ratchet-exempt sibling file
// `parquet_mesh_tables_tests.rs`.
#[cfg(test)]
#[path = "parquet_mesh_tables_tests.rs"]
mod parquet_mesh_tables_tests;
