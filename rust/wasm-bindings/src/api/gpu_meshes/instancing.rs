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
