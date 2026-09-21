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

#[derive(Serialize)]
struct LandXmlSourceDocument {
    tin: ifc_lite_landxml::LandXmlTinDocument,
    alignments: ifc_lite_landxml::alignment::LandXmlAlignmentDocument,
}

#[wasm_bindgen]
extern "C" {
    /// The serialized semantic source record emitted by `parseLandXmlTinBytes`.
    #[wasm_bindgen(typescript_type = "LandXmlTinDocumentJs")]
    pub type LandXmlTinDocumentJs;
    /// The complete, source-level LandXML record emitted by
    /// `parseLandXmlSourceBytes`. `tin` and `alignments` preserve their own
    /// source semantics; neither is converted into invented IFC entities.
    #[wasm_bindgen(typescript_type = "LandXmlSourceDocumentJs")]
    pub type LandXmlSourceDocumentJs;
    #[wasm_bindgen(typescript_type = "LandXmlAlignmentProbeJs")]
    pub type LandXmlAlignmentProbeJs;
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
export interface LandXmlSourceDocumentJs { tin: LandXmlTinDocumentJs; alignments: LandXmlAlignmentDocumentJs; }
export interface LandXmlAlignmentDocumentJs { units?: LandXmlUnitsJs; alignments: LandXmlAlignmentJs[]; warnings: string[]; }
export interface LandXmlUnitsJs { linear_unit: string; elevation_unit: string; linear_scale_to_meters: number; elevation_scale_to_meters: number; }
export interface LandXmlAlignmentJs { source_id: string; ordinal: number; name: string; length: number; sta_start: number; start?: LandXmlPointLocationJs; align_pis: LandXmlAlignmentPiJs[]; segments: LandXmlAlignmentSegmentJs[]; station_equations: LandXmlStationEquationJs[]; cant?: LandXmlCantJs; superelevations: LandXmlSuperelevationJs[]; unsupported_transitions: LandXmlUnsupportedTransitionJs[]; }
export type LandXmlPointLocationJs = { kind: "coordinates"; point: LandXmlPlanPointJs } | { kind: "point_reference"; pnt_ref: string };
export interface LandXmlPlanPointJs { northing: number; easting: number; elevation?: number; }
export interface LandXmlAlignmentPiJs { source_id: string; location: LandXmlPointLocationJs; }
export type LandXmlAlignmentSegmentJs = { source_id: string; ordinal: number; primitive: LandXmlAlignmentPrimitiveJs };
export type LandXmlAlignmentPrimitiveJs = { kind: "line"; start: LandXmlPointLocationJs; end: LandXmlPointLocationJs; declared_length?: number } | { kind: "irregular_line"; start: LandXmlPointLocationJs; end: LandXmlPointLocationJs; points: LandXmlPlanPointJs[]; declared_length?: number } | { kind: "curve"; start: LandXmlPointLocationJs; center: LandXmlPointLocationJs; end: LandXmlPointLocationJs; pi?: LandXmlPointLocationJs; rotation: "clockwise" | "counter_clockwise"; radius?: number; declared_length?: number } | { kind: "spiral" | "unsupported_spiral"; start: LandXmlPointLocationJs; pi: LandXmlPointLocationJs; end: LandXmlPointLocationJs; spi_type: string; radius_start: LandXmlRadiusJs; radius_end: LandXmlRadiusJs; rotation: "clockwise" | "counter_clockwise"; declared_length: number };
export type LandXmlRadiusJs = { finite: number } | "infinite";
export interface LandXmlStationEquationJs { source_id: string; sta_internal: number; sta_ahead: number; sta_back?: number; sta_increment?: string; }
export interface LandXmlCantJs { source_id: string; name: string; gauge: number; rotation_point?: string; equilibrium_constant?: number; applied_cant_constant?: number; stations: LandXmlCantStationJs[]; speed_stations: LandXmlSpeedStationJs[]; }
export interface LandXmlCantStationJs { source_id: string; station: number; applied_cant: number; equilibrium_cant?: number; curvature: "clockwise" | "counter_clockwise"; cant_deficiency?: number; cant_excess?: number; rate_of_change_of_applied_cant_over_time?: number; rate_of_change_of_applied_cant_over_length?: number; rate_of_change_of_cant_deficiency_over_time?: number; cant_gradient?: number; speed?: number; transition_type?: string; adverse?: boolean; }
export interface LandXmlSpeedStationJs { source_id: string; station: number; speed: number; }
export interface LandXmlSuperelevationJs { source_id: string; sta_start?: number; sta_end?: number; events: LandXmlSuperelevationEventJs[]; }
export interface LandXmlSuperelevationEventJs { source_id: string; kind: string; value?: string; }
export interface LandXmlUnsupportedTransitionJs { source_id: string; spi_type: string; spiral: Extract<LandXmlAlignmentPrimitiveJs, { kind: "spiral" }>; reason: string; }
export interface LandXmlAlignmentProbeJs { alignment_source_id: string; segment_source_id: string; geometric_distance: number; station: { geometric_distance: number; displayed_back: number; displayed_ahead: number; is_equation_boundary: boolean }; northing: number; easting: number; tangent_northing: number; tangent_easting: number; }
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

    /// Parse all currently supported LandXML source families from the original
    /// bytes. Terrain-only and alignment-only sources both return an honest
    /// empty sibling collection, allowing the viewer's single load path to
    /// handle either form and mixed documents uniformly.
    #[wasm_bindgen(js_name = parseLandXmlSourceBytes)]
    pub fn parse_landxml_source_bytes(
        &self,
        data: &[u8],
    ) -> Result<LandXmlSourceDocumentJs, JsValue> {
        let document = LandXmlSourceDocument {
            tin: ifc_lite_landxml::parse_landxml_tin(data)
                .map_err(|error| JsValue::from_str(&error.to_string()))?,
            alignments: ifc_lite_landxml::alignment::parse_landxml_alignments_optional(data)
                .map_err(|error| JsValue::from_str(&error.to_string()))?,
        };
        let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
        document
            .serialize(&serializer)
            .map(|value| value.unchecked_into())
            .map_err(|error| {
                JsValue::from_str(&format!("LandXML result serialization failed: {error}"))
            })
    }

    /// Evaluate one supported horizontal-alignment source span at an exact
    /// f64 distance. The binding reuses the native validator, so malformed
    /// deserialized records, discontinuities, unresolved references, and
    /// unsupported transition domains are rejected rather than approximated.
    #[wasm_bindgen(js_name = probeLandXmlAlignmentAtDistance)]
    pub fn probe_landxml_alignment_at_distance(
        &self,
        data: &[u8],
        alignment_source_id: &str,
        distance: f64,
        offset_right: f64,
    ) -> Result<LandXmlAlignmentProbeJs, JsValue> {
        let document = ifc_lite_landxml::alignment::parse_landxml_alignments_optional(data)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let alignment = document
            .alignments
            .iter()
            .find(|value| value.source_id.0 == alignment_source_id)
            .ok_or_else(|| JsValue::from_str("LXMLA229: alignment source id was not found"))?;
        let probe = alignment
            .probe_at_distance(distance, offset_right)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
        probe
            .serialize(&serializer)
            .map(|value| value.unchecked_into())
            .map_err(|error| {
                JsValue::from_str(&format!("LandXML probe serialization failed: {error}"))
            })
    }
}
