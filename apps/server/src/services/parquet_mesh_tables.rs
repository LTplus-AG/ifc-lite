// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The flat transport's three Arrow tables, and the SHAPE PLAN that decides
//! which mesh row draws which block of vertex/index rows.
//!
//! Split out of `parquet.rs`, which keeps the wire framing and the writers.
//! The seam is the plan: everything above it decides what to emit, everything
//! below it packs columns. `-parquet-v5` was the case where that decision is
//! the identity (row `i` owns block `i`); `-parquet-v6` (issue #3888) adds the
//! case where several rows share one block and a per-row rotation places each
//! of them.

use crate::services::axis::{zup_to_yup, zup_to_yup_f64};
use crate::services::parquet::ParquetError;
use crate::services::parquet_instancing::{
    collate_rotation_aware_placements, rotation_zup_to_yup, IDENTITY_ROTATION,
};
use crate::services::parquet_schema::{
    index_schema, mesh_schema, vertex_schema, MeshRow, RowPlacement, ABSENT_SOURCE_ID,
};
use crate::types::MeshData;
use arrow::array::{Float32Array, Float64Array, StringArray, UInt8Array, UInt32Array};
use arrow::record_batch::RecordBatch;
use rayon::prelude::*;
use rustc_hash::FxHashMap;
use std::sync::Arc;

/// One mesh row's placement against the emitted shape blocks.
pub(super) struct PlannedRow {
    /// Index into [`ShapePlan::Shared::shapes`], NOT into the mesh slice: the
    /// block of vertex/index rows this mesh row points at. Several rows share
    /// one slot.
    shape_slot: usize,
    /// Y-up metres. `world = origin + R * p`.
    origin_yup: [f64; 3],
    /// Row-major 3x3, Y-up.
    rotation: [f32; 9],
}

/// Which shapes get their vertices written, and how each mesh row reaches one.
///
/// `Identity` carries NO data on purpose. Its plan is a function of the mesh
/// index alone (row `i` owns block `i`, placed by its own origin with no
/// rotation), so materializing it would allocate ~80 bytes per mesh — on every
/// streamed batch, for a writer that never shares anything — to store `i` and
/// nine repeated constants.
pub(super) enum ShapePlan {
    /// The `-parquet-v5` layout: every mesh writes its own geometry. What the
    /// streaming cache writer and the per-batch stream blobs use — sharing
    /// there would be batch-local (issue #3888 scopes it to the non-streaming
    /// route).
    Identity,
    /// The `-parquet-v6` layout.
    Shared {
        /// Mesh indices whose vertex/index data is emitted, in emission order.
        shapes: Vec<usize>,
        /// One entry per input mesh, parallel to the mesh slice.
        rows: Vec<PlannedRow>,
    },
}

impl ShapePlan {
    /// Plan the `-parquet-v6` layout: occurrences of one `IfcMappedItem` /
    /// `IfcRepresentationMap` shape at different placements collapse onto the
    /// template's single block of vertices, each row carrying the verified
    /// origin + rotation that puts it back where it belongs.
    ///
    /// Reuses [`collate_rotation_aware_placements`] verbatim — the same
    /// grouping, the same per-vertex residual check, the same all-or-nothing
    /// per group — so the flat route can never share a shape the `/optimized`
    /// route would have refused to share.
    ///
    /// Returns [`ShapePlan::Identity`] when that collation found nothing to
    /// share, so a model with no repeats emits the v5 layout through the same
    /// path it always did rather than through a Shared plan that happens to be
    /// one-to-one.
    pub(super) fn shared_shapes(meshes: &[MeshData]) -> Self {
        let placements = collate_rotation_aware_placements(meshes);
        if placements.is_empty() {
            return Self::Identity;
        }
        let mut shapes: Vec<usize> = Vec::with_capacity(meshes.len());
        let mut slot_of: FxHashMap<usize, usize> = FxHashMap::default();
        let mut rows: Vec<PlannedRow> = Vec::with_capacity(meshes.len());
        for (i, mesh) in meshes.iter().enumerate() {
            // The template is itself an occurrence of its own group, so it
            // takes the shared branch too; keying `slot_of` by mesh index in
            // BOTH branches means a template can never also be emitted a
            // second time as its own unshared shape.
            let (shape_mesh, origin_yup, rotation) = match placements.get(&i) {
                Some(placement) => (
                    placement.template_mesh_index,
                    zup_to_yup_f64(placement.origin_zup),
                    rotation_zup_to_yup(&placement.rotation_zup),
                ),
                None => (i, zup_to_yup_f64(mesh.origin), IDENTITY_ROTATION),
            };
            let shape_slot = *slot_of.entry(shape_mesh).or_insert_with(|| {
                let slot = shapes.len();
                shapes.push(shape_mesh);
                slot
            });
            rows.push(PlannedRow {
                shape_slot,
                origin_yup,
                rotation,
            });
        }
        Self::Shared { shapes, rows }
    }

    /// The meshes whose geometry is emitted, in emission order. One entry per
    /// input mesh under `Identity`; one per distinct shape under `Shared`.
    fn shape_meshes<'a>(&self, meshes: &'a [MeshData]) -> Vec<&'a MeshData> {
        match self {
            Self::Identity => meshes.iter().collect(),
            Self::Shared { shapes, .. } => shapes.iter().map(|&i| &meshes[i]).collect(),
        }
    }

    /// Mesh row `i`'s slot in [`Self::shape_meshes`] and the placement that
    /// maps that slot's geometry onto this occurrence.
    ///
    /// Computed rather than stored under `Identity`: the answer there is `i`,
    /// the mesh's own swapped origin, and the identity rotation.
    fn row(&self, meshes: &[MeshData], i: usize) -> (usize, [f64; 3], [f32; 9]) {
        match self {
            Self::Identity => (i, zup_to_yup_f64(meshes[i].origin), IDENTITY_ROTATION),
            Self::Shared { rows, .. } => {
                let row = &rows[i];
                (row.shape_slot, row.origin_yup, row.rotation)
            }
        }
    }

    /// How many mesh geometries this plan emits.
    #[cfg(test)]
    pub(super) fn shape_count(&self, meshes: &[MeshData]) -> usize {
        match self {
            Self::Identity => meshes.len(),
            Self::Shared { shapes, .. } => shapes.len(),
        }
    }
}

/// Build the three Arrow tables (mesh metadata / vertices / indices) for a
/// slice of meshes under `plan`. `base_vertex_offset` / `base_index_offset`
/// seed the mesh-table `vertex_start` / `index_start` columns so an
/// incremental caller (the streaming cache writer) emits GLOBAL whole-model
/// offsets while the per-batch client blobs keep batch-local ones (bases 0/0).
/// The Z-up to Y-up transform lives here, in one place, for both paths.
pub(super) fn build_mesh_tables(
    meshes: &[MeshData],
    plan: &ShapePlan,
    base_vertex_offset: u32,
    base_index_offset: u32,
) -> Result<(RecordBatch, RecordBatch, RecordBatch), ParquetError> {
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
            let (slot, origin, rotation) = plan.row(meshes, i);
            MeshRow::new(
                &meshes[i],
                shape_meshes[slot],
                RowPlacement {
                    v_start: shape_vertex_start[slot],
                    i_start: shape_index_start[slot],
                    origin,
                    rotation,
                },
            )
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
    for column in rotation {
        mesh_columns.push(Arc::new(Float32Array::from(column)));
    }
    let mesh_batch = RecordBatch::try_new(mesh_schema(), mesh_columns)?;

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

/// One shape's six Y-up vertex columns, in `vertex_schema()` order:
/// `(x, y, z, nx, ny, nz)`. Named rather than left as a bare 6-tuple because
/// every slot has the same type and the positional pairing with the schema is
/// what keeps positions out of the normal columns.
type VertexColumns = (Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>);

fn shape_vertices(mesh: &MeshData) -> VertexColumns {
    let vert_count = mesh.positions.len() / 3;
    let mut px = Vec::with_capacity(vert_count);
    let mut py = Vec::with_capacity(vert_count);
    let mut pz = Vec::with_capacity(vert_count);
    let mut nx = Vec::with_capacity(vert_count);
    let mut ny = Vec::with_capacity(vert_count);
    let mut nz = Vec::with_capacity(vert_count);

    // Some IFC pipelines (e.g. advanced_brep) yield meshes with positions but
    // no normals. The schema requires non-null normal columns, so pad with
    // zeros and let the client recompute them from positions.
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
        let (x, y, z) = zup_to_yup(
            mesh.positions[i * 3],
            mesh.positions[i * 3 + 1],
            mesh.positions[i * 3 + 2],
        );
        px.push(x);
        py.push(y);
        pz.push(z);

        if has_normals {
            let (x, y, z) = zup_to_yup(
                mesh.normals[i * 3],
                mesh.normals[i * 3 + 1],
                mesh.normals[i * 3 + 2],
            );
            nx.push(x);
            ny.push(y);
            nz.push(z);
        } else {
            nx.push(0.0);
            ny.push(0.0);
            nz.push(0.0);
        }
    }
    (px, py, pz, nx, ny, nz)
}

// The unit tests live in the ratchet-exempt sibling file
// `parquet_mesh_tables_tests.rs`.
#[cfg(test)]
#[path = "parquet_mesh_tables_tests.rs"]
mod parquet_mesh_tables_tests;
