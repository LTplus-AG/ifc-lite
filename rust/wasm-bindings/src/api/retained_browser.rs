// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Opt-in retained-geometry host contract for JavaScript.
//!
//! `IfcAPI.retainedSources` only reads authored sources: it never constructs
//! a Worker or requests `/smlib/`. A `RetainedBrowserExecutor` is the single
//! explicit allocation of an SDK module Worker; its families are selected from
//! that actual Worker's capability bits and its own numerical witnesses, never
//! from a feature flag. A published display is the raw authored solid only
//! (`unstyled_flat_source_only`): no opening, enclosing Boolean, style or
//! persistent face identity applies, so it is not final product geometry.

use std::collections::HashSet;
use ifc_lite_geometry::document::{RegionQualification, RetainedDisplayContract};
use ifc_lite_processing::retained_requests::{RetainedSource, RetainedSources};
use serde::Serialize;
use wasm_bindgen::prelude::*;
use super::IfcAPI;
use crate::retained_browser::{BrowserCancellation, BrowserError, BrowserWorker};

fn failure(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}

fn family(qualification: RegionQualification) -> &'static str {
    match qualification {
        RegionQualification::Rectangle => "rectangle",
        RegionQualification::OrderedRegion => "ordered_region",
        RegionQualification::RationalDisk => "rational_disk",
        _ => "unsupported",
    }
}

/// One module Worker running the deployed `/smlib/` SDK bundle.
#[wasm_bindgen]
pub struct RetainedBrowserExecutor {
    worker: BrowserWorker,
}

/// Retirement captured before an async call, usable while that call holds the
/// executor. It cannot create results, replace the Worker or qualify it.
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

#[derive(Serialize)]
struct CapabilitiesView {
    live: bool,
    sdk_bits: u32,
    rectangle: bool,
    ordered_region: bool,
    rational_disk: bool,
}

#[wasm_bindgen]
impl RetainedBrowserExecutor {
    /// Explicit allocation only: starts one module Worker from `/smlib/`.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<RetainedBrowserExecutor, JsValue> {
        Ok(Self { worker: BrowserWorker::new().map_err(failure)? })
    }
    /// Run this Worker's ordered-region and rational-disk SDK witnesses. A
    /// failure retires it; a replacement must qualify on its own.
    #[wasm_bindgen(js_name = qualifyNumericalRoutes)]
    pub async fn qualify_numerical_routes(&mut self) -> Result<(), JsValue> {
        self.worker.qualify().await.map_err(failure)
    }
    /// Families this actual Worker can execute now. Reads its SDK capability
    /// bits; curved families additionally need `qualifyNumericalRoutes`.
    pub async fn capabilities(&mut self) -> Result<JsValue, JsValue> {
        let selected = self.worker.capabilities().await.map_err(failure)?;
        serde_wasm_bindgen::to_value(&CapabilitiesView {
            live: self.worker.incarnation() == selected.incarnation,
            sdk_bits: selected.sdk_bits,
            rectangle: selected.rectangle,
            ordered_region: selected.ordered_region,
            rational_disk: selected.rational_disk,
        })
        .map_err(failure)
    }
    pub fn cancellation(&self) -> RetainedBrowserCancellation {
        RetainedBrowserCancellation { cancellation: self.worker.cancellation() }
    }
    pub fn retire(&self) {
        self.worker.retire();
    }
}

#[derive(Serialize)]
struct SourceView<'a> {
    index: usize,
    solid_id: u32,
    family: &'static str,
    key: &'a ifc_lite_processing::AnalyticSourceKey,
    product_ids: Vec<u32>,
}

#[derive(Serialize)]
struct RefusedView<'a> {
    solid_id: u32,
    product_id: Option<u32>,
    reason: String,
    key: &'a ifc_lite_processing::AnalyticSourceKey,
}

#[derive(Serialize)]
struct DisplayView<'a> {
    contract: &'static str,
    solid_id: u32,
    /// Evaluation-frame metres; f32 vertex buffers never carry the survey origin.
    positions: &'a [f32],
    normals: &'a [f32],
    indices: &'a [u32],
    /// `(product_id, row-major f64 evaluation -> absolute IFC Z-up world metres)`.
    occurrences: Vec<(u32, [f64; 16])>,
}

/// The authored retained sources of one model. Holding it grants no
/// execution authority and keeps no Worker alive.
#[wasm_bindgen]
pub struct RetainedBrowserSources {
    admitted: Vec<RetainedSource>,
    refused: Vec<(u32, Option<u32>, String, ifc_lite_processing::AnalyticSourceKey)>,
}

#[wasm_bindgen]
impl RetainedBrowserSources {
    /// Admitted sources: `{ index, solid_id, family, key, product_ids }`.
    pub fn sources(&self) -> Result<JsValue, JsValue> {
        let views = self
            .admitted
            .iter()
            .enumerate()
            .map(|(index, source)| {
                Ok(SourceView {
                    index,
                    solid_id: source.key().solid_id,
                    family: family(source.qualification().map_err(failure)?),
                    key: source.key(),
                    product_ids: source.occurrences().iter().map(|o| o.product_id).collect(),
                })
            })
            .collect::<Result<Vec<_>, JsValue>>()?;
        serde_wasm_bindgen::to_value(&views).map_err(failure)
    }
    /// Every refused source or occurrence, with its reason; never dropped.
    pub fn refused(&self) -> Result<JsValue, JsValue> {
        let views: Vec<_> = self
            .refused
            .iter()
            .map(|(solid_id, product_id, reason, key)| RefusedView {
                solid_id: *solid_id,
                product_id: *product_id,
                reason: reason.clone(),
                key,
            })
            .collect();
        serde_wasm_bindgen::to_value(&views).map_err(failure)
    }
    /// Evaluate source `index` on `executor` and publish its display. A family
    /// the actual Worker cannot run is refused before anything is submitted.
    /// The Worker object is released once its copied mesh is published.
    pub async fn execute(
        &mut self,
        index: usize,
        executor: &mut RetainedBrowserExecutor,
        chord_metres: f64,
        angle_degrees: f64,
        max_bytes: u32,
    ) -> Result<JsValue, JsValue> {
        let source = self
            .admitted
            .get_mut(index)
            .ok_or_else(|| failure("no admitted retained source at this index"))?;
        let qualification = source.qualification().map_err(failure)?;
        let worker = &mut executor.worker;
        if !worker.capabilities().await.map_err(failure)?.admits(qualification) {
            return Err(failure(BrowserError::Unqualified(
                "this Worker cannot execute the source family; qualify or use another executor",
            )));
        }
        let request = source.prepare(worker.incarnation()).map_err(failure)?;
        let realization = worker
            .evaluate_retained(request, chord_metres, angle_degrees, max_bytes)
            .await
            .map_err(failure)?;
        realization.validate_live().map_err(failure)?;
        let published = source
            .publish_display(
                realization.completion(),
                realization.incarnation(),
                RetainedDisplayContract::UnstyledFlatSourceOnly,
            )
            .map_err(failure)?;
        drop(realization); // released before the next Worker command
        let document = source.document();
        let mesh = document.mesh(published.definition).map_err(failure)?;
        let occurrences = published
            .occurrences
            .iter()
            .map(|(product_id, handle)| {
                document.occurrence(*handle).map(|o| (*product_id, o.local_to_model))
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(failure)?;
        serde_wasm_bindgen::to_value(&DisplayView {
            contract: "unstyled_flat_source_only",
            solid_id: source.key().solid_id,
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
    /// Read-only walk of the model's authored extrusions and swept disks that
    /// the retained route can represent. Starts no Worker and fetches nothing.
    /// `ids` filters by product STEP ID as `extrusionDefinitions` does.
    #[wasm_bindgen(js_name = retainedSources)]
    pub fn retained_sources(&self, content: &[u8], ids: Option<Vec<u32>>) -> RetainedBrowserSources {
        let wanted = ids.map(|ids| ids.into_iter().collect::<HashSet<_>>());
        let mut admitted = Vec::new();
        let mut refused = Vec::new();
        for sources in [
            RetainedSources::extrusions(content, wanted.as_ref()),
            RetainedSources::swept_disks(content, wanted.as_ref()),
        ] {
            admitted.extend(sources.admitted);
            refused.extend(sources.refused.into_iter().map(|r| {
                (r.key.solid_id, r.product_id, format!("{:?}", r.refusal), r.key)
            }));
        }
        RetainedBrowserSources { admitted, refused }
    }
}
