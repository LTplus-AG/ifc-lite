// SPDX-License-Identifier: MPL-2.0
//! Flat/IFNS output adapters. The production transaction returns IFC Z-up
//! meshes; only the flat JS carrier applies the Y-up boundary rotation.
use super::batch_partition::{
    encode_shard_routing_refusals_back, is_instancing_candidate, meets_instance_threshold,
    take_back_rejected, tallyable_rep,
};
use super::batch_wire::BatchWire;
use super::instancing::ShardOccurrence;
use super::partitioned_batch::PartitionedBatch;
use super::style_finishes::{finish_at, mesh_js_with_finish};
use crate::zero_copy::{GeometryFingerprint, MeshCollection};
use ifc_lite_geometry::GeometryDiagnostics;
use ifc_lite_processing::prepass::finish_to_wire;

/// Per-element output of [`crate::api::IfcAPI::produce_batch`] — the canonical producer's
/// meshes (with `instance` metadata intact, BEFORE the MeshDataJs Z-up→Y-up
/// swap) plus everything the element's geometry-hash pass measured. The flat
/// path converts each to MeshDataJs; the instanced path collates them into an
/// IFNS shard.
pub(super) struct ElementMeshOutput {
    pub(super) id: u32,
    pub(super) meshes: Vec<ifc_lite_processing::MeshData>,
    /// #5984: `meshes[i]`'s finish at `[i]`; empty when none are installed.
    pub(super) finishes: Vec<Option<ifc_lite_processing::style::SpecularMaterial>>,
    pub(super) geometry_hash: Option<u64>,
    /// World AABB from the same hashing pass, `Some` exactly when
    /// `geometry_hash` is (see `ProducedElementMeshes::geometry_aabb`).
    pub(super) geometry_aabb: Option<[f64; 6]>,
    /// Enclosed volume in m³, `Some` only for a provably closed single solid
    /// (see `ProducedElementMeshes::geometry_volume`). `None` is normal.
    pub(super) geometry_volume: Option<f64>,
    /// Packed closure verdict; `0` when nothing was hashed.
    pub(super) geometry_closure_bits: u8,
}

impl ElementMeshOutput {
    /// The element's diff-engine record, or `None` when hashing was off / it
    /// produced nothing. Built in ONE place so the two push sites (flat and
    /// partitioned) cannot drift into filling different subsets of the
    /// index-parallel arrays.
    pub(super) fn fingerprint(&self) -> Option<GeometryFingerprint> {
        Some(GeometryFingerprint {
            express_id: self.id,
            hash: self.geometry_hash?,
            aabb: self.geometry_aabb,
            volume: self.geometry_volume,
            closure_bits: self.geometry_closure_bits,
        })
    }
}

pub(super) type BatchOutput = (
    Vec<ElementMeshOutput>,
    GeometryDiagnostics,
    Vec<ShardOccurrence>,
);
type Finish = Option<ifc_lite_processing::style::SpecularMaterial>;
type FinishedMesh = (ifc_lite_processing::MeshData, Finish);

fn rtc(wire: &BatchWire<'_>) -> [f64; 3] {
    if wire.needs_shift {
        [wire.rtc_x, wire.rtc_y, wire.rtc_z]
    } else {
        [0.0; 3]
    }
}
pub(super) fn flat((outputs, csg_diag, _): BatchOutput, wire: &BatchWire<'_>) -> MeshCollection {
    let mut mesh_collection = MeshCollection::with_capacity(wire.jobs_flat.len() / 3);
    if wire.needs_shift {
        mesh_collection.set_rtc_offset(wire.rtc_x, wire.rtc_y, wire.rtc_z);
    }
    for out in outputs {
        let fingerprint = out.fingerprint();
        for (i, mesh_data) in out.meshes.into_iter().enumerate() {
            mesh_collection.add(mesh_js_with_finish(mesh_data, finish_at(&out.finishes, i)));
        }
        if let Some(fp) = fingerprint {
            mesh_collection.push_geometry_hash(fp);
        }
    }
    mesh_collection.set_diagnostics(csg_diag);
    mesh_collection
}
pub(super) fn instanced((outputs, _, _): BatchOutput, wire: &BatchWire<'_>) -> Vec<u8> {
    let (meshes, wires): (Vec<ifc_lite_processing::MeshData>, Vec<[f32; 2]>) = outputs
        .into_iter()
        .flat_map(|o| {
            let finishes = o.finishes;
            o.meshes
                .into_iter()
                .enumerate()
                .map(move |(i, m)| (m, finish_to_wire(finish_at(&finishes, i))))
        })
        .filter(|(m, _)| m.geometry_class == 0)
        .unzip();
    // `refs` borrows the geometry in `meshes`; both live through synchronous
    // collation and encoding below.
    //
    // ONLY ordinary occurrences (geometry_class == 0) are instanced. Type-
    // product geometry — orphan type maps (class 1) and instanced type maps
    // (class 2) — is left to the flat path, which the viewer's Model/Types
    // view-mode filter gates (ViewportContainer drops class 2 in Model mode,
    // class 0 in Types mode). The instanced path has no view-mode filter, so
    // including class 1/2 here would render type geometry unconditionally
    // (the opaque type-template shapes drawing over the real occurrences —
    // the "blue windows/roof" + type geometry showing in Model mode).
    let refs: Vec<ifc_lite_geometry::InstanceMeshRef> = meshes
        .iter()
        .map(|m| ifc_lite_geometry::InstanceMeshRef {
            positions: &m.positions,
            normals: &m.normals,
            indices: &m.indices,
            origin: m.origin,
            instance_meta: m.instance.as_ref(),
            entity_id: m.express_id,
            color: m.color,
            item_id: m.geometry_item_id,
        })
        .collect();
    // min_group = 2: instance any repeat; singletons + non-instanceable flat.
    // Pass the applied RTC so per-occurrence transforms are reduced to the
    // post-RTC frame (matches the small baked origins; without it a rotated
    // occurrence lands at 2× the georef offset and collapses GLB exports).
    let rtc = rtc(wire);
    let collated = ifc_lite_geometry::collate_refs(&refs, 2, rtc);
    ifc_lite_geometry::encode_refs_with_finishes(&refs, &collated, &wires)
}
pub(super) fn partitioned(
    (outputs, csg_diag, shard_occurrences): BatchOutput,
    wire: &BatchWire<'_>,
) -> PartitionedBatch {
    let mut mesh_collection = MeshCollection::with_capacity(wire.jobs_flat.len() / 3);
    if wire.needs_shift {
        mesh_collection.set_rtc_offset(wire.rtc_x, wire.rtc_y, wire.rtc_z);
    }
    // Route opaque + untextured + class-0 occurrences by per-batch REPETITION.
    // Instancing trades 1 consolidated, frustum-culled flat draw for 1 drawIndexed
    // per template. That only pays off when geometry repeats enough that the saved
    // upload/memory is real and the per-template draw is amortized over many
    // instances. Singleton / low-count geometry encoded as 1-instance templates was
    // the orbit-FPS regression: it replaced the flat path's ~3-15 consolidated draws
    // with O(unique-geometry) per-frame draws (e.g. an 8 MB-geom architectural model
    // where memory was never the constraint). So: only rep_identity groups occurring
    // >= INSTANCE_MIN_OCCURRENCES times in this batch go to the instanced shard;
    // everything else (singletons, low-count, non-instanceable, no-meta) joins the
    // flat MeshCollection and is consolidated + culled exactly as before the flip.
    //
    // Transparent (alpha < cutoff), textured (no UV slot in the instanced pipeline),
    // type-product (class 1/2) and class-toggled (IfcSpace, IfcOpeningElement, …,
    // #5409) geometry are never instancing candidates — they must stay on the flat
    // pipelines for correct blending / texturing / view-mode / class-toggle gating.
    let mut candidates: Vec<(ifc_lite_processing::MeshData, Finish)> = Vec::new();
    let mut counts: rustc_hash::FxHashMap<u128, u32> = rustc_hash::FxHashMap::default();
    for out in outputs {
        let fingerprint = out.fingerprint();
        for (i, mesh_data) in out.meshes.into_iter().enumerate() {
            let finish = finish_at(&out.finishes, i);
            if is_instancing_candidate(&mesh_data) {
                // Count only instanceable metas, as collate_refs does: absent
                // or non-instanceable metas cannot instance or inflate a tally.
                if let Some(rep) = tallyable_rep(&mesh_data) {
                    *counts.entry(rep).or_insert(0) += 1;
                }
                candidates.push((mesh_data, finish));
            } else {
                mesh_collection.add(mesh_js_with_finish(mesh_data, finish));
            }
        }
        if let Some(fp) = fingerprint {
            mesh_collection.push_geometry_hash(fp);
        }
    }
    // #1623 Phase 3: fold the kept don't-bake occurrence counts into the per-rep
    // tally so a batch-local template (materialized ONCE, so count 1 among the
    // candidates) plus its N shard occurrences clears INSTANCE_MIN_OCCURRENCES
    // and routes to the instanced shard (the finalize already applied that gate,
    // so this only confirms it). The template's geometry rides the shard once;
    // the occurrences ride as pose-only instances against it.
    for occ in &shard_occurrences {
        *counts.entry(occ.rep_identity).or_insert(0) += 1;
    }
    let mut instanced: Vec<(ifc_lite_processing::MeshData, Finish)> = Vec::new();
    for (mesh_data, finish) in candidates {
        if meets_instance_threshold(&mesh_data, &counts) {
            instanced.push((mesh_data, finish));
        } else {
            mesh_collection.add(mesh_js_with_finish(mesh_data, finish));
        }
    }
    encode_partition(
        instanced,
        shard_occurrences,
        mesh_collection,
        csg_diag,
        rtc(wire),
    )
}
fn encode_partition(
    instanced: Vec<FinishedMesh>,
    shard_occurrences: Vec<ShardOccurrence>,
    mut mesh_collection: MeshCollection,
    csg_diag: GeometryDiagnostics,
    rtc: [f64; 3],
) -> PartitionedBatch {
    // Each materialized template and each pose-only occurrence contributes
    // one shard instance to the viewer's mesh total.
    let instanced_occurrences = instanced.len() + shard_occurrences.len();
    let occ_metas: Vec<ifc_lite_geometry::InstanceMeta> = shard_occurrences
        .iter()
        .map(|o| ifc_lite_geometry::InstanceMeta {
            transform: o.world_transform,
            local_transform: None,
            canonical_transform: None,
            rep_identity: o.rep_identity,
            instanceable: true,
        })
        .collect();
    let mut refs: Vec<ifc_lite_geometry::InstanceMeshRef> = instanced
        .iter()
        .map(|(m, _)| ifc_lite_geometry::InstanceMeshRef {
            positions: &m.positions,
            normals: &m.normals,
            indices: &m.indices,
            origin: m.origin,
            instance_meta: m.instance.as_ref(),
            entity_id: m.express_id,
            color: m.color,
            item_id: m.geometry_item_id,
        })
        .collect();
    for (o, meta) in shard_occurrences.iter().zip(occ_metas.iter()) {
        refs.push(ifc_lite_geometry::InstanceMeshRef {
            positions: &[],
            normals: &[],
            indices: &[],
            origin: [0.0, 0.0, 0.0],
            instance_meta: Some(meta),
            entity_id: o.entity_id,
            color: o.color,
            item_id: o.geometry_item_id,
        });
    }
    let wires: Vec<[f32; 2]> = instanced
        .iter()
        .map(|(_, f)| *f)
        .chain(shard_occurrences.iter().map(|o| o.finish))
        .map(finish_to_wire)
        .collect();
    let (shard, rejected, dropped) =
        encode_shard_routing_refusals_back(&refs, &wires, instanced.len(), rtc);
    drop(refs);
    let taken = take_back_rejected(instanced, &rejected, &mut mesh_collection);
    let instanced_occurrences = instanced_occurrences - dropped - taken;
    mesh_collection.set_diagnostics(csg_diag);
    PartitionedBatch {
        meshes: Some(mesh_collection),
        shard,
        instanced_occurrences,
    }
}
