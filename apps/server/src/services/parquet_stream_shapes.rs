// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Whole-stream offsets for the streaming Parquet route, and the cross-batch
//! shape sharing that rides on them (#5407).
//!
//! A streamed model is written one batch at a time, so anything that has to
//! hold across batches lives here: the running vertex/index offsets every
//! batch's mesh table is based on, and, when the client opted in, where each
//! distinct shape already landed. The cache writer and the per-batch client
//! blob both consume a [`PlannedBatch`], so the two can never disagree about a
//! range.
//!
//! BOUNDED MEMORY. No occurrence outlives the batch that produced it. What
//! grows across batches is, per DISTINCT shape emitted so far, one
//! [`EmittedShape`] (16 bytes) plus its `MeshGeometryKey` (24 bytes), whatever
//! the size of that shape's geometry; and, per instanced representation, the
//! ONE template mesh its later occurrences are verified against, capped in
//! total at [`RETAINED_TEMPLATE_BUDGET_BYTES`]. Past the cap a representation
//! is simply not carried: its later occurrences are shared within their own
//! batch, or by content hash, instead. Sharing degrades; correctness and the
//! bound do not.

use crate::services::parquet::{frame_sections, write_parquet_buffer, ParquetError};
use crate::services::parquet_layout::{ParquetLayout, StreamShapes};
use crate::services::parquet_mesh_tables::build_mesh_tables;
use crate::services::parquet_shape_plan::{EmittedShape, PriorShapes, RetainedTemplate, ShapePlan};
use crate::types::MeshData;
use arrow::record_batch::RecordBatch;
use bytes::Bytes;

/// Ceiling on the template geometry a cross-batch stream retains (#5407).
///
/// Sized against what it buys, not what it costs a small model: the
/// representations that repeat across batches are the model's distinct
/// instanced shapes, whose geometry is what the shared stream sends ONCE
/// anyway. 256 MiB of raw template buffers is several times that on every
/// fixture measured for #5407, while staying well under one parse's working
/// set on the models a streaming deployment exists for.
pub(super) const RETAINED_TEMPLATE_BUDGET_BYTES: usize = 256 * 1024 * 1024;

/// One batch's mesh / vertex / index tables, planned against the whole stream.
pub struct PlannedBatch {
    pub(super) mesh: RecordBatch,
    pub(super) vertex: RecordBatch,
    pub(super) index: RecordBatch,
    /// Whole-stream offset of this batch's first vertex row.
    pub vertex_base: u32,
    /// Whole-stream offset of this batch's first index, in indices (three per
    /// index-table row), the unit of the mesh table's `index_start`.
    pub index_base: u32,
}

impl PlannedBatch {
    /// The batch as a client blob, in the same `[len][mesh][len][vert][len]
    /// [idx]` framing every batch event carries. Its offsets are whole-stream,
    /// so it is only meaningful to a client told `vertex_base` / `index_base`.
    pub fn encode(&self) -> Result<Bytes, ParquetError> {
        frame_sections(
            &write_parquet_buffer(&self.mesh)?,
            &write_parquet_buffer(&self.vertex)?,
            &write_parquet_buffer(&self.index)?,
        )
    }

    /// Mesh rows in this batch.
    pub fn mesh_count(&self) -> usize {
        self.mesh.num_rows()
    }
}

/// The running state behind a streamed model's whole-stream offsets.
pub struct StreamShapePlanner {
    layout: ParquetLayout,
    /// `None`: every mesh emits its own block, as the stream always did.
    /// `Some`: cross-batch sharing, against every shape emitted so far.
    prior: Option<PriorShapes>,
    /// Raw buffer bytes held by `prior`'s retained templates, and their cap.
    retained_bytes: usize,
    template_budget: usize,
    vertex_offset: u32,
    index_offset: u32,
}

impl StreamShapePlanner {
    /// A planner for `layout`. Sharing needs BOTH the shared-shapes layout and
    /// the client's cross-batch opt-in; the route rejects the opt-in on the
    /// flat layout, so ignoring it here is never what a caller sees.
    pub fn new(layout: ParquetLayout, stream_shapes: StreamShapes) -> Self {
        let sharing = layout.has_rotation() && stream_shapes == StreamShapes::CrossBatch;
        Self {
            layout,
            prior: sharing.then(PriorShapes::default),
            retained_bytes: 0,
            template_budget: RETAINED_TEMPLATE_BUDGET_BYTES,
            vertex_offset: 0,
            index_offset: 0,
        }
    }

    /// Plan the next batch and advance the whole-stream offsets past the
    /// shapes it emits. Fails loud, advancing nothing, when an offset would
    /// overflow the mesh table's `u32` columns: wrapping would decode as
    /// garbage, not as an error.
    ///
    /// `baked_basis` is the row-major `native_to_baked` of the frame the
    /// batch's vertices are in (`StreamEvent::Batch::baked_basis`); ignored
    /// unless the planner shares.
    pub fn plan(
        &mut self,
        meshes: &[MeshData],
        baked_basis: Option<&[f64; 16]>,
    ) -> Result<PlannedBatch, ParquetError> {
        let basis = baked_basis.map(|m| ifc_lite_geometry::Matrix4::from_row_slice(m));
        let (plan, new_shapes) = match &self.prior {
            Some(prior) => ShapePlan::shared_shapes_after(meshes, basis.as_ref(), prior),
            None => (ShapePlan::Identity, Vec::new()),
        };
        let (vertex_base, index_base) = (self.vertex_offset, self.index_offset);
        let mut emitted = Vec::with_capacity(new_shapes.len());
        let (mut vertex_end, mut index_end) = (vertex_base, index_base);
        for shape in plan.shape_meshes(meshes) {
            let vertex_count = u32::try_from(shape.positions.len() / 3).ok();
            let index_count = u32::try_from(shape.indices.len()).ok();
            let (Some(vertex_count), Some(index_count)) = (vertex_count, index_count) else {
                return Err(overflow());
            };
            if self.prior.is_some() {
                emitted.push(EmittedShape {
                    vertex_start: vertex_end,
                    vertex_count,
                    index_start: index_end,
                    index_count,
                });
            }
            vertex_end = vertex_end.checked_add(vertex_count).ok_or_else(overflow)?;
            index_end = index_end.checked_add(index_count).ok_or_else(overflow)?;
        }
        let (mesh, vertex, index) =
            build_mesh_tables(meshes, &plan, self.layout, vertex_base, index_base)?;
        if let Some(prior) = self.prior.as_mut() {
            // `new_shapes` runs parallel to the emitted shapes (see
            // `ShapePlan::shared_shapes_after`), so each lands where it was
            // just planned.
            let shape_meshes = plan.shape_meshes(meshes);
            for ((shape, at), mesh) in new_shapes.into_iter().zip(emitted).zip(shape_meshes) {
                prior.by_hash.insert(shape.key, at);
                let Some(rep) = shape.template_of else { continue };
                let bytes = template_bytes(mesh);
                if prior.templates.contains_key(&rep)
                    || self.retained_bytes + bytes > self.template_budget
                {
                    continue;
                }
                self.retained_bytes += bytes;
                prior.templates.insert(rep, RetainedTemplate { mesh: mesh.clone(), at });
            }
        }
        self.vertex_offset = vertex_end;
        self.index_offset = index_end;
        Ok(PlannedBatch {
            mesh,
            vertex,
            index,
            vertex_base,
            index_base,
        })
    }
}

/// The buffers a retained template holds, in bytes.
fn template_bytes(mesh: &MeshData) -> usize {
    (mesh.positions.len() + mesh.normals.len() + mesh.indices.len()) * 4
}

fn overflow() -> ParquetError {
    ParquetError::Overflow("global vertex/index offsets exceed u32".to_string())
}

#[cfg(test)]
#[path = "parquet_stream_shapes_tests.rs"]
mod parquet_stream_shapes_tests;
