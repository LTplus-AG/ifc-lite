// SPDX-License-Identifier: MPL-2.0
//! Appearance ownership of the completed prepass maps. Every canonical pass of
//! one session shares one immutable snapshot; a style edit releases it first,
//! so authoring edits the maps in place and never clones one.
use crate::element::{OwnedMeshProductionContext, OwnedMeshProductionData, ProductionModel};
use crate::prepass::ResolvedPrepass;
use crate::style::{FullIndexedColourMap, GeometryStyleInfo};
use ifc_lite_geometry::ResolvedTextureMap;
use rustc_hash::FxHashMap;
use std::{cell::RefCell, sync::Arc};

type TextureIndex = FxHashMap<u32, ResolvedTextureMap>;
type Cached = (Arc<TextureIndex>, Arc<OwnedMeshProductionContext>);

/// The appearance subset of a [`ResolvedPrepass`]. Read the maps freely; edit
/// styles only through [`Styles::insert_style`], which retires the snapshot.
#[derive(Default)]
pub(super) struct Styles {
    pub geometry_style_index: Arc<FxHashMap<u32, GeometryStyleInfo>>,
    pub indexed_colour_full: Arc<FxHashMap<u32, FullIndexedColourMap>>,
    pub element_material_colors: Arc<FxHashMap<u32, Vec<[f32; 4]>>>,
    pub void_index: Arc<FxHashMap<u32, Vec<u32>>>,
    pub element_to_material: FxHashMap<u32, u32>,
    cached: RefCell<Option<Cached>>,
}

impl From<ResolvedPrepass> for Styles {
    fn from(value: ResolvedPrepass) -> Self {
        Self {
            geometry_style_index: Arc::new(value.geometry_style_index),
            indexed_colour_full: Arc::new(value.indexed_colour_full),
            element_material_colors: Arc::new(value.element_material_colors),
            void_index: Arc::new(value.void_index),
            element_to_material: value.element_to_material,
            cached: RefCell::new(None),
        }
    }
}

impl Styles {
    pub(super) fn insert_style(&mut self, id: u32, style: GeometryStyleInfo) {
        // No snapshot escapes a synchronous canonical pass, so releasing the
        // cached one leaves the map unshared and `make_mut` edits in place.
        self.cached.get_mut().take();
        Arc::make_mut(&mut self.geometry_style_index).insert(id, style);
    }

    /// A fresh snapshot of these maps with `textures`, outside the cache: a
    /// one-off target texture set must not displace the session's own.
    pub(super) fn snapshot(
        &self,
        model: &ProductionModel,
        textures: &Arc<TextureIndex>,
    ) -> Arc<OwnedMeshProductionContext> {
        model.snapshot(OwnedMeshProductionData {
            void_index: Arc::clone(&self.void_index),
            geometry_style_index: Arc::clone(&self.geometry_style_index),
            indexed_colour_full: Arc::clone(&self.indexed_colour_full),
            element_material_colors: Arc::clone(&self.element_material_colors),
            texture_index: Arc::clone(textures),
            site_local_rotation: None,
        })
    }

    /// The session snapshot for `textures`, reused until a style edit, another
    /// texture set or an explicit source invalidation retires it.
    pub(super) fn context(
        &self,
        model: &ProductionModel,
        textures: &Arc<TextureIndex>,
    ) -> Arc<OwnedMeshProductionContext> {
        let mut cached = self.cached.borrow_mut();
        if let Some((existing, context)) = cached.as_ref() {
            // Address equality only selects the cached texture set. Lifecycle
            // validity comes from the model itself, never from an address.
            if Arc::ptr_eq(existing, textures)
                && model.owns_snapshot(context)
                && context.validate_source().is_ok()
            {
                return Arc::clone(context);
            }
        }
        let context = self.snapshot(model, textures);
        *cached = Some((Arc::clone(textures), Arc::clone(&context)));
        context
    }
}
