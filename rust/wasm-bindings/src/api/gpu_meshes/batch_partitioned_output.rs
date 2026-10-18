// SPDX-License-Identifier: MPL-2.0
//! Post-production flat/shard routing, including original occurrence and finish
//! order. Source decoding and owned context admission stay in produce_batch.
use super::{batch::ElementMeshOutput, partitioned_batch::PartitionedBatch};
use super::batch_partition::{encode_shard_routing_refusals_back, is_instancing_candidate,
    meets_instance_threshold, take_back_rejected, tallyable_rep};
use super::style_finishes::{finish_at, mesh_js_with_finish};
use crate::zero_copy::MeshCollection;
use ifc_lite_processing::prepass::finish_to_wire;

pub(super) fn partition_outputs(outputs: Vec<ElementMeshOutput>,
    csg_diag: ifc_lite_geometry::GeometryDiagnostics,
    shard_occurrences: Vec<super::instancing::ShardOccurrence>, num_jobs: usize,
    rtc_offset: (f64, f64, f64), needs_shift: bool,
) -> PartitionedBatch {
    let (rtc_x, rtc_y, rtc_z) = rtc_offset;
    let mut mesh_collection = MeshCollection::with_capacity(num_jobs);
    if needs_shift {
        mesh_collection.set_rtc_offset(rtc_x, rtc_y, rtc_z);
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
    type Finish = Option<ifc_lite_processing::style::SpecularMaterial>;
    let mut candidates: Vec<(ifc_lite_processing::MeshData, Finish)> = Vec::new();
    let mut counts: rustc_hash::FxHashMap<u128, u32> = rustc_hash::FxHashMap::default();
    for out in outputs {
        // Taken BEFORE the meshes are moved out of `out` below.
        let fingerprint = out.fingerprint();
        for (i, mesh_data) in out.meshes.into_iter().enumerate() {
            let finish = finish_at(&out.finishes, i);
            if is_instancing_candidate(&mesh_data) {
                // Count only instanceable metas — mirror collate_refs's match arm:
                // a None meta or instanceable==false (void-cut walls, multi-item
                // merges) can never instance, so it must not inflate a count.
                if let Some(rep) = tallyable_rep(&mesh_data) {
                    *counts.entry(rep).or_insert(0) += 1;
                }
                candidates.push((mesh_data, finish));
            } else {
                mesh_collection.add(mesh_js_with_finish(mesh_data, finish));
            }
        }
        // The element-level geometry-diff record is path-independent metadata;
        // keep it on the collection regardless of which path the meshes took.
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
    // Each materialized instanced mesh is one shard instance; each kept don't-bake
    // occurrence adds one more. Report the sum so the viewer's mesh total reflects
    // ALL rendered geometry (flat + instanced), not just the flat MeshCollection.
    let instanced_occurrences = instanced.len() + shard_occurrences.len();
    // #1623 Phase 3: back the kept don't-bake occurrences with InstanceMeta storage
    // that outlives `refs` — `collate_refs` reads each placeholder's PRE-RTC world
    // transform (local/canonical identity) to derive its `rel_k` against the
    // batch-local template, exactly as a materialized occurrence would. Building
    // these EMPTY-geometry refs is the whole Phase 3 win: the occurrence vertices
    // were never materialized.
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
            // #2985: the TEMPLATE's own representation item — it rides the
            // shard, not the flat MeshCollection, so this is its only route.
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
            // #2985: a don't-bake occurrence has no MeshData to read it from.
            item_id: o.geometry_item_id,
        });
    }
    let rtc = if needs_shift { [rtc_x, rtc_y, rtc_z] } else { [0.0, 0.0, 0.0] };
    // #5984: the finish rides the shard's per-instance field 2, index-parallel to `refs`.
    let wires: Vec<[f32; 2]> = instanced.iter().map(|(_, f)| *f).chain(shard_occurrences.iter().map(|o| o.finish)).map(finish_to_wire).collect();
    let (shard, rejected, dropped) =
        encode_shard_routing_refusals_back(&refs, &wires, instanced.len(), rtc);
    drop(refs);
    // Handed back = drawn flat; DROPPED = drawn nowhere. Both leave the count.
    let taken = take_back_rejected(instanced, &rejected, &mut mesh_collection);
    let instanced_occurrences = instanced_occurrences - dropped - taken;
    mesh_collection.set_diagnostics(csg_diag);
    PartitionedBatch {
        meshes: Some(mesh_collection),
        shard,
        instanced_occurrences,
    }
}
