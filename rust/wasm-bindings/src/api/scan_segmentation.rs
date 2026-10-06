// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::IfcAPI;
use ifc_lite_processing::scan_segmentation::{segment_scan_points, ScanSegmentationOptions};
use wasm_bindgen::prelude::*;

const MAX_OPTIONS_BYTES: usize = 64 * 1024;

pub(crate) fn segment_json(positions: &[f32], options_json: &str) -> Result<Vec<u8>, String> {
    if options_json.len() > MAX_OPTIONS_BYTES {
        return Err("Scan segmentation options exceed 64 KiB".into());
    }
    let options: ScanSegmentationOptions = serde_json::from_str(options_json)
        .map_err(|error| format!("Invalid scan segmentation options: {error}"))?;
    let report = segment_scan_points(positions, &options)?;
    serde_json::to_vec(&report).map_err(|error| format!("Cannot encode scan segmentation: {error}"))
}

#[wasm_bindgen]
impl IfcAPI {
    /// Detect planes and cylinders (columns, pipes) in a point cloud (#6870). `positions` are xyz f32 metres
    /// (at most 100,000,000 points); `options_json` is a camelCase
    /// `ScanSegmentationOptions` object (`{}` for the defaults). Returns the
    /// UTF-8 JSON `ScanSegmentationReport`. Pure: loads and changes nothing.
    #[wasm_bindgen(js_name = segmentScanPoints)]
    pub fn segment_scan_points(&self, positions: &[f32], options_json: &str) -> Result<Vec<u8>, JsError> {
        segment_json(positions, options_json).map_err(|message| JsError::new(&message))
    }
}

#[cfg(test)]
mod tests {
    use super::segment_json;

    #[test]
    fn issue_6870_segmentation_binding_is_bounded_and_strict() {
        assert!(segment_json(&[], &" ".repeat(64 * 1024 + 1)).unwrap_err().contains("64 KiB"));
        assert!(segment_json(&[], r#"{"surprise":1}"#).unwrap_err().contains("Invalid scan segmentation options"));
        assert!(segment_json(&[0., 0.], "{}").unwrap_err().contains("xyz triples"));
        let report: serde_json::Value = serde_json::from_slice(&segment_json(&[0., 0., 0.], "{}").unwrap()).unwrap();
        assert_eq!(report["stats"]["acceptedPoints"], 1);
        assert_eq!(report["planes"].as_array().map(Vec::len), Some(0));
    }
}
