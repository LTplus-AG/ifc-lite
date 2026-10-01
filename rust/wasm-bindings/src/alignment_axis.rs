// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Retained exact alignment evaluator. The caller owns and frees this handle.
use ifc_lite_geometry::AlignmentAxis;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct AlignmentAxisJs {
    axis: AlignmentAxis,
}

#[wasm_bindgen]
impl AlignmentAxisJs {
    #[wasm_bindgen(constructor)]
    pub fn new(content: &str, express_id: u32) -> std::result::Result<Self, JsValue> {
        AlignmentAxis::from_content(content, express_id)
            .map(|axis| Self { axis })
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    #[wasm_bindgen(getter, js_name = expressId)]
    pub fn express_id(&self) -> u32 { self.axis.express_id }

    #[wasm_bindgen(getter, js_name = GlobalId)]
    pub fn global_id(&self) -> Option<String> { self.axis.GlobalId.clone() }

    #[wasm_bindgen(getter, js_name = Name)]
    pub fn name(&self) -> Option<String> { self.axis.Name.clone() }

    #[wasm_bindgen(getter, js_name = geometricHorizontalLengthMeters)]
    pub fn length_m(&self) -> f64 { self.axis.length_m() }

    #[wasm_bindgen(getter)]
    pub fn approximate(&self) -> bool { self.axis.approximate }

    /// [horizontal distance, IFC Z-up point XYZ, normalized world tangent XYZ].
    /// Coordinates remain f64 absolute metres; no renderer origin is applied.
    pub fn evaluate(&self, distance_m: f64) -> std::result::Result<Vec<f64>, JsValue> {
        let sample = self.axis.evaluate(distance_m)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        Ok(vec![sample.geometric_horizontal_distance_m,
            sample.point[0], sample.point[1], sample.point[2],
            sample.tangent[0], sample.tangent[1], sample.tangent[2]])
    }
}
