// SPDX-License-Identifier: MPL-2.0
//! Explicit retained source binding; the ordinary viewer load is unchanged.
use super::{IfcAPI, retained_product::RetainedBrowserProduct};
use ifc_lite_core::{IfcType, SourceBundle};
use ifc_lite_geometry::{MaterialLayerIndex, TessellationQuality};
use ifc_lite_processing::element::{ElementJobKind, OwnedMeshProductionContext, OwnedMeshProductionData, ProductionModel};
use rustc_hash::FxHashMap;
use std::sync::Arc;
use wasm_bindgen::prelude::*;

#[derive(Clone)]
pub(super) struct ProductSetup {
    pub ifc_type: IfcType,
    pub kind: ElementJobKind,
}
pub(super) struct RetainedModelData {
    pub source: Arc<SourceBundle>,
    pub context: Arc<OwnedMeshProductionContext>,
    pub colors: FxHashMap<u32, [f32; 4]>,
    pub jobs: FxHashMap<u32, ProductSetup>,
    pub layers: Option<Arc<MaterialLayerIndex>>,
    pub quality: TessellationQuality,
    pub skip_small_cuts: bool,
}

/// One immutable source plus the browser policy selected at binding time.
#[wasm_bindgen]
pub struct RetainedBrowserModel {
    data: Arc<RetainedModelData>,
    model: ProductionModel,
}
#[wasm_bindgen]
impl RetainedBrowserModel {
    #[wasm_bindgen(js_name = admitProduct)]
    pub fn admit_product(&self, product_id: u32) -> Result<RetainedBrowserProduct, JsValue> {
        self.data.context.validate_source().map_err(failure)?;
        if !self.data.jobs.contains_key(&product_id) {
            return Err(failure("entity is not a canonical browser product job"));
        }
        RetainedBrowserProduct::admit(self.data.clone(), product_id)
    }
    #[wasm_bindgen(js_name = invalidateSource)]
    pub fn invalidate_source(&self) { self.model.invalidate_source(); }
}

#[wasm_bindgen]
impl IfcAPI {
    /// Opt-in independent source buffer. No Worker or numerical SDK is started.
    #[wasm_bindgen(js_name = bindRetainedModel)]
    pub fn bind_retained_model(&self, content: Vec<u8>) -> Result<RetainedBrowserModel, JsValue> {
        let source = SourceBundle::columnar(Arc::new(content)).map_err(failure)?;
        let content = source.bytes();
        let mut decoder = source.decoder().with_strict_reals();
        let prepass = super::styling::combined_pre_pass(content, &mut decoder);
        let palettes = self.get_or_build_indexed_colour_maps(content, &mut decoder);
        let textures = self.get_or_build_texture_index(content, &mut decoder);
        let layers = (!self.merge_layers()).then(|| self.get_or_build_material_layer_index(content, &mut decoder));
        let skipped = self.merge_layers().then(|| self.get_or_build_parts_to_skip(content, &mut decoder));
        let mut jobs = FxHashMap::default();
        for (id, _, _, ifc_type) in prepass.simple_jobs.iter().chain(&prepass.complex_jobs) {
            if skipped.as_ref().is_some_and(|ids| ids.contains(id)) { continue; }
            let entity = decoder.decode_by_id(*id).map_err(failure)?;
            let Some(kind) = self.canonical_product_job_kind(content, &entity, ifc_type, &mut decoder) else { continue };
            jobs.insert(*id, ProductSetup { ifc_type: ifc_type.clone(), kind });
        }
        let resolved = prepass.resolved;
        let colors = resolved.geometry_style_index.iter().map(|(&id, style)| (id, style.color)).collect();
        let model = ProductionModel::from_source(source.clone());
        let context = model.snapshot(OwnedMeshProductionData {
            void_index: Arc::new(resolved.void_index),
            geometry_style_index: Arc::new(resolved.geometry_style_index),
            indexed_colour_full: palettes.maps.clone(),
            element_material_colors: Arc::new(resolved.element_material_colors),
            texture_index: textures, site_local_rotation: None,
        });
        drop(decoder);
        Ok(RetainedBrowserModel {
            model,
            data: Arc::new(RetainedModelData { source, context, colors, jobs, layers,
                quality: self.tessellation_quality(), skip_small_cuts: self.skip_small_cuts() }),
        })
    }
}
pub(super) fn failure(error: impl std::fmt::Display) -> JsValue { JsValue::from_str(&error.to_string()) }
