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
    if all_occurrences.is_empty() {
        Vec::new()
    } else {
        let mut template_by_rep: rustc_hash::FxHashMap<u128, super::instancing::TemplateInfo> =
            rustc_hash::FxHashMap::default();
        for out in outputs.iter() {
            for m in &out.meshes {
                if m.positions.is_empty() {
                    continue;
                }
                if let Some(im) = m.instance.as_ref() {
                    if im.instanceable {
                        let eligible = is_instancing_candidate(m);
                        template_by_rep
                            .entry(im.rep_identity)
                            .or_insert(super::instancing::TemplateInfo { eligible });
                    }
                }
            }
        }
        let mut recovered_flats: Vec<ifc_lite_processing::MeshData> = Vec::new();
        let mut shard = super::instancing::resolve_batch_occurrences(
            all_occurrences,
            &template_by_rep,
            mapped_item_cache,
            rtc,
            INSTANCE_MIN_OCCURRENCES as usize,
            &mut recovered_flats,
        );
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
