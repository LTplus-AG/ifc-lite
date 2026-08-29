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
                            geometry_item_id: occ.geometry_item_id,
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
        if !recover_occurrences_flat(rep, &occs, mapped_item_cache, rtc, &mut orphan_flats) {
            tracing::warn!(
                source_id = rep as u32,
                occurrences = occs.len(),
                "instancing: orphan mapped source missing from registry; occurrences dropped"
            );
        }
    }
    // The occurrences arrived in parallel-collection (nondeterministic) order; sort
    // both outputs by element id so the instanced result is deterministic run to run.
    records.sort_by_key(|r| (r.express_id, r.rep_identity));
    orphan_flats.sort_by_key(|m| m.express_id);
    meshes.append(&mut orphan_flats);
    records
}

/// Rebuild each don't-bake occurrence of `rep` as a standalone flat [`MeshData`],
/// baked from the shared mapped-source registry at the occurrence's world
/// transform (post-RTC) — geometrically identical to the occurrence the flat path
/// would have produced. No instancing benefit, but correct and never a silent loss.
///
/// ONE home for the occurrence → `MeshData` mapping. The native finalize below and
/// the browser batch's `resolve_batch_occurrences`
/// (`rust/wasm-bindings/src/api/gpu_meshes/instancing.rs`) are the same recovery on
/// two targets, and were near-verbatim clones: the same lookup, the same bake, the
/// same empty check, the same `MeshData` literal. #2985's dropped item id had to be
/// found, fixed and tested twice because of that. The next per-occurrence field is
/// added here once.
///
/// Returns `false` when `rep`'s source is absent from the registry, so nothing was
/// recovered. That is the ONLY thing the two callers differ on, and it stays at the
/// call sites: the native side logs it, the browser side has no tracing sink and
/// cannot reach the case anyway.
pub fn recover_occurrences_flat(
    rep: u128,
    occs: &[RawInstanceOccurrence],
    mapped_item_cache: &ifc_lite_geometry::SharedMappedItemCache,
    rtc: [f64; 3],
    out: &mut Vec<MeshData>,
) -> bool {
    // Mapped rep_identity is the RepresentationMap source id (always < 2^32); a
    // direct-solid tag never reaches this don't-bake path.
    let source_id = rep as u32;
    let source = mapped_item_cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&source_id)
        .cloned();
    let Some(source) = source else {
        return false;
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
            )
            // #2985: a recovered occurrence renders FLAT, so its item id has to
            // ride the mesh rather than the shard — without this the one path
            // that produces no instance record also reports no source item, and
            // the absence is indistinguishable from "this geometry has none".
            // `false` = the id is a representation item, never a material (#3199).
            .with_style_metadata(None, occ.geometry_item_id, false),
        );
    }
    true
}

#[cfg(test)]
mod orphan_recovery_tests {
    //! #2985. The orphan branch is the ONE path here that emits no
    //! [`InstanceRecord`], so it is the one place the item id cannot ride the
    //! record and has to ride the recovered `MeshData` instead. Left unwired it
    //! would fail silently: a consumer cannot tell "this occurrence lost its id"
    //! from "this geometry has no item", which is exactly how the id was being
    //! dropped before.
    use super::*;
    use std::sync::{Arc, Mutex};

    const REP: u128 = 4242;
    const ITEM_ID: u32 = 4638;

    fn occurrence(express_id: u32, geometry_item_id: Option<u32>) -> RawInstanceOccurrence {
        RawInstanceOccurrence {
            express_id,
            ifc_type: "IfcFlowFitting".to_string(),
            global_id: None,
            name: None,
            presentation_layer: None,
            color: [1.0, 1.0, 1.0, 1.0],
            rep_identity: REP,
            world_transform: [
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            ],
            geometry_item_id,
        }
    }

    /// A registered source is REQUIRED: with an empty registry `recover_occurrences_flat`
    /// returns before building any `MeshData`, and an assertion over zero recovered
    /// meshes would pass no matter what the field held.
    fn cache_with_source() -> ifc_lite_geometry::SharedMappedItemCache {
        let mut source = ifc_lite_geometry::Mesh::new();
        source.positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        source.normals = vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
        source.indices = vec![0, 1, 2];
        let map: FxHashMap<u32, Arc<ifc_lite_geometry::Mesh>> =
            [(REP as u32, Arc::new(source))].into_iter().collect();
        Arc::new(Mutex::new(map))
    }

    #[test]
    fn an_orphan_recovered_flat_reports_its_item_id() {
        // No mesh carries this rep_identity ⇒ no template ⇒ the orphan branch.
        let mut meshes: Vec<MeshData> = Vec::new();
        let records = finalize_instances(
            vec![occurrence(7, Some(ITEM_ID))],
            &mut meshes,
            &cache_with_source(),
            [0.0, 0.0, 0.0],
        );

        assert!(records.is_empty(), "an orphan emits no InstanceRecord");
        assert_eq!(meshes.len(), 1, "the orphan must be recovered flat, not dropped");
        assert_eq!(
            meshes[0].geometry_item_id,
            Some(ITEM_ID),
            "the recovered orphan lost the item id the occurrence carried"
        );
        // #3199 disjointness: the id is a representation item, never a material.
        assert_eq!(meshes[0].material_id, None);
    }

    #[test]
    fn an_orphan_with_no_item_stays_absent_rather_than_reporting_zero() {
        // `with_style_metadata` filters a 0 source id to None on both fields; a
        // recovered occurrence that genuinely had no item must land there too,
        // not on a fabricated `#0` a host would follow to nothing.
        let mut meshes: Vec<MeshData> = Vec::new();
        finalize_instances(
            vec![occurrence(7, None)],
            &mut meshes,
            &cache_with_source(),
            [0.0, 0.0, 0.0],
        );
        assert_eq!(meshes.len(), 1);
        assert_eq!(meshes[0].geometry_item_id, None);
        assert_eq!(meshes[0].material_id, None);
    }
}
