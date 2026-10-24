// SPDX-License-Identifier: MPL-2.0
//! Browser issue/await/accept over the shared borrowed product controller.
use super::retained_browser::RetainedBrowserExecutor;
use super::retained_model::{failure, RetainedModelData};
use crate::retained_browser::BrowserReceipt;
use ifc_lite_geometry::{GeometryRouter, resource::OwnedResourceContext};
use ifc_lite_processing::element::{ElementMeshJob, MeshProductionOptions, RetainedExecutionError,
    PublishedRetainedRemoval, RuntimeIssued, RuntimeProductExecution, RuntimeProductWitness, runtime::NumericalLimits};
use std::sync::Arc;
use wasm_bindgen::prelude::*;

/// Owns inputs and, after completion, an intermediate witness. It never stores
/// self-references or publishes incomplete product meshes.
#[wasm_bindgen]
pub struct RetainedBrowserProduct {
    data: Arc<RetainedModelData>,
    product_id: u32,
    resources: OwnedResourceContext,
    started: bool,
    completed: Option<RuntimeProductWitness<BrowserReceipt>>,
    terminal: Option<PublishedRetainedRemoval>,
}
impl RetainedBrowserProduct {
    pub(super) fn admit(data: Arc<RetainedModelData>, product_id: u32) -> Result<Self, JsValue> {
        let resources = OwnedResourceContext::capture_current();
        resources.check().map_err(|stop| failure(format!("{stop:?}")))?;
        Ok(Self { data, product_id, resources, started: false, completed: None, terminal: None })
    }
}

#[wasm_bindgen]
impl RetainedBrowserProduct {
    /// Complete the common transaction, retaining receipts but no final mesh.
    pub async fn execute(&mut self, executor: &mut RetainedBrowserExecutor,
        chord_metres: f64, angle_degrees: f64, max_bytes: u32) -> Result<JsValue, JsValue> {
        self.resources.check().map_err(|stop| failure(format!("{stop:?}")))?;
        self.data.context.validate_source().map_err(failure)?;
        RuntimeIssued::<BrowserReceipt>::validate_numerical_limits(chord_metres, angle_degrees, max_bytes as usize)
            .map_err(failure)?;
        if self.started { return Err(failure("product transaction already started")); }
        if executor.worker.incarnation() == 0 { return Err(failure("browser worker retired")); }
        self.started = true;
        // Rust's async frame owns these locals for every await. Only the owned
        // witness survives this method; the decoder and controller never escape.
        let source = self.data.source.clone();
        let mut decoder = source.decoder().with_strict_reals();
        let length_scale = decoder.length_unit_scale();
        // Resolve from the bound source. Injecting even identical unit values
        // through seed_unit_scales revokes the decoder's source authority.
        let entity = decoder.decode_by_id(self.product_id).map_err(failure)?;
        let setup = self.data.jobs.get(&self.product_id).ok_or_else(|| failure("missing admitted job"))?;
        let element_color = super::styling::resolve_element_color(&entity, &self.data.colors, &mut decoder);
        let job = ElementMeshJob { id: self.product_id, ifc_type: setup.ifc_type.clone(),
            entity: &entity, kind: setup.kind.clone(), element_color, metadata: None };
        let mut router = GeometryRouter::with_scale_and_quality(length_scale, self.data.quality);
        router.set_skip_small_cuts(self.data.skip_small_cuts);
        if let Some(layers) = &self.data.layers { router.set_material_layer_index(layers.clone()); }
        let mut execution = self.resources.with_scope(|| RuntimeProductExecution::<BrowserReceipt>::begin(
            &job, &self.data.context, &MeshProductionOptions::default(), &mut decoder, &router)).map_err(failure)?;
        let limits = NumericalLimits { chord_metres, angle_degrees, max_bytes: max_bytes as usize };
        let outcome: Result<(), RetainedExecutionError> = async {
            while let Some(issued) = execution.issue_next(&mut decoder, &router, &executor.worker)? {
                let work = issued.execute_async(&mut executor.worker, limits).await.map_err(|rejected| rejected.reason)?;
                execution.accept(work, &mut decoder, &router).map_err(|rejected| rejected.reason)?;
            }
            Ok(())
        }.await;
        if let Err(error) = outcome {
            execution.cancel();
            return Err(failure(error));
        }
        if execution.has_authenticated_opening_removal() {
            // Prepare the JS response before terminal acceptance: serialization
            // cannot turn an already committed removal into a failed execute.
            let response = removal_summary(self.product_id)?;
            self.terminal = Some(execution.publish_removed(&mut decoder,&router,&executor.worker)
                .map_err(terminal_failure)?);
            return Ok(response);
        }
        self.completed = Some(execution.into_witness().map_err(failure)?);
        self.witness()
    }

    /// Move the sealed terminal result once. It cannot be applied to another
    /// product or replay a consumed-host effect. Nonempty witnesses refuse.
    #[wasm_bindgen(js_name = takeRemovedProduct)]
    pub fn take_removed_product(&mut self) -> Result<RetainedRemovedProduct,JsValue> {
        self.terminal.take().map(|result| RetainedRemovedProduct { result })
            .ok_or_else(||failure("no unconsumed terminal removal"))
    }
    pub fn witness(&self) -> Result<JsValue, JsValue> {
        if self.terminal.is_some() { return removal_summary(self.product_id); }
        let completed = self.completed.as_ref().ok_or_else(|| failure("product transaction not completed"))?;
        completed.validate().map_err(failure)?;
        #[derive(serde::Serialize)]
        struct Witness {
            contract: &'static str, product_id: u32, discharged_operations: usize,
            occurrences: usize, remaining_requirements: Vec<String>, final_product_available: bool,
        }
        let plan = completed.plan();
        serde_wasm_bindgen::to_value(&Witness {
            contract: "common_product_transaction_only", product_id: self.product_id,
            discharged_operations: completed.discharged_count(), occurrences: plan.values.len(),
            remaining_requirements: plan.remaining.iter().map(|requirement| format!("{requirement:?}")).collect(),
            final_product_available: false,
        }).map_err(failure)
    }
}

/// A sealed committed outcome; no meshes, faces or occurrences survive removal.
#[wasm_bindgen]
pub struct RetainedRemovedProduct { result: PublishedRetainedRemoval }
#[wasm_bindgen]
impl RetainedRemovedProduct {
    #[wasm_bindgen(getter, js_name = productId)]
    pub fn product_id(&self) -> u32 { self.result.product_id() }
    #[wasm_bindgen(getter)]
    pub fn outcome(&self) -> String { "authenticated_whole_product_removal".into() }
}
fn removal_summary(product_id: u32) -> Result<JsValue,JsValue> {
    #[derive(serde::Serialize)]
    struct Summary { outcome: &'static str, product_id: u32, final_product_available: bool }
    serde_wasm_bindgen::to_value(&Summary { outcome: "authenticated_whole_product_removal",
        product_id, final_product_available: true }).map_err(failure)
}
fn terminal_failure(error: RetainedExecutionError) -> JsValue {
    let code = match &error { RetainedExecutionError::Source => "source",
        RetainedExecutionError::Protocol(_) => "protocol", RetainedExecutionError::Unsupported(_) => "unsupported",
        RetainedExecutionError::Runtime(_) => "runtime", RetainedExecutionError::Stopped(_) => "stopped" };
    #[derive(serde::Serialize)]
    struct Failure { code: &'static str, message: String }
    serde_wasm_bindgen::to_value(&Failure { code, message: error.to_string() })
        .unwrap_or_else(|error| failure(error))
}
#[cfg(test)]
#[path = "retained_terminal_tests.rs"]
mod tests;
