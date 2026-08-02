// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #1623 Phase 2 "don't-bake" finalize: turn the geometry phase's collected
//! [`RawInstanceOccurrence`]s into [`InstanceRecord`]s against the retained template
//! meshes, recovering any (effectively unreachable) orphan from the shared source
//! registry so geometry is never silently lost.

use crate::types::mesh::{InstanceRecord, MeshData, RawInstanceOccurrence};
use rustc_hash::FxHashMap;

/// Resolve the collected don't-bake occurrences into [`InstanceRecord`]s against the
/// retained template meshes. `meshes` is mutated ONLY by APPENDING recovered orphan
/// flats — templates and every other mesh are left untouched (byte-identical) — so
/// this is a no-op on the flat path (`raw` empty).
pub(super) fn finalize_instances(
    raw: Vec<RawInstanceOccurrence>,
    meshes: &mut Vec<MeshData>,
    mapped_item_cache: &ifc_lite_geometry::SharedMappedItemCache,
    rtc: [f64; 3],
) -> Vec<InstanceRecord> {
    if raw.is_empty() {
        return Vec::new();
    }
    // Group occurrences by shared-template key (IfcRepresentationMap id).
    let mut by_source: FxHashMap<u128, Vec<RawInstanceOccurrence>> = FxHashMap::default();
    for occ in raw {
        by_source.entry(occ.rep_identity).or_default().push(occ);
    }
    // rep_identity ⇒ the template mesh (a retained, non-empty occurrence carrying
    // this rep_identity in its InstanceMeta — the min-id occurrence that materialized).
    let mut template_by_rep: FxHashMap<u128, usize> = FxHashMap::default();
    for (i, m) in meshes.iter().enumerate() {
        if m.positions.is_empty() {
            continue;
        }
        if let Some(im) = m.instance.as_ref() {
            if im.instanceable {
                template_by_rep.entry(im.rep_identity).or_insert(i);
            }
        }
    }

    let mut records: Vec<InstanceRecord> = Vec::new();
    let mut orphan_flats: Vec<MeshData> = Vec::new();
    // Deterministic output order: sort the source groups by id.
    let mut groups: Vec<(u128, Vec<RawInstanceOccurrence>)> = by_source.into_iter().collect();
    groups.sort_by_key(|(rep, _)| *rep);
    for (rep, occs) in groups {
        // Template present (the common, expected case): emit template-relative records.
        if let Some(&t_idx) = template_by_rep.get(&rep) {
            if let Some(im) = meshes[t_idx].instance.as_ref() {
                let m_ref = ifc_lite_geometry::compose_instance_world_row_major(im);
                let template_express_id = meshes[t_idx].express_id;
                let mut batch = Vec::with_capacity(occs.len());
                let mut all_ok = true;
                for occ in &occs {
                    match ifc_lite_geometry::instance_rel_row_major_f32(
                        &occ.world_transform,
                        &m_ref,
                        rtc,
                    ) {
                        Some(transform) => batch.push(InstanceRecord {
                            express_id: occ.express_id,
                            ifc_type: occ.ifc_type.clone(),
                            global_id: occ.global_id.clone(),
                            name: occ.name.clone(),
                            presentation_layer: occ.presentation_layer.clone(),
                            color: occ.color,
                            template_express_id,
                            rep_identity: rep,
                            transform,
                        }),
                        // Singular m_ref (degenerate placement) ⇒ recover flat instead.
                        None => {
                            all_ok = false;
                            break;
                        }
                    }
                }
                if all_ok {
                    records.extend(batch);
                    continue;
                }
            }
        }
        // Orphan / degenerate recovery: reconstruct each occurrence as a flat mesh
        // from the shared source registry. Effectively unreachable for the eligible
        // single-solid type-instanced set (their template occurrence always
        // materializes), but guarantees no geometry is ever dropped.
        recover_orphan_occurrences(rep, &occs, mapped_item_cache, rtc, &mut orphan_flats);
    }
    // The occurrences arrived in parallel-collection (nondeterministic) order; sort
    // both outputs by element id so the instanced result is deterministic run to run.
    records.sort_by_key(|r| (r.express_id, r.rep_identity));
    orphan_flats.sort_by_key(|m| m.express_id);
    meshes.append(&mut orphan_flats);
    records
}

/// Rebuild each occurrence of `rep` as a standalone flat [`MeshData`] from the shared
/// source registry (source-coords geometry placed at the occurrence's world
/// transform). No instancing benefit, but correct (world triangles match the flat
/// path) and never a silent loss.
fn recover_orphan_occurrences(
    rep: u128,
    occs: &[RawInstanceOccurrence],
    mapped_item_cache: &ifc_lite_geometry::SharedMappedItemCache,
    rtc: [f64; 3],
    out: &mut Vec<MeshData>,
) {
    // Mapped rep_identity is the source id (always < 2^32); a direct-solid tag never
    // reaches this don't-bake path.
    let source_id = rep as u32;
    let source = mapped_item_cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&source_id)
        .cloned();
    let Some(source) = source else {
        tracing::warn!(
            source_id,
            occurrences = occs.len(),
            "instancing: orphan mapped source missing from registry; occurrences dropped"
        );
        return;
    };
    for occ in occs {
        let (positions, normals, indices) =
            ifc_lite_geometry::bake_source_at_world(&source, &occ.world_transform, rtc);
        if positions.is_empty() || indices.is_empty() {
            continue;
        }
        out.push(
            MeshData::new(
                occ.express_id,
                occ.ifc_type.clone(),
                positions,
                normals,
                indices,
                occ.color,
            )
            .with_element_metadata(
                occ.global_id.clone(),
                occ.name.clone(),
                occ.presentation_layer.clone(),
            ),
        );
    }
}
