// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Raw-byte LandXML ingestion binding.
//!
//! XML decoding belongs to `ifc-lite-landxml`: taking a `Uint8Array` prevents
//! callers from accidentally decoding UTF-16 source as JavaScript text first.

use super::IfcAPI;
use wasm_bindgen::{prelude::*, JsCast};

#[wasm_bindgen]
extern "C" {
    /// The serialized semantic source record emitted by `parseLandXmlTinBytes`.
    #[wasm_bindgen(typescript_type = "LandXmlTinDocumentJs")]
    pub type LandXmlTinDocumentJs;
}

#[wasm_bindgen(typescript_custom_section)]
const LANDXML_TYPES: &str = r#"
export interface LandXmlTinDocumentJs {
  format: "landxml";
  schema: "LandXML-1.2";
  capabilities: { renderable_tin: boolean; preserved_only_surfaces: number; unknown_extensions: number };
  version: string;
  units: { linear_unit: string; elevation_unit: string; linear_scale_to_meters: number; elevation_scale_to_meters: number } | null;
  surfaces: LandXmlSurfaceJs[];
  extensions: LandXmlExtensionJs[];
  warnings: string[];
}
export interface LandXmlSurfaceJs {
  source_id: string; ordinal: number; source_path: string;
  properties: Record<string, string>; definition_properties: Record<string, string>;
  name: string; kind: "tin" | "grid" | "volume" | "other";
  render_state: "rendered" | "preserved_only" | "unsupported";
  points: LandXmlPointJs[]; source_data_points: LandXmlSourcePointJs[];
  faces: [string, string, string][]; face_source_ids: string[]; face_visibility: boolean[];
  hidden_face_count: number; boundaries: LandXmlPolylineJs[]; breaklines: LandXmlPolylineJs[]; contours: LandXmlPolylineJs[];
}
export interface LandXmlPointJs { source_id: string; id: string; northing: number; easting: number; elevation: number; }
export interface LandXmlSourcePointJs { source_id: string; ordinal: number; source_path: string; coordinate_dimension: 2 | 3; coordinates: number[]; }
export interface LandXmlPolylineJs { source_id: string; ordinal: number; name: string | null; kind: string | null; source_path: string; properties: Record<string, string>; coordinate_dimension: 2 | 3; points: number[][]; point_source_ids: string[]; }
export interface LandXmlExtensionJs { namespace: string; local_name: string; path: string; }
"#;

#[wasm_bindgen]
impl IfcAPI {
    /// Parse a LandXML 1.2 TIN document from its original bytes.
    ///
    /// The object is an owned serialization of the semantic document. Errors
    /// deliberately use `LandXmlError::Display`, including its stable LXML code.
    #[wasm_bindgen(js_name = parseLandXmlTinBytes)]
    pub fn parse_landxml_tin_bytes(&self, data: &[u8]) -> Result<LandXmlTinDocumentJs, JsValue> {
        let document = ifc_lite_landxml::parse_landxml_tin(data)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        serde_wasm_bindgen::to_value(&document)
            .map(|value| value.unchecked_into())
            .map_err(|error| {
                JsValue::from_str(&format!("LandXML result serialization failed: {error}"))
            })
    }
}
