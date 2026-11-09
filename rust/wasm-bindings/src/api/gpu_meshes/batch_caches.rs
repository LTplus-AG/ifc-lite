// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Content-scoped browser router caches. No scheduling or instancing policy.
use crate::api::IfcAPI;
use ifc_lite_geometry::GeometryRouter;
use ifc_lite_processing::execution::RouterCaches;

impl IfcAPI {
    pub(super) fn batch_caches(&self) -> RouterCaches {
        let items = self.content.cached_item_dedup.get_or_init(GeometryRouter::new_dedup_cache);
        let mapped_item_cache = self.content.cached_mapped_item.get_or_init(GeometryRouter::new_mapped_item_cache);
        let cache = self.content.cached_brep_signatures.get_or_init(GeometryRouter::new_brep_signature_cache);
        RouterCaches { items, brep_signatures: cache, mapped_items: mapped_item_cache }
    }

    pub(crate) fn invalidate_brep_signatures(&self) {
        self.content.cached_brep_signatures
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
    }
}
