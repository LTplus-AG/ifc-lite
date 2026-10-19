// SPDX-License-Identifier: MPL-2.0
//! Explicit common-product transactions. Witnesses are held short of final assembly.
use super::{coherent_source::CoherentLoad, IfcAPI};
use ifc_lite_geometry::GeometryRouter;
use ifc_lite_geometry_runtime::browser::{BrowserCancellation, BrowserWorker};
use ifc_lite_processing::element::{ElementJobKind, ElementMeshJob, MeshProductionOptions,
    OwnedMeshProductionContext, OwnedMeshProductionData, RetainedProductExecution, RetainedExecutionError,
    IssuedCommonConstruction};
use std::sync::Arc;
use wasm_bindgen::prelude::*;

/// Explicit independent-lease executor for the shared common-product program.
/// Capture cancellation before calling an async method that borrows this object.
#[wasm_bindgen]
pub struct RetainedBrowserProductExecutor { worker: BrowserWorker }
#[wasm_bindgen]
pub struct RetainedBrowserProductCancellation { domain: BrowserCancellation }
#[wasm_bindgen]
impl RetainedBrowserProductCancellation {
    pub fn cancel(&self) { self.domain.retire(); }
}
#[wasm_bindgen]
impl RetainedBrowserProductExecutor {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<RetainedBrowserProductExecutor, JsValue> {
        Ok(Self {worker:BrowserWorker::new_retained_execution()?})
    }
    pub fn cancellation(&self) -> RetainedBrowserProductCancellation {
        RetainedBrowserProductCancellation {domain:self.worker.cancellation()}
    }
    #[wasm_bindgen(js_name = qualifyNumericalRoutes)]
    pub async fn qualify_numerical_routes(&mut self) -> Result<(), JsValue> { self.worker.qualify().await }
}

/// Owns the canonical load and immutable model snapshot. It accepts a product ID,
/// never an authored source key, caller receipt, raw bytes or numeric worker ID.
#[wasm_bindgen]
pub struct RetainedBrowserProduct {
    load: Arc<CoherentLoad>,
    context: Arc<OwnedMeshProductionContext>,
    product_id: u32,
    router: Option<GeometryRouter>,
    execution: Option<RetainedProductExecution>,
    kind: ElementJobKind,
    element_color: Option<[f32;4]>,
}
#[wasm_bindgen]
impl RetainedBrowserProduct {
    /// Drive the existing shared issue/await/accept loop. This returns an inspection
    /// witness only; unresolved common requirements continue to prohibit output.
    pub async fn execute(&mut self, executor: &mut RetainedBrowserProductExecutor,
        chord_metres: f64, angle_degrees: f64, max_bytes: u32) -> Result<JsValue, JsValue> {
        self.context.validate_source().map_err(failure)?;
        IssuedCommonConstruction::validate_numerical_limits(chord_metres,angle_degrees,max_bytes as usize)
            .map_err(failure)?;
        let router = self.router.take().ok_or_else(|| failure("product transaction already started"))?;
        // Ordinary locals are preserved by Rust's async state machine. There is
        // one decoder for all awaits; no leaks or self-referential wasm object.
        let source = self.load.source.clone();
        let mut decoder = source.decoder().with_strict_reals();
        let unit_scale = decoder.length_unit_scale();
        let angle_scale = decoder.plane_angle_to_radians();
        decoder.seed_unit_scales(unit_scale, angle_scale);
        let entity = decoder.decode_by_id(self.product_id).map_err(failure)?;
        let job = ElementMeshJob {id:self.product_id, ifc_type:entity.ifc_type.clone(), entity:&entity,
            kind:self.kind.clone(), element_color:self.element_color, metadata:None};
        let mut execution = RetainedProductExecution::new(&job, &self.context,
            &MeshProductionOptions::default(), &mut decoder, &router).map_err(failure)?;
        let outcome: Result<(), RetainedExecutionError> = async {
            while let Some(issued) = execution.issue_next(&executor.worker, &mut decoder, &router)? {
                let work = issued.execute_browser(&mut executor.worker, chord_metres, angle_degrees, max_bytes)
                    .await.map_err(|rejected|rejected.reason)?;
                execution.accept(work, &mut decoder, &router).map_err(|rejected|rejected.reason)?;
            }
            Ok(())
        }.await;
        if let Err(primary) = outcome {
            // Resume cleanup in an explicit synchronous owner slice. Cleanup may
            // refuse an expired source; it never replaces the original stop/error.
            if let Err(cleanup) = execution.cancel(&mut decoder, &router) {
                web_sys::console::warn_1(&failure(format!("retained transaction cleanup: {cleanup}")));
            }
            return Err(failure(primary));
        }
        self.execution = Some(execution);
        self.witness()
    }
    /// Inspection is revalidated against source, resource and actual object lives.
    /// No mesh, source-only display or final-net artifact is returned.
    pub fn witness(&self) -> Result<JsValue, JsValue> {
        let execution = self.execution.as_ref().ok_or_else(|| failure("transaction not completed"))?;
        execution.validate_witness().map_err(failure)?;
        let plan = execution.traversal_plan().ok_or_else(|| failure("common traversal not completed"))?;
        #[derive(serde::Serialize)]
        struct Witness {
            contract: &'static str, product_id: u32, discharged_operations: usize,
            occurrences: usize, remaining_requirements: Vec<String>, final_product_available: bool,
        }
        serde_wasm_bindgen::to_value(&Witness {contract:"common_product_transaction_only",product_id:self.product_id,
            discharged_operations:execution.discharged_count(),occurrences:plan.values.len(),
            remaining_requirements:plan.remaining.iter().map(|requirement|format!("{requirement:?}")).collect(),
            final_product_available:false}).map_err(failure)
    }
}
#[wasm_bindgen]
impl IfcAPI {
    /// Explicit product selection from the installed coherent source. Ordinary
    /// model loading never creates an executor or requests /smlib assets.
    #[wasm_bindgen(js_name = admitRetainedProduct)]
    pub fn admit_retained_product(&self, product_id: u32) -> Result<RetainedBrowserProduct, JsValue> {
        let load = self.coherent_source.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone().ok_or_else(|| failure("bindSourceModel is required before retained product admission"))?;
        let content = load.source.bytes();
        let mut decoder = load.source.decoder().with_strict_reals();
        let entity = decoder.decode_by_id(product_id).map_err(failure)?;
        // Reuse the canonical prepass and shared caches; do not invent another
        // style/void/material resolver or product/source traversal here.
        let prepass = super::styling::combined_pre_pass(content, &mut decoder);
        if !entity.ifc_type.is_subtype_of(ifc_lite_core::IfcType::IfcTypeProduct)
            && !prepass.simple_jobs.iter().chain(&prepass.complex_jobs).any(|job|job.0==entity.id) {
            return Err(failure("entity is not a canonical product job"));
        }
        let mut router = GeometryRouter::with_scale_and_quality(decoder.length_unit_scale(),self.tessellation_quality());
        router.set_skip_small_cuts(self.skip_small_cuts());
        self.configure_product_material_layers(&mut router,content,&mut decoder);
        let palettes = self.get_or_build_indexed_colour_maps(content,&mut decoder);
        let textures = self.get_or_build_texture_index(content,&mut decoder);
        let kind = self.canonical_product_job_kind(content, &entity, &entity.ifc_type, &mut decoder)
            .ok_or_else(|| failure("canonical product job has no representation maps"))?;
        let resolved = prepass.resolved;
        let colors = resolved.geometry_style_index.iter().map(|(&id,style)|(id,style.color)).collect();
        let element_color = super::styling::resolve_element_color(&entity, &colors, &mut decoder);
        let context = load.model.snapshot(OwnedMeshProductionData {
            void_index:Arc::new(resolved.void_index),geometry_style_index:Arc::new(resolved.geometry_style_index),
            indexed_colour_full:palettes.maps.clone(),element_material_colors:Arc::new(resolved.element_material_colors),
            texture_index:textures,site_local_rotation:None,
        });
        drop(decoder);
        Ok(RetainedBrowserProduct {load,context,product_id,router:Some(router),execution:None,kind,element_color})
    }
}
fn failure(error: impl std::fmt::Display) -> JsValue { JsValue::from_str(&error.to_string()) }

#[cfg(test)]
#[path = "retained_product_tests.rs"]
mod tests;
