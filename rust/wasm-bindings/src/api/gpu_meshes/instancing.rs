// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #1623 Phase 3 browser don't-bake finalize.
//!
//! The batch router (armed in BATCH-LOCAL mode) materializes ONE template per
//! repeated single-solid `IfcRepresentationMap` source per batch and emits every
//! OTHER occurrence as a lightweight [`RawInstanceOccurrence`] (no per-occurrence
//! vertex bake). This module turns those raw occurrences into the two outputs the
//! partitioned batch needs:
//!
//! - [`ShardOccurrence`]s: occurrences whose (in-batch) template is shard-eligible
//!   AND whose group clears the instancing threshold. They ride the IFNS shard as
//!   pose-only instances (empty-geometry `InstanceMeshRef`s → `collate_refs`), so
//!   their vertices are never materialized — the Phase 3 CPU win.
//! - recovered flat [`MeshData`]s: every other occurrence, baked from the shared
//!   mapped-item source registry (`bake_source_at_world`) so no geometry is lost.
//!   These render flat exactly as if instancing had never fired (byte-identical
//!   world triangles to the flat baseline, mirroring the native orphan recovery).

use ifc_lite_geometry::{bake_source_at_world, SharedMappedItemCache};
use ifc_lite_processing::{MeshData, RawInstanceOccurrence};
use rustc_hash::FxHashMap;

/// A batch-local template's shard-relevant facts: its PRE-RTC composed world
/// transform and whether it is shard-eligible (opaque, untextured, ordinary
/// occurrence geometry — the exact criteria the partition routes a candidate to
/// the instanced shard by). Built by the batch from each retained instanceable
/// mesh; consumed here to decide keep-as-shard vs recover-flat per rep group.
pub(super) struct TemplateInfo {
    pub eligible: bool,
}

/// One resolved don't-bake occurrence, ready to ride the IFNS shard as a pose-only
/// instance. Carries no geometry (the batch-local template supplies it) — only the
/// per-occurrence id, colour, and PRE-RTC composed world transform. The partition
/// wraps each as an empty-geometry `InstanceMeshRef` so `collate_refs` derives its
/// `rel_k` against the template, exactly as a materialized occurrence would.
pub(super) struct ShardOccurrence {
    pub entity_id: u32,
    pub color: [f32; 4],
    pub rep_identity: u128,
    /// PRE-RTC composed world transform (row-major) — `RawInstanceOccurrence::world_transform`.
    pub world_transform: [f64; 16],
}

/// Resolve the batch's collected don't-bake occurrences (#1623 Phase 3). For each
/// rep group with a SHARD-ELIGIBLE in-batch template whose total occurrence count
/// (template + placeholders) clears `min_occurrences`, the occurrences become
/// [`ShardOccurrence`]s; every other occurrence is RECOVERED FLAT (baked from the
/// shared source registry) and pushed to `recovered_flats` so nothing is lost.
/// Deterministic: groups are visited in rep-id order and the shard output is sorted.
pub(super) fn resolve_batch_occurrences(
    raw: Vec<RawInstanceOccurrence>,
    template_by_rep: &FxHashMap<u128, TemplateInfo>,
    mapped_item_cache: &SharedMappedItemCache,
    rtc: [f64; 3],
    min_occurrences: usize,
    recovered_flats: &mut Vec<MeshData>,
) -> Vec<ShardOccurrence> {
    if raw.is_empty() {
        return Vec::new();
    }
    let mut by_rep: FxHashMap<u128, Vec<RawInstanceOccurrence>> = FxHashMap::default();
    for occ in raw {
        by_rep.entry(occ.rep_identity).or_default().push(occ);
    }
    let mut groups: Vec<(u128, Vec<RawInstanceOccurrence>)> = by_rep.into_iter().collect();
    groups.sort_by_key(|(rep, _)| *rep);

    let mut shard: Vec<ShardOccurrence> = Vec::new();
    for (rep, occs) in groups {
        // Keep as shard instances only when a shard-eligible in-batch template exists
        // (batch-local mode materializes one per source, so it normally does) AND the
        // group (template + occurrences) clears the instancing gate — matching the
        // partition's `INSTANCE_MIN_OCCURRENCES` routing. Otherwise recover flat: the
        // template renders flat and these occurrences must too.
        let keep = template_by_rep
            .get(&rep)
            .is_some_and(|t| t.eligible)
            && (occs.len() + 1) >= min_occurrences;
        if keep {
            for occ in occs {
                shard.push(ShardOccurrence {
                    entity_id: occ.express_id,
                    color: occ.color,
                    rep_identity: rep,
                    world_transform: occ.world_transform,
                });
            }
        } else {
            recover_flat(rep, &occs, mapped_item_cache, rtc, recovered_flats);
        }
    }
    // Deterministic shard-instance order (occurrences arrive in job order, already
    // deterministic, but sort defensively so the wire bytes are stable run to run).
    shard.sort_by_key(|o| (o.entity_id, o.rep_identity));
    shard
}

/// Rebuild each occurrence of `rep` as a standalone flat [`MeshData`] from the
/// shared source registry (source-coords geometry placed at the occurrence's world
/// transform, post-RTC) — geometrically equal to the flat baked occurrence (same
/// world triangles). The source is registered by `ensure_shared_mapped_source` on
/// the don't-bake path, so it is present here; a missing/degenerate source (empty
/// mesh or a per-element CSG-budget trip that skipped the cache insert) is the only
/// drop, mirroring the native orphan recovery.
fn recover_flat(
    rep: u128,
    occs: &[RawInstanceOccurrence],
    mapped_item_cache: &SharedMappedItemCache,
    rtc: [f64; 3],
    out: &mut Vec<MeshData>,
) {
    // Mapped rep_identity is the RepresentationMap source id (always < 2^32).
    let source_id = rep as u32;
    let source = mapped_item_cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&source_id)
        .cloned();
    let Some(source) = source else {
        return;
    };
    for occ in occs {
        let (positions, normals, indices) =
            bake_source_at_world(&source, &occ.world_transform, rtc);
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

#[cfg(test)]
mod resolve_batch_occurrences_tests {
    //! Pins the `(occs.len() + 1) >= min_occurrences` instancing-threshold gate at
    //! its exact boundary. `occs` holds only the don't-bake PLACEHOLDER occurrences
    //! for a rep group — the batch-local template itself is a separate materialized
    //! mesh, counted once elsewhere (`batch.rs`'s `counts` accumulation: 1 per
    //! candidate template + 1 per kept shard occurrence, see lines ~826-850). So the
    //! `+ 1` here reproduces that template's count so this gate agrees with the
    //! batch's own tally instead of undercounting by one. A group is kept (routed to
    //! the instanced shard) exactly when template + placeholders clears
    //! `min_occurrences`; otherwise every placeholder recovers flat.
    //!
    //! With no source registered in `mapped_item_cache`, `recover_flat` no-ops
    //! (`Some(source)` fails) and contributes nothing to `shard` either way, so
    //! `shard.len()` alone distinguishes kept (== occs.len()) from not-kept (== 0)
    //! without needing real bakeable geometry.
    use super::*;
    use std::sync::{Arc, Mutex};

    const MIN_OCCURRENCES: usize = 4;
    const REP: u128 = 42;

    fn make_occ(express_id: u32) -> RawInstanceOccurrence {
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
        }
    }

    fn empty_cache() -> SharedMappedItemCache {
        Arc::new(Mutex::new(FxHashMap::default()))
    }

    /// Runs `resolve_batch_occurrences` with a single shard-eligible rep group of
    /// `occ_count` placeholder occurrences and returns the resulting shard length —
    /// `occ_count` when the group is kept, `0` when it is recovered flat instead.
    fn shard_len_for(occ_count: u32) -> usize {
        let raw: Vec<RawInstanceOccurrence> = (0..occ_count).map(make_occ).collect();
        let mut template_by_rep = FxHashMap::default();
        template_by_rep.insert(REP, TemplateInfo { eligible: true });
        let mut recovered_flats = Vec::new();
        let shard = resolve_batch_occurrences(
            raw,
            &template_by_rep,
            &empty_cache(),
            [0.0, 0.0, 0.0],
            MIN_OCCURRENCES,
            &mut recovered_flats,
        );
        shard.len()
    }

    #[test]
    fn one_below_threshold_recovers_flat_not_shard() {
        // occs.len() + 1 == MIN_OCCURRENCES - 1: must NOT be kept.
        let occ_count = (MIN_OCCURRENCES - 2) as u32;
        assert_eq!(shard_len_for(occ_count), 0);
    }

    #[test]
    fn exactly_at_threshold_is_kept() {
        // occs.len() + 1 == MIN_OCCURRENCES: the `>=` boundary, must be kept.
        let occ_count = (MIN_OCCURRENCES - 1) as u32;
        assert_eq!(shard_len_for(occ_count), occ_count as usize);
    }

    #[test]
    fn one_above_threshold_is_kept() {
        // occs.len() + 1 == MIN_OCCURRENCES + 1: comfortably kept.
        let occ_count = MIN_OCCURRENCES as u32;
        assert_eq!(shard_len_for(occ_count), occ_count as usize);
    }
}
