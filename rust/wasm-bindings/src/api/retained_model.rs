// SPDX-License-Identifier: MPL-2.0
//! Whole-model retained path; scheduling, atomic publication and refusals live in processing.
use super::IfcAPI;
use crate::{retained_browser::model::ModelWorker, retained_model_refusal::RefusedProduct};
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry::program::transactions::Requirement;
use ifc_lite_processing::element::retained_runtime::{run_model, ModelOptions, ProductOutcome};
use js_sys::{Array, Float64Array, Object, Reflect, Uint32Array};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(typescript_custom_section)]
const TYPES: &str = r#"
export interface RetainedShapePart {
    /** Object-local metres. */
    positions: Float64Array;
    indices: Uint32Array;
    /** Column-major object metres to absolute IFC Z-up world metres. */
    worldFromObject: Float64Array;
    curved: boolean;
}
export interface RetainedShapeProduct {
    status: 'published';
    expressId: number;
    ifcType: string;
    parts: RetainedShapePart[];
    marker: 'PresentationObligationsUnmet';
    obligationsUnmet: Array<'ProductPlacement' | 'OpeningClosure' | 'MaterialLayers' | 'IfcAppearance' | 'PersistentFaces'>;
}
export interface RetainedProductRefusal {
    status: 'refused';
    expressId: number;
    ifcType: string;
    code: 'opening_strategy' | 'material_layer_strategy' | 'operation_unsupported'
        | 'source_invalid' | 'source_changed' | 'incomplete' | 'empty_result'
        | 'family_unqualified' | 'kernel_failure' | 'worker_fault' | 'worker_retired'
        | 'resource_exhausted' | 'deadline_exceeded' | 'cancelled' | 'contract_breach';
    origin?: { site: string; entity?: number; cause: string };
    kernelStatus?: number;
}
export type RetainedProductOutcome = RetainedShapeProduct | RetainedProductRefusal;
"#;

/// Completed model run in canonical job order. Consume with next(), then free().
/// Holds copied JS results, no live Worker or WASM geometry handles.
#[wasm_bindgen]
pub struct RetainedModelRun {
    outcomes: std::vec::IntoIter<JsValue>,
}
#[wasm_bindgen]
impl RetainedModelRun {
    /// Returns one atomic shape-only product or typed refusal, undefined at end.
    #[wasm_bindgen(js_name = next, unchecked_return_type = "RetainedProductOutcome | undefined")]
    pub fn next_outcome(&mut self) -> JsValue {
        self.outcomes.next().unwrap_or(JsValue::UNDEFINED)
    }
}

#[wasm_bindgen]
impl IfcAPI {
    /// Run the opt-in retained engine, with no exact fallback. Buffers outcomes
    /// until completion; next() then consumes them in canonical file order.
    /// Type products and representationless jobs are skipped. Some(empty ids)
    /// selects no products. One qualified worker is reused, with at most three
    /// replacements, and a failed product is never retried.
    #[wasm_bindgen(js_name = retainedModel)]
    pub async fn retained_model(
        &self,
        content: &[u8],
        ids: Option<Vec<u32>>,
    ) -> Result<RetainedModelRun, JsValue> {
        let options = ModelOptions {
            ids: ids.map(|ids| ids.into_iter().collect()),
            ..Default::default()
        };
        let mut outcomes = Vec::new();
        let mut conversion_error = None;
        run_model(
            SourceBundle::new(content.to_vec()),
            &options,
            ModelWorker::new,
            |outcome| {
                if conversion_error.is_none() {
                    match to_js(outcome) {
                        Ok(value) => outcomes.push(value),
                        Err(error) => conversion_error = Some(error),
                    }
                }
            },
        )
        .await
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
        if let Some(error) = conversion_error {
            return Err(error);
        }
        Ok(RetainedModelRun {
            outcomes: outcomes.into_iter(),
        })
    }
}

fn set(object: &Object, key: &str, value: &JsValue) -> Result<(), JsValue> {
    Reflect::set(object, &JsValue::from_str(key), value).map(|_| ())
}
fn to_js(outcome: ProductOutcome) -> Result<JsValue, JsValue> {
    match outcome {
        ProductOutcome::Refused {
            product_id,
            ifc_type,
            refusal,
            origin,
            ..
        } => serde_wasm_bindgen::to_value(&RefusedProduct::new(
            product_id,
            ifc_type.name().to_string(),
            refusal,
            origin,
        ))
        .map_err(|error| JsValue::from_str(&error.to_string())),
        ProductOutcome::Published(product) => {
            let result = Object::new();
            set(&result, "status", &"published".into())?;
            set(&result, "expressId", &product.product_id.into())?;
            set(&result, "ifcType", &product.ifc_type.name().into())?;
            set(&result, "marker", &"PresentationObligationsUnmet".into())?;
            let obligations = Array::new();
            for obligation in &product.obligations.0 {
                obligations.push(&obligation_name(*obligation).into());
            }
            set(&result, "obligationsUnmet", &obligations)?;
            let parts = Array::new();
            for part in &product.parts {
                let view = Object::new();
                set(
                    &view,
                    "positions",
                    &Float64Array::from(part.positions.as_slice()),
                )?;
                set(
                    &view,
                    "indices",
                    &Uint32Array::from(part.indices.as_slice()),
                )?;
                set(
                    &view,
                    "worldFromObject",
                    &Float64Array::from(part.world_from_object.as_slice()),
                )?;
                set(&view, "curved", &part.curved.into())?;
                parts.push(&view);
            }
            set(&result, "parts", &parts)?;
            Ok(result.into())
        }
    }
}

#[cfg(test)]
#[path = "retained_model_tests.rs"]
mod tests;

/// Stable JavaScript names for unmet presentation obligations. An exhaustive
/// match, so a new or renamed requirement cannot change the API silently.
fn obligation_name(requirement: Requirement) -> &'static str {
    match requirement {
        Requirement::ProductPlacement => "ProductPlacement",
        Requirement::OpeningClosure => "OpeningClosure",
        Requirement::MaterialLayers => "MaterialLayers",
        Requirement::IfcAppearance => "IfcAppearance",
        Requirement::PersistentFaces => "PersistentFaces",
    }
}
