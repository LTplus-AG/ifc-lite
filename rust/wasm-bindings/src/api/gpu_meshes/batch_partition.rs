// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The routing rules `batch.rs` applies to a produced batch: which meshes may
//! ride the instanced shard, how per-batch repetition is tallied, and the
//! prepass style-colour wire decode.
//!
//! Split out of `batch.rs` because these are the parts of it that are decidable
//! without a file, a decoder or a JS clock — everything else there needs the
//! whole producer. Keeping them here also means the shard-template eligibility
//! check and the partition's candidate gate are ONE function rather than two
//! copies of the same three conditions in the same file: they must agree (a
//! mesh the partition sends to the shard but the template pass judged
//! ineligible has nothing to instance against), and two copies is how they stop
//! agreeing.

use ifc_lite_processing::MeshData;
use rustc_hash::FxHashMap;

/// Opaque-alpha cutoff for the instanced-only partition. Mirrors the renderer's
/// `OPAQUE_ALPHA_CUTOFF` (overlay-routing.ts) so the wasm partition and the
/// renderer's flat opaque/transparent split agree: alpha >= this is opaque.
pub(super) const INSTANCED_ALPHA_CUTOFF: f32 = 0.99;

/// Minimum per-batch occurrence count for a rep_identity group to be GPU-instanced.
/// Below this, geometry rides the flat (consolidated, frustum-culled) path instead —
/// one drawIndexed per template only pays off when amortized over many instances, and
/// the saved upload/memory is negligible at low counts. Tuned for the draw-vs-memory
/// tradeoff: 8 kills the singleton/low-count tail that defeated flat consolidation
/// (the orbit-FPS regression) while leaving genuinely-repeated families (mullions,
/// fasteners, identical steel parts — co-located by affinity routing, so dozens-to-
/// hundreds per batch) instanced. Counting is PER-BATCH; a globally-repeated geometry
/// thinly split across batches may fall below the gate and render flat — a benign
/// missed optimization, never a correctness/FPS regression (flat IS the fast path for
/// low counts). Lower to 4 if a large model's memory regresses; raise to 16 if orbit
/// still drags.
pub(super) const INSTANCE_MIN_OCCURRENCES: u32 = 8;

/// The VALUE above is tunable -- its own doc invites 4 or 16. The FLOOR is not:
/// `INSTANCE_MIN_OCCURRENCES` is also handed to `collate_and_encode` as
/// `min_group`, and at 1 every singleton becomes its own one-instance template,
/// which is precisely the orbit-FPS regression the gate exists to undo.
///
/// A `const` assertion rather than a `#[test]`: the operand is a compile-time
/// constant, so a runtime `assert!` is decided by the compiler and can never
/// fail when the suite runs -- clippy rejects it as `assertions_on_constants`,
/// correctly. Placed HERE rather than in the cfg(test) sibling so it gates
/// every build including the shipped wasm, not only the ones that compile tests.
const _: () = assert!(
    INSTANCE_MIN_OCCURRENCES >= 2,
    "a gate below 2 instances singletons: O(unique-geometry) draws per frame in place of the flat path's few consolidated ones"
);

/// May this mesh ride the instanced shard at all?
///
/// Transparent (alpha below the cutoff), textured (the instanced pipeline has
/// no UV slot) and type-product geometry (`geometry_class` 1 = orphan type map,
/// 2 = instanced type map) must stay on the flat pipelines for correct
/// blending, texturing and Model/Types view-mode gating. This is a gate on the
/// mesh's own properties only — repetition is counted separately, by
/// [`meets_instance_threshold`].
pub(super) fn is_instancing_candidate(mesh: &MeshData) -> bool {
    mesh.color[3] >= INSTANCED_ALPHA_CUTOFF && mesh.texture.is_none() && mesh.geometry_class == 0
}

/// The rep-identity key this mesh contributes to the per-batch tally, or `None`
/// when it contributes nothing.
///
/// A mesh with no instance metadata, or one whose metadata says
/// `instanceable == false` (void-cut walls, multi-item merges), can never be
/// instanced — so it must not inflate another mesh's group count either, or a
/// group of seven real occurrences plus one un-instanceable lookalike would
/// clear a gate of eight and send seven meshes to a template the eighth cannot
/// share.
pub(super) fn tallyable_rep(mesh: &MeshData) -> Option<u128> {
    mesh.instance
        .as_ref()
        .filter(|im| im.instanceable)
        .map(|im| im.rep_identity)
}

/// Does this mesh's rep group clear the per-batch repetition gate?
///
/// Reads the tally through the SAME key that filled it ([`tallyable_rep`]), so
/// the count consulted here cannot be one a different predicate wrote. A rep
/// absent from the tally counts as zero, never as "unknown, allow".
pub(super) fn meets_instance_threshold(mesh: &MeshData, counts: &FxHashMap<u128, u32>) -> bool {
    tallyable_rep(mesh)
        .is_some_and(|rep| counts.get(&rep).copied().unwrap_or(0) >= INSTANCE_MIN_OCCURRENCES)
}

/// Decode the prepass's parallel style wire — `style_ids[i]` paired with the
/// four bytes at `style_colors[i * 4 ..]` — into a 0..1 RGBA map.
///
/// The wire pair is authored by a separate prepass and can arrive short (an
/// older or truncated producer); a style whose four bytes are not all present
/// is dropped rather than read past the end or filled with garbage, so a short
/// tail costs those styles their colour and nothing else.
pub(super) fn style_colors_from_wire(
    style_ids: &[u32],
    style_colors: &[u8],
) -> FxHashMap<u32, [f32; 4]> {
    let mut colors: FxHashMap<u32, [f32; 4]> =
        FxHashMap::with_capacity_and_hasher(style_ids.len(), Default::default());
    for (i, &style_id) in style_ids.iter().enumerate() {
        let base = i * 4;
        if base + 3 < style_colors.len() {
            colors.insert(
                style_id,
                [
                    style_colors[base] as f32 / 255.0,
                    style_colors[base + 1] as f32 / 255.0,
                    style_colors[base + 2] as f32 / 255.0,
                    style_colors[base + 3] as f32 / 255.0,
                ],
            );
        }
    }
    colors
}

#[cfg(test)]
#[path = "batch_partition_tests.rs"]
mod tests;
