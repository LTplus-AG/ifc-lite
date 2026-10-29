// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! C4-11b (#7782): input and derived content lifetimes, separate from settings.
use super::IndexedColourCache;
use ifc_lite_core::ColumnarEntityIndex;
use std::sync::{Arc, Mutex, PoisonError};

/// One lock covers lookup, lazy construction and publication. Other slots may
/// be read by a builder, but it must never recursively initialize its own slot.
pub(super) struct LazySlot<T>(Mutex<Option<T>>);

impl<T> Default for LazySlot<T> {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

impl<T: Clone> LazySlot<T> {
    pub(super) fn get_or_init(&self, build: impl FnOnce() -> T) -> T {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get_or_insert_with(build)
            .clone()
    }
}

// Keep explicit install/take/poison-recovery operations available at boundaries.
impl<T> std::ops::Deref for LazySlot<T> {
    type Target = Mutex<Option<T>>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

macro_rules! content_slots {
    ($($name:ident: $ty:ty),* $(,)?) => {
        #[derive(Default)]
        pub(super) struct ContentSlots { $(pub(super) $name: LazySlot<$ty>,)* }
        impl ContentSlots {
            pub(super) fn clear(&self) { $(super::content_lifetime::discard(&self.$name);)* }
        }
    };
}

type GeometryStyles = (
    usize,
    u32,
    u32,
    Arc<(
        rustc_hash::FxHashMap<u32, [f32; 4]>,
        Arc<rustc_hash::FxHashMap<u32, ifc_lite_processing::style::GeometryStyleInfo>>,
    )>,
);
type StyleFinishes = (
    (usize, u32, u32),
    Arc<rustc_hash::FxHashMap<u32, ifc_lite_processing::style::SpecularMaterial>>,
);

content_slots! {
    cached_entity_index: Arc<ColumnarEntityIndex>,
    cached_brep_signatures: ifc_lite_geometry::SharedBrepSignatureCache,
    cached_item_dedup: ifc_lite_geometry::ItemDedupCache,
    cached_mapped_item: ifc_lite_geometry::SharedMappedItemCache,
    cached_parts_to_skip: Arc<rustc_hash::FxHashSet<u32>>,
    cached_material_layer_index: Arc<ifc_lite_geometry::MaterialLayerIndex>,
    cached_referenced_repmaps: Arc<rustc_hash::FxHashSet<u32>>,
    cached_instantiated_type_ids: Arc<rustc_hash::FxHashSet<u32>>,
    cached_type_geometry_plan: Arc<ifc_lite_processing::discovery::TypeGeometryPlan>,
    cached_mapped_instance_plan: ifc_lite_geometry::MappedInstancePlan,
    cached_texture_index: Arc<rustc_hash::FxHashMap<u32, ifc_lite_geometry::ResolvedTextureMap>>,
    cached_indexed_colour_maps: Arc<IndexedColourCache>,
    cached_plane_angle_to_radians: f64,
    cached_geometry_styles: GeometryStyles,
    style_finishes: StyleFinishes,
}

/// Inputs survive begin_content_install: CLI installs bytes before prepass;
/// workers install index/columns before bytes. Pending finishes are consumed by
/// finalize, or explicitly abandoned by clearPrePassCache. ProductionModel keeps
/// its identity while each derived reset expires all snapshots from its epoch.
#[derive(Default)]
pub(super) struct ContentState {
    slots: ContentSlots,
    pub(super) cached_source_bytes: std::sync::Mutex<Option<std::sync::Arc<Vec<u8>>>>,
    pub(super) pending_geometry_finishes: std::sync::Mutex<
        Option<rustc_hash::FxHashMap<u32, ifc_lite_processing::style::SpecularMaterial>>,
    >,
    pub(super) production_model: ifc_lite_processing::element::ProductionModel,
}

impl std::ops::Deref for ContentState {
    type Target = ContentSlots;
    fn deref(&self) -> &Self::Target {
        &self.slots
    }
}

impl ContentState {
    pub(super) fn clear_derived(&self) {
        self.production_model.invalidate_source();
        self.slots.clear();
    }
}

#[cfg(test)]
#[path = "c4_11b_slots_tests.rs"]
mod tests;
