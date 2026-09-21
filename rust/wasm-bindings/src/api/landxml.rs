// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Raw-byte LandXML ingestion binding.
//!
//! XML decoding belongs to `ifc-lite-landxml`: taking a `Uint8Array` prevents
//! callers from accidentally decoding UTF-16 source as JavaScript text first.

use super::IfcAPI;
use serde::Serialize;
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
  /** serde_wasm_bindgen omits an absent Rust Option field rather than serializing null. */
  units?: { linear_unit: string; elevation_unit: string; linear_scale_to_meters: number; elevation_scale_to_meters: number };
  surfaces: LandXmlSurfaceJs[];
  extensions: LandXmlExtensionJs[];
  warnings: string[];
  alignments: LandXmlAlignmentJs[]; profiles: LandXmlProfileJs[];
  cross_sections: LandXmlCrossSectionJs[]; cross_section_surfaces: LandXmlCrossSectionSurfaceJs[];
  roadways: LandXmlRoadwayJs[]; capability_diagnostics: LandXmlCapabilityDiagnosticJs[];
  preserved_only_extensions: LandXmlPreservedOnlyExtensionJs[];
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
/** serde_wasm_bindgen omits absent Rust Option fields rather than serializing null. */
export interface LandXmlPolylineJs { source_id: string; ordinal: number; name?: string; kind?: string; source_path: string; properties: Record<string, string>; coordinate_dimension: 2 | 3; points: number[][]; point_source_ids: string[]; }
export interface LandXmlExtensionJs { namespace: string; local_name: string; path: string; }
export interface LandXmlAlignmentJs { source_id: string; ordinal: number; name: string; length: number; sta_start: number; profile_source_ids: string[]; cross_section_source_ids: string[]; }
export interface LandXmlProfilePointJs { source_id: string; station: number; elevation?: number; }
export interface LandXmlGradeLineJs { source_id: string; parent_profile_source_id: string; ordinal: number; points: LandXmlProfilePointJs[]; }
export interface LandXmlVerticalCurveJs { source_id: string; parent_profile_source_id: string; kind: "parabolic" | "unsymmetrical_parabolic" | "circular"; station: number; elevation?: number; length?: number; length_in?: number; length_out?: number; radius?: number; }
export interface LandXmlProfileJs { source_id: string; parent_alignment_source_id: string; ordinal: number; name: string; kind: "design" | "sampled"; pvis: LandXmlProfilePointJs[]; vertical_curves: LandXmlVerticalCurveJs[]; grade_lines: LandXmlGradeLineJs[]; }
export interface LandXmlCrossSectionJs { source_id: string; parent_alignment_source_id: string; ordinal: number; station: number; surface_source_ids: string[]; }
export interface LandXmlCrossSectionPointJs { source_id: string; data_format: "offset_elevation" | "slope_distance"; offset?: number; elevation?: number; slope?: number; distance?: number; pnt_ref?: string; alignment_ref?: string; align_ref_station?: number; alignment_source_id?: string; plan_feature_ref?: string; plan_feature_ref_station?: number; parcel_ref?: string; parcel_ref_station?: number; }
export interface LandXmlCrossSectionSegmentJs { source_id: string; parent_surface_source_id: string; ordinal: number; points: LandXmlCrossSectionPointJs[]; }
export interface LandXmlCrossSectionSurfaceJs { source_id: string; parent_cross_section_source_id: string; kind: "sampled" | "design"; name?: string; segments: LandXmlCrossSectionSegmentJs[]; points: LandXmlCrossSectionPointJs[]; }
export interface LandXmlRoadwayJs { source_id: string; ordinal: number; name: string; alignment_refs: string[]; alignment_source_ids: string[]; surface_refs: string[]; surface_source_ids: string[]; grade_model_refs: string[]; }
export interface LandXmlCapabilityDiagnosticJs { code: string; source_id?: string; source_path: string; message: string; }
export interface LandXmlPreservedOnlyExtensionJs { source_id: string; parent_source_id?: string; local_name: string; source_path: string; kind: "corridor" | "string_line"; }
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
        let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
        document
            .serialize(&serializer)
            .map(|value| value.unchecked_into())
            .map_err(|error| {
                JsValue::from_str(&format!("LandXML result serialization failed: {error}"))
            })
    }
}
