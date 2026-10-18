// SPDX-License-Identifier: MPL-2.0
//! Once-per-worker source admission; legacy independent setters stay explicit.
use super::{gpu_meshes::StyleMaps, IfcAPI};
use ifc_lite_core::{EntityDecoder, SourceBundle};
use ifc_lite_processing::{style::GeometryStyleInfo, ProductionModel};
use std::sync::{Arc, Mutex};
use wasm_bindgen::prelude::*;

type StyleRevision = (Vec<u32>, Vec<u8>, StyleMaps);
pub(super) struct CoherentLoad {
    pub source: Arc<SourceBundle>,
    pub model: ProductionModel,
    styles: Mutex<Option<StyleRevision>>,
}
impl CoherentLoad {
    pub fn styles(&self, ids: &[u32], colors: &[u8]) -> StyleMaps {
        let mut slot = self
            .styles
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((old_ids, old_colors, maps)) = slot.as_ref() {
            if old_ids == ids && old_colors == colors {
                return Arc::clone(maps);
            }
        }
        let colors_map = super::gpu_meshes::batch_partition::style_colors_from_wire(ids, colors);
        let index = colors_map
            .iter()
            .map(|(&id, &c)| (id, GeometryStyleInfo::from_color(c)))
            .collect();
        let maps = Arc::new((colors_map, Arc::new(index)));
        *slot = Some((ids.to_vec(), colors.to_vec(), Arc::clone(&maps)));
        maps
    }
}
impl IfcAPI {
    pub(super) fn decoder_for_batch<'a>(
        &self,
        content: &'a [u8],
        coherent_load: Option<&'a Arc<CoherentLoad>>,
    ) -> EntityDecoder<'a> {
        // Reuse the cached Arc<EntityIndex> across calls so we don't
        // re-clone the 14 M-entry HashMap on every batch. On streaming
        // paths this turns ~36 calls/worker into 1 build + 35 Arc::clone()
        // (a single refcount bump) instead of 36 full HashMap clones.
        //
        // If the cache is empty (which happens on every process worker
        // because they're separate WASM realms from the pre-pass worker),
        // build once here and store under Arc so subsequent calls hit
        // the fast path.
        if let Some(load) = coherent_load {
            load.source.decoder()
        } else {
            let entity_index_arc: std::sync::Arc<ifc_lite_core::ColumnarEntityIndex> = {
                // Mutex briefly held: peek at cache, build-if-empty, clone Arc.
                // The clone is what gets handed to rayon — no lock contention
                // on the per-job hot path that follows. Poison panics here
                // (an earlier panic-with-lock-held has corrupted the cache).
                let mut slot = self
                    .cached_entity_index
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Some(existing) = slot.as_ref() {
                    std::sync::Arc::clone(existing)
                } else {
                    // No setEntityIndex was delivered (non-streaming path): scan the
                    // file straight into sorted columns, skipping the FxHashMap.
                    let built =
                        std::sync::Arc::new(super::gpu_meshes::scan_columnar_index(content));
                    *slot = Some(std::sync::Arc::clone(&built));
                    built
                }
            };
            EntityDecoder::with_arc_columnar_index(content, entity_index_arc)
        }
        .with_strict_reals() // #7678
    }
    pub(super) fn begin_source_load(&self) {
        if self.invalidate_coherent_source() {self.clear_source_caches();}
        self.reset_pipeline_diagnostics();
    }
    pub(super) fn invalidate_coherent_source(&self) -> bool {
        if let Some(load) = self
            .coherent_source
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            load.model.invalidate_source();
            true
        } else {
            false
        }
    }
    /// Source-derived maps and numerical templates share the established load
    /// boundary. Configuration-only setters retain their narrower invalidation.
    pub(super) fn clear_source_caches(&self) {
        self.cached_parts_to_skip
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.cached_material_layer_index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.cached_referenced_repmaps
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.cached_instantiated_type_ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.cached_mapped_instance_plan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.cached_texture_index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.cached_indexed_colour_maps
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.cached_plane_angle_to_radians
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.cached_geometry_styles
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.cached_item_dedup
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.cached_mapped_item
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
    }
    pub(super) fn coherent_source_for(&self, bytes: &[u8]) -> Option<Arc<CoherentLoad>> {
        self.coherent_source
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .filter(|load| {
                load.source.bytes().as_ptr() == bytes.as_ptr()
                    && load.source.bytes().len() == bytes.len()
            })
            .cloned()
    }
}
#[wasm_bindgen]
impl IfcAPI {
    /// Admit this worker's installed bytes/index pair once before geometry.
    /// Full canonical span validation is required across worker realms. This
    /// does not authenticate arbitrary later data-taking compatibility calls.
    #[wasm_bindgen(js_name = bindSourceModel)]
    pub fn bind_source_model(&self) -> Result<(), JsValue> {
        self.bind_source_model_inner()
            .map_err(|error| JsValue::from_str(&error))
    }
}
impl IfcAPI {
    pub(super) fn bind_source_model_inner(&self) -> Result<(), String> {
        let mut slot = self
            .coherent_source
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if slot.is_some() {
            return Ok(());
        }
        let bytes = self
            .cached_source_bytes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .ok_or("source bytes are not installed")?;
        let index = self
            .cached_entity_index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let source = match index {
            Some(index) => {
                SourceBundle::with_columnar_index(bytes, index).map_err(|e| e.to_string())?
            }
            None => SourceBundle::columnar(bytes).map_err(|e| e.to_string())?,
        };
        let model = ProductionModel::from_source(Arc::clone(&source));
        *slot = Some(Arc::new(CoherentLoad {
            source,
            model,
            styles: Mutex::new(None),
        }));
        Ok(())
    }
}
