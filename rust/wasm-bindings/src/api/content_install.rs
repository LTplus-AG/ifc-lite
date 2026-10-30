// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Public content installation and cleanup boundaries for worker prepass inputs.
use super::IfcAPI;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Clear the cached entity index (call between loads when reusing
    /// the same `IfcAPI` instance — e.g. the parser worker keeps one
    /// `IfcAPI` alive across multiple `parse` requests).
    ///
    /// Recovers a poisoned cache Mutex instead of panicking; see `mod_tests.rs`.
    #[wasm_bindgen(js_name = clearPrePassCache)]
    pub fn clear_pre_pass_cache(&self) {
        self.clear_content_derived();
        self.content.cached_source_bytes.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        self.clear_style_finishes();
        // Keep diagnostics readable after the JS wrapper's finally cleanup.
    }

    /// Install the pre-computed set of `IfcRepresentationMap` ids referenced by
    /// an `IfcMappedItem` (issue #957), so the worker's first type-product batch
    /// skips the full-file walk once [`Self::set_instantiated_type_ids`] is also installed. The streaming pre-pass built
    /// the same set once from its `IfcMappedItem` spans and ships the
    /// id list here — bit-identical to what each worker would compute, since a
    /// set's membership is order-invariant and consumers only call `.contains`.
    ///
    /// Installed AFTER `setEntityIndex` (which clears this cache on content
    /// swap), so the injected value survives. When this setter is never called
    /// (native path, non-streaming callers), the lazy build path is unchanged.
    #[wasm_bindgen(js_name = setReferencedRepmaps)]
    pub fn set_referenced_repmaps(&self, ids: &[u32]) {
        self.content.cached_type_geometry_plan.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        let set: rustc_hash::FxHashSet<u32> = ids.iter().copied().collect();
        let mut slot = self.content.cached_referenced_repmaps
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = Some(std::sync::Arc::new(set));
    }

    /// Install the pre-computed set of type ids that an `IfcRelDefinesByType`
    /// instantiates (#957 follow-up), so the worker's first type-product batch
    /// skips the full-file walk once both precomputed sets are installed. Same injection contract as [`Self::set_referenced_repmaps`].
    #[wasm_bindgen(js_name = setInstantiatedTypeIds)]
    pub fn set_instantiated_type_ids(&self, ids: &[u32]) {
        self.content.cached_type_geometry_plan.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        let set: rustc_hash::FxHashSet<u32> = ids.iter().copied().collect();
        let mut slot = self.content.cached_instantiated_type_ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = Some(std::sync::Arc::new(set));
    }

    /// Install the pre-computed #1623 Phase 3 don't-bake plan: the flat list of
    /// `IfcRepresentationMap` ids that an `IfcMappedItem` instantiates >= 2 times.
    /// The streaming pre-pass tallies it in the SAME scan that builds the referenced-
    /// repmap set and ships the id
    /// list here. The batch path arms its router with it (batch-local template mode),
    /// so a repeated single-solid mapped source materializes ONCE per batch and the
    /// rest ride as instances in the IFNS shard.
    ///
    /// Same injection contract as [`Self::set_referenced_repmaps`]: installed after
    /// `setEntityIndex` (which clears it on content swap), and a no-op absence leaves
    /// the batch path materializing every occurrence (byte-identical). Each id is
    /// stored as `(2, id)` — the batch-local router only needs the eligibility set
    /// (count >= 2); the min-id template slot is unused in batch-local mode.
    #[wasm_bindgen(js_name = setMappedInstancePlan)]
    pub fn set_mapped_instance_plan(&self, source_ids: &[u32]) {
        if source_ids.is_empty() {
            // Nothing repeated ⇒ leave the plan unset so the router never arms.
            return;
        }
        let plan: rustc_hash::FxHashMap<u32, (u32, u32)> =
            source_ids.iter().map(|&id| (id, (2u32, id))).collect();
        let mut slot = self.content.cached_mapped_instance_plan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = Some(std::sync::Arc::new(plan));
    }

    /// Install the pre-computed [`ifc_lite_geometry::MaterialLayerIndex`] (#563)
    /// from its flat SoA encoding, so the worker's first batch skips the
    /// per-worker [`Self::get_or_build_material_layer_index`] full-file decode
    /// scan (the dominant first-batch cost on layered architectural models,
    /// which run this on the DEFAULT view). The streaming pre-pass built the
    /// index once from the `IfcRelAssociatesMaterial` spans it already scanned
    /// (`MaterialLayerIndex::from_spans`) and flat-encoded it here; the flat
    /// encoding round-trips bit-for-bit (proven in `material_layer_index` tests),
    /// so the injected index equals each worker's `from_content` result.
    ///
    /// Same injection contract as [`Self::set_referenced_repmaps`]: installed
    /// after `setEntityIndex`, and a no-op absence leaves the lazy build intact.
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = setMaterialLayerIndex)]
    pub fn set_material_layer_index(
        &self,
        element_ids: &[u32],
        axis: &[u32],
        layer_counts: &[u32],
        direction_sense: &[f64],
        offset: &[f64],
        layer_material_ids: &[u32],
        layer_thicknesses: &[f64],
    ) {
        // A malformed buffer is refused (#7675). Clearing the slot (never
        // keeping an earlier load's index) leaves the per-worker lazy build in
        // charge, which is correct, just slower.
        let index = ifc_lite_geometry::MaterialLayerIndex::from_flat(
            element_ids,
            axis,
            layer_counts,
            direction_sense,
            offset,
            layer_material_ids,
            layer_thicknesses,
        );
        let mut slot = self.content.cached_material_layer_index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = index.map(std::sync::Arc::new);
    }
}
