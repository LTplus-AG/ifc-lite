// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! C4-11a (#7782): content installation and cleanup share derived-cache lifetime.
//! Source bytes are a separate input tier: workers install index/columns before
//! bytes, CLI installs bytes before prepass. Neither order may erase that input.
//! Pending sharded finishes belong to the next finalize transaction, which alone
//! consumes them. Cleanup explicitly abandons any unfinished transaction.
use super::IfcAPI;
use std::sync::{Mutex, PoisonError};

fn discard<T>(slot: &Mutex<Option<T>>) {
    slot.lock().unwrap_or_else(PoisonError::into_inner).take();
}

impl IfcAPI {
    /// Start a new prepass or external index install, before fallible work or
    /// streaming callbacks. A failed attempt must not leave the old file usable.
    pub(super) fn begin_content_install(&self) {
        self.clear_content_derived();
        self.reset_pipeline_diagnostics();
    }

    /// Drop derived state, including the old index, and expire owned production
    /// snapshots. Preserve source input, pending finalize input and user settings.
    /// Lazy batch index construction is NOT a new-content install: the caller
    /// already supplied this load's finishes/columns before the first batch.
    pub(super) fn clear_content_derived(&self) {
        self.production_model.invalidate_source();
        self.invalidate_brep_signatures();
        discard(&self.cached_entity_index);
        discard(&self.cached_parts_to_skip);
        discard(&self.cached_material_layer_index);
        discard(&self.cached_referenced_repmaps);
        discard(&self.cached_instantiated_type_ids);
        discard(&self.cached_type_geometry_plan);
        discard(&self.cached_mapped_instance_plan);
        discard(&self.cached_texture_index);
        discard(&self.cached_indexed_colour_maps);
        discard(&self.cached_plane_angle_to_radians);
        discard(&self.cached_geometry_styles);
        discard(&self.style_finishes);
        discard(&self.cached_item_dedup);
        discard(&self.cached_mapped_item);
    }
}
