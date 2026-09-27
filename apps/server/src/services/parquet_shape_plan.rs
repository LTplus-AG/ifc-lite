// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The SHAPE PLAN: which mesh row of the flat transport draws which block of
//! vertex/index rows.
//!
//! Split out of `parquet_mesh_tables.rs`, which packs the columns a plan
//! describes. One planner serves both routes that share shapes. The buffered
//! `POST /parse/parquet` plans a whole model against nothing (#3888, #5130).
//! The streaming route plans one batch at a time against the shapes EARLIER
//! batches already emitted (#5407), which is the only difference: the prior
//! registry is an argument, never a second implementation of the grouping.

use crate::services::axis::zup_to_yup_f64;
use crate::services::parquet_instancing::{
    collate_rotation_aware_placements, mesh_geometry_key, rotation_zup_to_yup, MeshGeometryKey,
    IDENTITY_ROTATION,
};
use crate::types::MeshData;
use rustc_hash::{FxHashMap, FxHashSet};

/// Where an already-emitted shape's block lives in the WHOLE-STREAM vertex and
/// index tables. `index_start` / `index_count` count indices, not triangles,
/// matching the mesh table's columns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct EmittedShape {
    pub vertex_start: u32,
    pub vertex_count: u32,
    pub index_start: u32,
    pub index_count: u32,
}

/// What earlier stream batches leave behind for later ones (#5407).
#[derive(Default)]
pub(super) struct PriorShapes {
    /// Every shape emitted so far, by content hash: where it landed. No
    /// geometry, so it costs the same whatever the shape's size.
    pub(super) by_hash: FxHashMap<MeshGeometryKey, EmittedShape>,
    /// Per instanced representation (`InstanceMeta::rep_identity`), the
    /// collator template emitted for it and where. The ONE piece of geometry
    /// carried across a batch boundary, because stage 1 verifies every
    /// occurrence against its template's vertices; a rotated repeat is not
    /// bit-identical to anything, so the hash alone cannot share it. What gets
    /// retained, and the budget capping it, is the caller's decision.
    pub(super) templates: FxHashMap<u128, RetainedTemplate>,
}

/// An earlier batch's collator template, kept so a later batch's occurrences
/// of the same representation can be verified against it and drawn from its
/// block rather than from a fresh copy.
pub(super) struct RetainedTemplate {
    pub(super) mesh: MeshData,
    pub(super) at: EmittedShape,
}

/// One shape a stream batch emits that no earlier batch did.
pub(super) struct NewShape {
    pub(super) key: MeshGeometryKey,
    /// `Some(rep_identity)` when the shape is an instanceable mesh, i.e. a
    /// candidate template for [`PriorShapes::templates`]. Not only this
    /// batch's collator templates: a representation that occurs ONCE per
    /// batch is never collated inside any one of them, and the buffered
    /// collator's template is just a group's first member, so the first one
    /// the stream emits is as valid a template as any.
    pub(super) template_of: Option<u128>,
}

/// The block of vertex/index rows one mesh row points at.
#[derive(Clone, Copy)]
pub(super) enum ShapeRef {
    /// Index into [`ShapePlan::Shared::shapes`]: a block THIS table set emits.
    Slot(usize),
    /// A block an earlier stream batch emitted; the row carries its
    /// whole-stream range as-is.
    Emitted(EmittedShape),
}

/// One mesh row's placement against the shape blocks.
pub(super) struct PlannedRow {
    shape: ShapeRef,
    /// Y-up metres. `world = origin + R * p`.
    origin_yup: [f64; 3],
    /// Row-major 3x3, Y-up.
    rotation: [f32; 9],
}

/// Which shapes get their vertices written, and how each mesh row reaches one.
///
/// `Identity` carries NO data on purpose: its plan is a function of the mesh
/// index alone, so materializing it would allocate ~80 bytes per mesh — on
/// every streamed batch of a writer that shares nothing — to store `i` and
/// nine repeated constants.
pub(super) enum ShapePlan {
    /// The `-parquet-v5` layout: every mesh writes its own geometry. What the
    /// streaming route uses unless the client opted in to cross-batch sharing.
    Identity,
    /// The `-parquet-v7` layout.
    Shared {
        /// Mesh indices whose vertex/index data is emitted, in emission order.
        shapes: Vec<usize>,
        /// One entry per input mesh, parallel to the mesh slice.
        rows: Vec<PlannedRow>,
    },
}

impl ShapePlan {
    /// Plan a whole model (the buffered route) in the SAME two-stage order
    /// `/optimized` uses (issue #5130): the rotation-aware collator
    /// ([`collate_rotation_aware_placements`]) runs first, and every
    /// occurrence it did not place falls through to a content hash of its
    /// (origin-relative) vertex and index buffers ([`mesh_geometry_key`]), so
    /// bit-identical occurrences the collator has no group for still collapse
    /// onto one shape.
    ///
    /// Stage 1 reuses the collator verbatim — the same grouping, the same
    /// per-vertex residual check, the same all-or-nothing per group — so the
    /// flat route can never share a shape the `/optimized` route would have
    /// refused to share. Stage 2 mirrors `serialize_to_parquet_optimized`'s
    /// `None` branch: the hash's first occurrence (by mesh index, not by slot)
    /// becomes the shared shape every later bit-identical occurrence points at.
    ///
    /// Returns [`ShapePlan::Identity`] only when NEITHER stage shared anything
    /// — a hash-only match must still return `Shared`, not just a collator
    /// match — so a model with no repeats at all emits the v5 layout through
    /// the same path it always did rather than through a `Shared` plan that
    /// happens to be one-to-one.
    pub(super) fn shared_shapes(
        meshes: &[MeshData],
        baked_basis: Option<&ifc_lite_geometry::Matrix4<f64>>,
    ) -> Self {
        plan(meshes, baked_basis, None).0
    }

    /// Plan one stream batch against the shapes earlier batches emitted
    /// (#5407). Everything [`Self::shared_shapes`] shares inside the batch is
    /// still shared; on top of that, a shape whose content hash matches one
    /// in `prior` is not written again — the row carries the earlier block's
    /// whole-stream range instead.
    ///
    /// Stage 1 reaches across batches the same way: every retained template
    /// whose representation occurs in this batch is put in FRONT of it for
    /// the collator, which takes a group's first member as its template, so
    /// this batch's occurrences are verified against the very geometry an
    /// earlier batch emitted and placed on its block.
    ///
    /// Also returns every shape this batch DOES emit, in emission order, with
    /// its content hash, so the caller can record where each one lands without
    /// hashing its geometry a second time.
    ///
    /// `baked_basis` is the stream's frame, which the pipeline publishes
    /// before its first batch; `None` costs a site-rotated model its rotated
    /// sharing (#4118), never correctness.
    pub(super) fn shared_shapes_after(
        meshes: &[MeshData],
        baked_basis: Option<&ifc_lite_geometry::Matrix4<f64>>,
        prior: &PriorShapes,
    ) -> (Self, Vec<NewShape>) {
        plan(meshes, baked_basis, Some(prior))
    }

    /// The meshes whose geometry is emitted, in emission order.
    pub(super) fn shape_meshes<'a>(&self, meshes: &'a [MeshData]) -> Vec<&'a MeshData> {
        match self {
            Self::Identity => meshes.iter().collect(),
            Self::Shared { shapes, .. } => shapes.iter().map(|&i| &meshes[i]).collect(),
        }
    }

    /// Mesh row `i`'s shape and the placement mapping that shape's geometry
    /// onto this occurrence. Computed, not stored, under `Identity`.
    pub(super) fn row(&self, meshes: &[MeshData], i: usize) -> (ShapeRef, [f64; 3], [f32; 9]) {
        match self {
            Self::Identity => (
                ShapeRef::Slot(i),
                zup_to_yup_f64(meshes[i].origin),
                IDENTITY_ROTATION,
            ),
            Self::Shared { rows, .. } => {
                let row = &rows[i];
                (row.shape, row.origin_yup, row.rotation)
            }
        }
    }

    /// The mesh count this plan was built for; `None` fits any slice.
    pub(super) fn row_count(&self) -> Option<usize> {
        match self {
            Self::Identity => None,
            Self::Shared { rows, .. } => Some(rows.len()),
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

/// The one planner behind both entry points above.
///
/// With `prior == None` nothing is carried, looked up or additionally hashed,
/// so the buffered route's plan is exactly what it was before #5407. With
/// `Some`, the retained templates go in front of the batch (see
/// [`ShapePlan::shared_shapes_after`]), and every shape the batch would emit
/// is first looked up by content hash: a collator template as well as a
/// stage-2 first occurrence, since a group whose template is bit-identical to
/// an earlier batch's shape can point at that block just as a lone repeat can.
fn plan(
    meshes: &[MeshData],
    baked_basis: Option<&ifc_lite_geometry::Matrix4<f64>>,
    prior: Option<&PriorShapes>,
) -> (ShapePlan, Vec<NewShape>) {
    let carried = prior.map_or_else(Vec::new, |prior| carried_templates(meshes, prior));
    let view: Vec<&MeshData> = carried.iter().map(|t| &t.mesh).chain(meshes).collect();
    let placements = collate_rotation_aware_placements(&view, baked_basis);
    let mut shapes: Vec<usize> = Vec::with_capacity(meshes.len());
    let mut new_shapes: Vec<NewShape> = Vec::new();
    let mut shape_of: FxHashMap<usize, ShapeRef> = FxHashMap::default();
    // Content-hash fallback (stage 2): first occurrence of a hash wins the
    // slot for every later bit-identical occurrence the collator left out.
    let mut hash_slot: FxHashMap<MeshGeometryKey, usize> = FxHashMap::default();
    let mut rows: Vec<PlannedRow> = Vec::with_capacity(meshes.len());
    for (i, mesh) in meshes.iter().enumerate() {
        // The template is itself an occurrence of its own group, so it takes
        // the shared branch too; keying `shape_of` by mesh index in BOTH
        // branches means a template can never also be emitted a second time as
        // its own unshared shape.
        let (shape_mesh, known_key, origin_yup, rotation) = match placements.get(&(i + carried.len())) {
            Some(placement) => {
                let origin_yup = zup_to_yup_f64(placement.origin_zup);
                let rotation = rotation_zup_to_yup(&placement.rotation_zup);
                let Some(template) = placement.template_mesh_index.checked_sub(carried.len()) else {
                    // Verified against a template an earlier batch emitted.
                    let at = carried[placement.template_mesh_index].at;
                    rows.push(PlannedRow { shape: ShapeRef::Emitted(at), origin_yup, rotation });
                    continue;
                };
                (template, None, origin_yup, rotation)
            }
            None => {
                let key = mesh_geometry_key(mesh);
                let first = *hash_slot.entry(key).or_insert(i);
                (first, Some(key), zup_to_yup_f64(mesh.origin), IDENTITY_ROTATION)
            }
        };
        let shape = *shape_of.entry(shape_mesh).or_insert_with(|| {
            let Some(prior) = prior else {
                shapes.push(shape_mesh);
                return ShapeRef::Slot(shapes.len() - 1);
            };
            let key = known_key.unwrap_or_else(|| mesh_geometry_key(&meshes[shape_mesh]));
            if let Some(&emitted) = prior.by_hash.get(&key) {
                return ShapeRef::Emitted(emitted);
            }
            let template_of = meshes[shape_mesh]
                .instance
                .as_ref()
                .filter(|im| im.instanceable)
                .map(|im| im.rep_identity);
            shapes.push(shape_mesh);
            new_shapes.push(NewShape { key, template_of });
            ShapeRef::Slot(shapes.len() - 1)
        });
        rows.push(PlannedRow {
            shape,
            origin_yup,
            rotation,
        });
    }
    if shapes.len() == meshes.len() {
        // Nothing shared, within the slice or with an earlier batch: every row
        // emits its own shape, in mesh order.
        return (ShapePlan::Identity, new_shapes);
    }
    (ShapePlan::Shared { shapes, rows }, new_shapes)
}

/// The retained templates of the instanced representations `meshes` contains,
/// each once, in first-occurrence order (the collator's group order is
/// first-seen too, so this keeps the plan deterministic).
fn carried_templates<'p>(meshes: &[MeshData], prior: &'p PriorShapes) -> Vec<&'p RetainedTemplate> {
    if prior.templates.is_empty() {
        return Vec::new();
    }
    let mut seen: FxHashSet<u128> = FxHashSet::default();
    meshes
        .iter()
        .filter_map(|m| m.instance.as_ref())
        .filter(|im| im.instanceable && seen.insert(im.rep_identity))
        .filter_map(|im| prior.templates.get(&im.rep_identity))
        .collect()
}
