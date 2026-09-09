// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::IfcAPI;
use ifc_lite_processing::appearance::{calibrate_appearance_plane, PlaneCalibrationRequest};
use wasm_bindgen::prelude::*;

fn calibrate_json(request_json: &str) -> Result<Vec<u8>, String> {
    if request_json.len() > 8192 {
        return Err("Plane calibration request exceeds 8 KiB".into());
    }
    let request: PlaneCalibrationRequest = serde_json::from_str(request_json)
        .map_err(|error| format!("Invalid plane calibration: {error}"))?;
    let plane = calibrate_appearance_plane(&request)?;
    serde_json::to_vec(&plane).map_err(|error| format!("Cannot encode calibrated plane: {error}"))
}

#[wasm_bindgen]
impl IfcAPI {
    /// Calibrate one raster plane from native-source landmarks and a measured
    /// world span. Returns UTF-8 CalibratedPlane JSON. Constant bounded work;
    /// does not read IFC, decode image pixels or mutate a model.
    #[wasm_bindgen(js_name = calibrateAppearancePlane)]
    pub fn calibrate_appearance_plane(&self, request_json: &str) -> Result<Vec<u8>, JsError> {
        calibrate_json(request_json).map_err(|message| JsError::new(&message))
    }
}

#[cfg(test)]
mod tests {
    use super::calibrate_json;
    #[test]
    fn issue_4260_calibration_binding_bounds_and_validates_request() {
        assert!(calibrate_json(&" ".repeat(8193)).unwrap_err().contains("8 KiB"));
        assert!(calibrate_json("{}").unwrap_err().contains("Invalid plane calibration"));
    }
}
