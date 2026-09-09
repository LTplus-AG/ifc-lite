// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::IfcAPI;
use ifc_lite_processing::appearance::{register_scan_correspondences, ScanRegistrationRequest};
use wasm_bindgen::prelude::*;

fn register_json(request_json: &str) -> Result<Vec<u8>, String> {
    if request_json.len() > 512 * 1024 {
        return Err("Scan registration request exceeds 512 KiB".into());
    }
    let request: ScanRegistrationRequest = serde_json::from_str(request_json)
        .map_err(|error| format!("Invalid scan registration: {error}"))?;
    let report = register_scan_correspondences(&request)?;
    serde_json::to_vec(&report).map_err(|error| format!("Cannot encode scan registration: {error}"))
}

#[wasm_bindgen]
impl IfcAPI {
    /// Fit bounded manual correspondences in source metres -> IFC world Z-up
    /// metres, reporting held-out errors separately. Does not load or move models.
    #[wasm_bindgen(js_name = registerScanCorrespondences)]
    pub fn register_scan_correspondences(&self, request_json: &str) -> Result<Vec<u8>, JsError> {
        register_json(request_json).map_err(|message| JsError::new(&message))
    }
}

#[cfg(test)]
mod tests {
    use super::register_json;
    #[test]
    fn issue_4381_registration_binding_is_bounded_and_strict() {
        assert!(register_json(&" ".repeat(512 * 1024 + 1))
            .unwrap_err()
            .contains("512 KiB"));
        assert!(register_json("{}")
            .unwrap_err()
            .contains("Invalid scan registration"));
    }
}
