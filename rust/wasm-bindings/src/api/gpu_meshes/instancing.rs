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
//!   mapped-item source registry so no geometry is lost. These render flat exactly
//!   as if instancing had never fired (byte-identical world triangles to the flat
//!   baseline) — through the SAME `ifc_lite_processing::recover_occurrences_flat`
//!   the native orphan recovery uses, so the two cannot drift.

use ifc_lite_geometry::SharedMappedItemCache;
use ifc_lite_processing::{recover_occurrences_flat, MeshData, RawInstanceOccurrence};
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
    /// The `IfcRepresentationItem` this occurrence's geometry comes from (#2985);
    /// rides the IFNS shard as the v2 per-instance item id.
    pub geometry_item_id: Option<u32>,
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
                    geometry_item_id: occ.geometry_item_id,
                });
            }
        } else {
            // Recovery lives in `processing` so the browser and native paths cannot
            // drift (see `recover_occurrences_flat`). Its `false` — the group's
            // source missing from the registry — is dropped rather than logged
            // here: `ensure_shared_mapped_source` registers it before any
            // placeholder is emitted on this path, and the wasm build has no
            // tracing sink. The native mirror logs it.
            recover_occurrences_flat(rep, &occs, mapped_item_cache, rtc, recovered_flats);
        }
    }
    // Deterministic shard-instance order (occurrences arrive in job order, already
    // deterministic, but sort defensively so the wire bytes are stable run to run).
    shard.sort_by_key(|o| (o.entity_id, o.rep_identity));
    shard
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
    //! With no source registered in `mapped_item_cache`, `recover_occurrences_flat` no-ops
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
            geometry_item_id: None,
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

    /// #2985. A SUB-THRESHOLD occurrence never reaches the shard, so the wire
    /// format cannot carry its item id — it renders flat and the id has to ride
    /// the recovered `MeshData` instead. This is the half of the gap that needs
    /// no wire change and is therefore the easiest to leave behind: the shard
    /// path could be perfect while every recovered occurrence still reported no
    /// source item, and nothing above would notice, because "no item id" and
    /// "this geometry has no item" look identical to a consumer.
    ///
    /// Needs a REGISTERED source, unlike the threshold tests above: with an
    /// empty cache `recover_occurrences_flat` returns before building any `MeshData`, so the
    /// assertion would be vacuous — zero recovered meshes, zero wrong ids.
    #[test]
    fn a_recovered_flat_occurrence_reports_its_item_id() {
        const ITEM_ID: u32 = 4638;
        const SOURCE_ID: u32 = REP as u32;

        let mut source = ifc_lite_geometry::Mesh::new();
        source.positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        source.normals = vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
        source.indices = vec![0, 1, 2];
        let cache: SharedMappedItemCache = Arc::new(Mutex::new(FxHashMap::default()));
        cache
            .lock()
            .unwrap()
            .insert(SOURCE_ID, std::sync::Arc::new(source));

        let mut occ = make_occ(7);
        occ.geometry_item_id = Some(ITEM_ID);
        let mut template_by_rep = FxHashMap::default();
        // Not eligible ⇒ the group recovers flat rather than riding the shard.
        template_by_rep.insert(REP, TemplateInfo { eligible: false });
        let mut recovered_flats = Vec::new();
        let shard = resolve_batch_occurrences(
            vec![occ],
            &template_by_rep,
            &cache,
            [0.0, 0.0, 0.0],
            MIN_OCCURRENCES,
            &mut recovered_flats,
        );

        assert!(shard.is_empty(), "an ineligible group must not reach the shard");
        assert_eq!(recovered_flats.len(), 1, "the occurrence must be recovered, not dropped");
        assert_eq!(
            recovered_flats[0].geometry_item_id,
            Some(ITEM_ID),
            "the recovered flat mesh lost the item id the occurrence carried"
        );
        // #3199 disjointness: the id is a representation item, never a material.
        assert_eq!(recovered_flats[0].material_id, None);
    }
}
