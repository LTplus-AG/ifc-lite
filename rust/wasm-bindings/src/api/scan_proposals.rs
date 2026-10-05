// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::IfcAPI;
use ifc_lite_processing::scan_proposals::{propose_scan_elements, ScanProposalOptions};
use ifc_lite_processing::scan_segmentation::ScanSegmentationReport;
use wasm_bindgen::prelude::*;

const MAX_OPTIONS_BYTES: usize = 64 * 1024;
/// A report of 20,000 planes and 20,000 cylinders is about 25 MiB of JSON.
const MAX_REPORT_BYTES: usize = 64 * 1024 * 1024;

fn propose_json(report_json: &str, options_json: &str) -> Result<Vec<u8>, String> {
    if options_json.len() > MAX_OPTIONS_BYTES {
        return Err("Scan proposal options exceed 64 KiB".into());
    }
    if report_json.len() > MAX_REPORT_BYTES {
        return Err("Scan segmentation report exceeds 64 MiB".into());
    }
    let options: ScanProposalOptions = serde_json::from_str(options_json)
        .map_err(|error| format!("Invalid scan proposal options: {error}"))?;
    let report: ScanSegmentationReport = serde_json::from_str(report_json)
        .map_err(|error| format!("Invalid scan segmentation report: {error}"))?;
    let proposals = propose_scan_elements(&report, &options)?;
    serde_json::to_vec(&proposals).map_err(|error| format!("Cannot encode scan proposals: {error}"))
}

#[wasm_bindgen]
impl IfcAPI {
    /// Propose IFC walls, slabs, columns and pipes from a scan segmentation
    /// report (#6894). `report_json` is the JSON `segmentScanPoints`
    /// returned; `options_json` is a camelCase `ScanProposalOptions` object
    /// (`{}` for the defaults; `scanToModel` maps the report's frame into the
    /// IFC model frame). Returns the UTF-8 JSON `ScanProposalReport` in the
    /// model frame (Z up, metres). Pure: loads and changes nothing.
    #[wasm_bindgen(js_name = proposeScanElements)]
    pub fn propose_scan_elements(&self, report_json: &str, options_json: &str) -> Result<Vec<u8>, JsError> {
        propose_json(report_json, options_json).map_err(|message| JsError::new(&message))
    }
}

#[cfg(test)]
mod tests {
    use super::propose_json;
    use crate::api::scan_segmentation::segment_json;

    #[test]
    fn issue_6894_proposal_binding_round_trips_a_segmentation_report_and_is_strict() {
        let empty = String::from_utf8(segment_json(&[0., 0., 0.], "{}").unwrap()).unwrap();
        let report: serde_json::Value = serde_json::from_slice(&propose_json(&empty, "{}").unwrap()).unwrap();
        assert_eq!(report["algorithm"], "ifclite-scan-proposals-v1");
        assert_eq!(report["proposals"].as_array().map(Vec::len), Some(0));
        assert!(propose_json(&empty, r#"{"surprise":1}"#).unwrap_err().contains("Invalid scan proposal options"));
        assert!(propose_json("{}", "{}").unwrap_err().contains("Invalid scan segmentation report"));
        assert!(propose_json(&empty, &" ".repeat(64 * 1024 + 1)).unwrap_err().contains("64 KiB"));
        assert!(propose_json(&empty, r#"{"scanToModel":[-1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]}"#).unwrap_err().contains("reflect"));
    }
}
