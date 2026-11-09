// SPDX-License-Identifier: MPL-2.0
//! Batch-local don't-bake completion and sub-threshold flat recovery.
use super::batch_output::ElementMeshOutput;
use super::batch_partition::{is_instancing_candidate, INSTANCE_MIN_OCCURRENCES};
use super::style_finishes::BatchFinishes;
use ifc_lite_core::EntityDecoder;

pub(super) fn recover(
    outputs: &mut Vec<ElementMeshOutput>,
    all_occurrences: Vec<ifc_lite_processing::RawInstanceOccurrence>,
    mapped_item_cache: &ifc_lite_geometry::SharedMappedItemCache,
    rtc: [f64; 3],
    batch_finishes: &mut BatchFinishes<'_>,
    decoder: &mut EntityDecoder,
) -> Vec<super::instancing::ShardOccurrence> {
    // Retained instanceable meshes provide batch-local template facts. Resolve
    // kept shard instances and recover sub-threshold/ineligible templates flat.
    // Empty (unarmed / no occurrences) keeps the output byte-identical.
    if all_occurrences.is_empty() {
        Vec::new()
    } else {
        // The native finalize's template selection over this batch's meshes
        // only. Eligibility is the partition's same opaque, untextured class-0
        // candidate gate, so recovery and output cannot drift.
        let template_by_rep = ifc_lite_processing::index_templates_by_rep(
            outputs.iter().flat_map(|out| out.meshes.iter()),
            |_, m| super::instancing::TemplateInfo { eligible: is_instancing_candidate(m) },
        );
        let mut recovered_flats: Vec<ifc_lite_processing::MeshData> = Vec::new();
        let mut shard = super::instancing::resolve_batch_occurrences(
            all_occurrences,
            &template_by_rep,
            mapped_item_cache,
            rtc,
            INSTANCE_MIN_OCCURRENCES as usize,
            &mut recovered_flats,
        );
        // Recovered occurrences are single-mesh outputs with no instance meta:
        // the partition sends them flat, byte-identical to the flat baseline.
        for m in recovered_flats {
            let id = m.express_id;
            outputs.push(ElementMeshOutput {
                id,
                finishes: batch_finishes.for_meshes(std::slice::from_ref(&m), decoder),
                meshes: vec![m],
                geometry_hash: None,
                geometry_aabb: None,
                geometry_volume: None,
                geometry_closure_bits: 0,
            });
        }
        for occ in &mut shard {
            occ.finish = batch_finishes.for_occurrence(
                occ.entity_id,
                occ.geometry_item_id,
                occ.color,
                decoder,
            );
        }
        shard
    }
}
