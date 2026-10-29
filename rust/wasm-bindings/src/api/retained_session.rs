// SPDX-License-Identifier: MPL-2.0
//! Streaming retained model boundary; the session owns one reusable qualified peer.
use super::retained_model::{obligation_name, set, to_js};
use crate::zero_copy::{MeshCollection, MeshDataJs};
use crate::{retained_browser::model::ModelWorker, retained_view::view_meshes};
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::{
    canonical_element_jobs, run_model_with_worker, ModelOptions, ProductOutcome,
};
use ifc_lite_processing::stream_meta::{resolve_stream_meta, MetaMode};
use js_sys::{Array, Float64Array, Object, Reflect, Uint32Array};
use wasm_bindgen::prelude::*;
#[path = "retained_instancing.rs"]
mod instancing;

#[wasm_bindgen(typescript_custom_section)]
const TYPES: &str = r#"
export interface RetainedRunOptions { ids?: Uint32Array; detail: 'view' | 'shape'; }
export interface RetainedRtcFrame { rtcOffset: Float64Array; needsShift: boolean; }
export type RetainedSessionEvent =
    | { kind: 'start'; candidateIds: Uint32Array; frame: RetainedRtcFrame }
    | (RetainedShapeProduct & { kind: 'published' })
    | (RetainedProductRefusal & { kind: 'refused' })
    | { kind: 'published'; expressId: number; ifcType: string;
        marker: 'PresentationObligationsUnmet';
        obligationsUnmet: RetainedShapeProduct['obligationsUnmet']; cuts?: number; consumedParts?: number;
        meshes: MeshCollection; faces?: { table: string[]; triangles: Uint32Array }[]; instanceKey?: string;
        instanceWorldFromObject?: Float64Array };
export interface RetainedRunSummary {
    candidates: number; published: number; refused: number; restarts: number;
    workersAcquired: number; productMs: number; acquireMs: number;
    layeredProducts?: number; bands?: number;
}
"#;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "RetainedRunOptions")]
    pub type RetainedRunOptions;
    #[wasm_bindgen(typescript_type = "RetainedRunSummary")]
    pub type RetainedRunSummary;
}

#[wasm_bindgen]
#[derive(Default)]
pub struct RetainedModelSession {
    worker: Option<ModelWorker>,
}

#[wasm_bindgen]
impl RetainedModelSession {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    /// Runs one model in canonical order, reusing the qualified worker. The
    /// callback owns each MeshCollection and must free it after extraction.
    /// Callback exceptions reject the run after controller cleanup; terminate
    /// the host Worker to cancel work immediately.
    pub async fn run(
        &mut self,
        content: Vec<u8>,
        options: RetainedRunOptions,
        #[wasm_bindgen(unchecked_param_type = "(event: RetainedSessionEvent) => void")]
        on_event: &js_sys::Function,
    ) -> Result<RetainedRunSummary, JsValue> {
        let (options, view) = parse_options(&options)?;
        let source = SourceBundle::new(content);
        let candidate_ids: Vec<u32> = canonical_element_jobs(&source)
            .into_iter()
            .map(|(id, _)| id)
            .filter(|id| options.ids.as_ref().is_none_or(|ids| ids.contains(id)))
            .collect();
        let meta = resolve_stream_meta(
            MetaMode::SmallFileSingle,
            source.bytes(),
            None,
            None,
            &mut source.decoder().with_strict_reals(),
        );
        let (x, y, z) = meta.frame.rtc_offset();
        let rtc = [x, y, z];
        let frame = Object::new();
        set(&frame, "rtcOffset", &Float64Array::from(rtc.as_slice()))?;
        set(&frame, "needsShift", &meta.frame.needs_shift().into())?;
        let start = Object::new();
        set(&start, "kind", &"start".into())?;
        set(
            &start,
            "candidateIds",
            &Uint32Array::from(candidate_ids.as_slice()),
        )?;
        set(&start, "frame", &frame)?;
        on_event.call1(&JsValue::UNDEFINED, &start)?;
        let mut error = None;
        let mut workers_acquired = 0u32;
        let summary = run_model_with_worker(
            source,
            &options,
            &mut self.worker,
            || {
                workers_acquired += 1;
                ModelWorker::new()
            },
            |outcome, _| {
                if error.is_none() {
                    error = event(outcome, view, rtc)
                        .and_then(|value| on_event.call1(&JsValue::UNDEFINED, &value))
                        .err();
                }
            },
        )
        .await
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
        if let Some(error) = error {
            return Err(error);
        }
        let result = Object::new();
        for (key, value) in [
            ("candidates", summary.candidates as f64),
            ("published", summary.published as f64),
            ("layeredProducts", summary.layered_products as f64),
            ("bands", summary.bands as f64),
            ("refused", (summary.candidates - summary.published) as f64),
            ("restarts", f64::from(summary.restarts)),
            ("workersAcquired", f64::from(workers_acquired)),
            ("productMs", summary.product_ms),
            ("acquireMs", summary.acquire_ms),
        ] {
            set(&result, key, &value.into())?;
        }
        Ok(result.unchecked_into())
    }
}

fn parse_options(options: &RetainedRunOptions) -> Result<(ModelOptions, bool), JsValue> {
    let detail = Reflect::get(options, &"detail".into())?.as_string();
    let view = match detail.as_deref() {
        Some("view") => true,
        Some("shape") => false,
        _ => return Err(JsValue::from_str("detail must be 'view' or 'shape'")),
    };
    let ids = Reflect::get(options, &"ids".into())?;
    let ids = if ids.is_undefined() {
        None
    } else {
        let ids = ids
            .dyn_into::<Uint32Array>()
            .map_err(|_| JsValue::from_str("ids must be a Uint32Array"))?;
        Some(ids.to_vec().into_iter().collect())
    };
    Ok((
        ModelOptions {
            ids,
            ..Default::default()
        },
        view,
    ))
}

fn event(outcome: ProductOutcome, view: bool, rtc: [f64; 3]) -> Result<JsValue, JsValue> {
    if view {
        if let ProductOutcome::Published(product) = outcome {
            let result = Object::new();
            set(&result, "kind", &"published".into())?;
            set(&result, "expressId", &product.product_id.into())?;
            set(&result, "ifcType", &product.ifc_type.name().into())?;
            set(&result, "marker", &"PresentationObligationsUnmet".into())?;
            let obligations = Array::new();
            for obligation in &product.obligations.0 {
                obligations.push(&obligation_name(*obligation).into());
            }
            set(&result, "obligationsUnmet", &obligations)?;
            set(&result, "cuts", &(product.cuts as f64).into())?;
            set(&result, "consumedParts", &(product.consumed_parts as f64).into())?;
            let mut meshes = MeshCollection::with_capacity(product.parts.len());
            meshes.set_rtc_offset(rtc[0], rtc[1], rtc[2]);
            for mesh in view_meshes(&product, rtc) {
                meshes.add(MeshDataJs::from_mesh_data(mesh));
            }
            super::retained_presentation::product_fields(&result, &product, true)?;
            if let [part] = product.parts.as_slice() {
                if part.instance_key.is_some() {
                    set(&result, "instanceWorldFromObject", &Float64Array::from(part.world_from_object.as_slice()))?;
                }
            }
            set(&result, "meshes", &meshes.into())?;
            return Ok(result.into());
        }
    }
    let value = to_js(outcome)?;
    let kind = Reflect::get(&value, &"status".into())?;
    Reflect::set(&value, &"kind".into(), &kind)?;
    Ok(value)
}

#[cfg(test)]
#[path = "../retained_browser/m9_session_tests.rs"]
mod m9_session_tests;
