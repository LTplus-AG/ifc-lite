// SPDX-License-Identifier: MPL-2.0
//! Internal ownership of completed prepass maps. Public ResolvedPrepass fields
//! stay unchanged; completed synchronous passes release snapshots before edits.
use crate::element::{OwnedMeshProductionContext, OwnedMeshProductionData, ProductionModel};
use crate::prepass::ResolvedPrepass;
use crate::style::{FullIndexedColourMap, GeometryStyleInfo};
use ifc_lite_geometry::ResolvedTextureMap;
use rustc_hash::FxHashMap;
use std::{cell::RefCell, sync::{Arc, atomic::{AtomicUsize, Ordering}}};

type TextureIndex = FxHashMap<u32, ResolvedTextureMap>;
type Cached = (usize, Arc<TextureIndex>, Arc<OwnedMeshProductionContext>);

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
        Self { geometry_style_index: Arc::new(value.geometry_style_index),
            indexed_colour_full: Arc::new(value.indexed_colour_full),
            element_material_colors: Arc::new(value.element_material_colors),
            void_index: Arc::new(value.void_index), element_to_material: value.element_to_material,
            cached: RefCell::new(None) }
    }
}
impl Styles {
    pub(super) fn insert_style(&mut self, id: u32, style: GeometryStyleInfo) {
        self.cached.get_mut().take();
        // No snapshot escapes the synchronous appearance evaluator. Release
        // its cached context before editing, so authoring never clones a map.
        Arc::get_mut(&mut self.geometry_style_index)
            .expect("completed appearance passes release their style snapshot").insert(id, style);
    }
    pub(super) fn snapshot(&self, model: &ProductionModel, textures: &Arc<TextureIndex>)
        -> Arc<OwnedMeshProductionContext> {
        model.snapshot(OwnedMeshProductionData {
            void_index: Arc::clone(&self.void_index),
            geometry_style_index: Arc::clone(&self.geometry_style_index),
            indexed_colour_full: Arc::clone(&self.indexed_colour_full),
            element_material_colors: Arc::clone(&self.element_material_colors),
            texture_index: Arc::clone(textures), site_local_rotation: None,
        })
    }
    pub(super) fn context(&self, model: &ProductionModel, source: usize,
        textures: &Arc<TextureIndex>) -> Arc<OwnedMeshProductionContext> {
        let mut cached = self.cached.borrow_mut();
        if let Some((owner, existing_textures, context)) = cached.as_ref() {
            // Arc equality is only a cache reuse check. Source authority and
            // snapshot identity come from the actual model, never an address.
            if *owner == source && Arc::ptr_eq(existing_textures, textures)
                && context.validate_source().is_ok() { return Arc::clone(context); }
        }
        let context = self.snapshot(model, textures);
        *cached = Some((source, Arc::clone(textures), Arc::clone(&context)));
        context
    }
}

pub(super) fn source_identity() -> usize {
    static NEXT: AtomicUsize = AtomicUsize::new(1);
    NEXT.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
        .expect("appearance source identity exhausted")
}
