// SPDX-License-Identifier: MPL-2.0
//! Explicit retained source execution under the canonical installed source owner.
//! No source bytes, worker IDs or completion buffers are accepted from callers.
use super::IfcAPI;
use ifc_lite_geometry_runtime::browser::{BrowserCancellation, BrowserWorker};
use ifc_lite_processing::{
    authored_geometry::{
        bound::{BoundAuthoredPlan, ModelBoundRetainedDocument},
        bound_browser::PublishedBrowserSource,
        evaluator::RetainedDisplayContract,
    },
    element::OwnedMeshProductionData,
    AnalyticSourceKey,
};
use std::sync::Arc;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct RetainedBrowserExecutor {
    worker: BrowserWorker,
}
/// Capture before starting an async operation so retirement remains callable
/// while wasm-bindgen holds the executor's mutable borrow for that operation.
#[wasm_bindgen]
pub struct RetainedBrowserCancellation {
    cancellation: BrowserCancellation,
}
#[wasm_bindgen]
impl RetainedBrowserCancellation {
    pub fn retire(&self) {
        self.cancellation.retire();
    }
}
#[wasm_bindgen]
impl RetainedBrowserExecutor {
    /// Explicit allocation only. Canonical SDK adapter assets live at /smlib/.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<RetainedBrowserExecutor, JsValue> {
        Ok(Self {
            worker: BrowserWorker::new()?,
        })
    }
    /// Actual same-Worker numerical witnesses; not full IFC/browser qualification.
    #[wasm_bindgen(js_name = qualifyNumericalRoutes)]
    pub async fn qualify_numerical_routes(&mut self) -> Result<(), JsValue> {
        self.worker.qualify().await
    }
    pub fn retire(&self) {
        self.worker.retire();
    }
    pub fn cancellation(&self) -> RetainedBrowserCancellation {
        RetainedBrowserCancellation { cancellation: self.worker.cancellation() }
    }
}

/// One explicitly selected canonical source. This is source-only output, never
/// an assertion that enclosing booleans/openings or representation are complete.
#[wasm_bindgen]
pub struct RetainedBrowserSource {
    document: ModelBoundRetainedDocument,
    key: AnalyticSourceKey,
    publication: Option<PublishedBrowserSource>,
}
#[wasm_bindgen]
impl RetainedBrowserSource {
    /// One linear pending ticket spans upload, actual Worker response and common
    /// assembly. Dropping the future retires that captured Worker and its leases.
    pub async fn execute(
        &mut self,
        executor: &mut RetainedBrowserExecutor,
        occurrence_index: u32,
        chord_metres: f64,
        angle_degrees: f64,
        max_bytes: u32,
    ) -> Result<JsValue, JsValue> {
        if self.publication.is_some() {
            return Err(failure("retained source already published"));
        }
        let issued = self
            .document
            .issue_browser(&self.key, &executor.worker)
            .map_err(failure)?;
        let completed = self
            .document
            .execute_browser(
                issued,
                &mut executor.worker,
                chord_metres,
                angle_degrees,
                max_bytes,
            )
            .await
            .map_err(failure)?;
        let publication = self
            .document
            .accept_browser(
                completed,
                occurrence_index as usize,
                RetainedDisplayContract::UnstyledFlatSourceOnly,
            )
            .map_err(|rejected| failure(&rejected.reason))?;
        self.publication = Some(publication);
        self.display()
    }
    /// Copies the common document's mesh/occurrences only after live source,
    /// Worker and object-lease validation. Coordinates remain IFC Z-up metres.
    pub fn display(&self) -> Result<JsValue, JsValue> {
        let publication = self
            .publication
            .as_ref()
            .ok_or_else(|| failure("retained source not published"))?;
        self.document
            .validate_browser_publication(publication)
            .map_err(failure)?;
        let document = self.document.document();
        let mesh = document.mesh(publication.definition()).map_err(failure)?;
        let occurrences = publication
            .mapped_occurrences()
            .iter()
            .map(|(id, handle)| {
                document
                    .occurrence(*handle)
                    .map(|occurrence| (*id, occurrence.local_to_model))
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(failure)?;
        #[derive(serde::Serialize)]
        struct Display<'a> {
            contract: &'static str,
            product_id: u32,
            positions: &'a [f32],
            normals: &'a [f32],
            indices: &'a [u32],
            occurrences: Vec<(u32, [f64; 16])>,
        }
        serde_wasm_bindgen::to_value(&Display {
            contract: "unstyled_flat_source_only",
            product_id: publication.product_id(),
            positions: &mesh.positions,
            normals: &mesh.normals,
            indices: &mesh.indices,
            occurrences,
        })
        .map_err(failure)
    }
}

#[wasm_bindgen]
impl IfcAPI {
    /// Read-only choices from the actual installed canonical source. Does not
    /// start an SDK Worker, fetch SDK assets or grant execution qualification.
    #[wasm_bindgen(js_name = retainedSourceKeys)]
    pub fn retained_source_keys(&self) -> Result<JsValue, JsValue> {
        let plan = self.retained_bound_plan()?;
        serde_wasm_bindgen::to_value(
            &plan
                .plan()
                .definitions
                .iter()
                .map(|d| d.key())
                .collect::<Vec<_>>(),
        )
        .map_err(failure)
    }
    #[wasm_bindgen(js_name = admitRetainedSource)]
    pub fn admit_retained_source(
        &self,
        source_key: JsValue,
    ) -> Result<RetainedBrowserSource, JsValue> {
        let supplied: serde_json::Value =
            serde_wasm_bindgen::from_value(source_key).map_err(failure)?;
        let plan = self.retained_bound_plan()?;
        let key = plan
            .plan()
            .definitions
            .iter()
            .map(|d| d.key())
            .find(|key| serde_json::to_value(key).is_ok_and(|value| value == supplied))
            .ok_or_else(|| failure("source key is not in the installed canonical model"))?
            .clone();
        let document = plan.admit_source(&key).map_err(failure)?;
        Ok(RetainedBrowserSource {
            document,
            key,
            publication: None,
        })
    }
}
impl IfcAPI {
    fn retained_bound_plan(&self) -> Result<Arc<BoundAuthoredPlan>, JsValue> {
        // No bind/loader fallback. The established source installation must
        // already have authenticated these exact bytes and index together.
        let load = self
            .coherent_source
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .ok_or_else(|| failure("bindSourceModel is required before retained admission"))?;
        let context = load.model.snapshot(OwnedMeshProductionData::default());
        let mut decoder = load.source.decoder().with_strict_reals();
        context.admit_authored_plan(&mut decoder).map_err(failure)
    }
}
fn failure(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}

#[cfg(test)]
#[path = "retained_browser_tests.rs"]
mod tests;
