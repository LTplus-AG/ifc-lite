// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Content-scoped browser router caches. No scheduling or instancing policy.
use crate::api::IfcAPI;
use ifc_lite_geometry::{GeometryRouter, SharedMappedItemCache};

impl IfcAPI {
    pub(super) fn arm_batch_caches(&self, router: &mut GeometryRouter) -> SharedMappedItemCache {
        // Arm content-dedup against the per-worker shared cache so byte-identical
        // geometry (e.g. Tekla parts the exporter failed to share via
        // IfcMappedItem) is meshed ONCE across batches, not once per batch.
        {
            let mut slot = self
                .cached_item_dedup
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let cache = slot
                .get_or_insert_with(GeometryRouter::new_dedup_cache)
                .clone();
            router.enable_content_dedup_shared(cache);
        }

        // Arm the shared IfcMappedItem source cache (#1623) against the per-worker
        // cache so a RepresentationMap source shared across owning elements is
        // meshed ONCE across batches, not once per batch. Held on the IfcApi like
        // the item-dedup cache above (one per worker session). Keep a clone for the
        // Phase 3 don't-bake finalize below (sub-threshold occurrences recover flat
        // from this registry).
        let mapped_item_cache = {
            let mut slot = self
                .cached_mapped_item
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let cache = slot
                .get_or_insert_with(GeometryRouter::new_mapped_item_cache)
                .clone();
            router.enable_shared_mapped_item_cache(cache.clone());
            cache
        };

        let cache = self.cached_brep_signatures.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get_or_insert_with(GeometryRouter::new_brep_signature_cache).clone();
        router.enable_shared_brep_signature_cache(cache);
        mapped_item_cache
    }

    pub(crate) fn invalidate_brep_signatures(&self) {
        self.cached_brep_signatures.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner).take();
    }
}
