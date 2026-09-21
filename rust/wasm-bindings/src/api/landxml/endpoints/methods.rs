// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Parse a LandXML 1.2 TIN document from its original bytes.
    ///
    /// The object is an owned serialization of the semantic document. Errors
    /// deliberately use `LandXmlError::Display`, including its stable LXML code.
    #[wasm_bindgen(js_name = parseLandXmlTinBytes)]
    pub fn parse_landxml_tin_bytes(&self, data: &[u8]) -> Result<LandXmlTinDocumentJs, JsValue> {
        let document = ifc_lite_landxml::parse_landxml_document(data)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let result = LandXmlDocumentJs {
            terrain: &document.terrain,
            plan: plan_adapter(&document.plan)
                .map_err(|error| JsValue::from_str(&error.to_string()))?,
        };
        let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
        result
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
        let parsed = ifc_lite_landxml::parse_landxml_document(data)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let alignments = ifc_lite_landxml::alignment::parse_landxml_alignments_optional(data)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let (alignment_render_spans, alignment_render_refusals, alignment_render_truncated) =
            alignment_render_data(&alignments);
        let tin = LandXmlDocumentJs {
            terrain: &parsed.terrain,
            plan: plan_adapter(&parsed.plan)
                .map_err(|error| JsValue::from_str(&error.to_string()))?,
        };
        let document = LandXmlSourceDocument {
            tin,
            alignments,
            alignment_render_spans,
            alignment_render_refusals,
            alignment_render_truncated,
        };
        let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
        document
            .serialize(&serializer)
            .map(|value| value.unchecked_into())
            .map_err(|error| {
                JsValue::from_str(&format!("LandXML result serialization failed: {error}"))
            })
    }

    /// Parse a source with explicit hostile-input bounds. Passing
    /// `cancelled: true` refuses before entering WASM; in-flight browser
    /// cancellation is performed by terminating the worker that owns this
    /// synchronous operation.
    #[wasm_bindgen(js_name = parseLandXmlSourceBytesWithOptions)]
    pub fn parse_landxml_source_bytes_with_options(
        &self,
        data: &[u8],
        options: JsValue,
    ) -> Result<LandXmlSourceDocumentJs, JsValue> {
        let options: LandXmlParseOptions =
            serde_wasm_bindgen::from_value(options).map_err(|error| {
                JsValue::from_str(&format!("LXML004: invalid parser options: {error}"))
            })?;
        let (xml_limits, alignment_limits) = options.limits()?;
        let terrain = ifc_lite_landxml::parse_landxml_tin_with_cancel(data, &xml_limits, None)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let plan_limits = ifc_lite_landxml::LandXmlPlanLimits {
            xml: xml_limits.clone(),
            ..Default::default()
        };
        let plan = ifc_lite_landxml::parse_landxml_plan_with_cancel(data, &plan_limits, None)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let alignments =
            ifc_lite_landxml::alignment::parse_landxml_alignments_optional_with_cancel(
                data,
                &alignment_limits,
                None,
            )
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let (alignment_render_spans, alignment_render_refusals, alignment_render_truncated) =
            alignment_render_data(&alignments);
        let tin = LandXmlDocumentJs {
            terrain: &terrain,
            plan: plan_adapter(&plan).map_err(|error| JsValue::from_str(&error.to_string()))?,
        };
        let document = LandXmlSourceDocument {
            tin,
            alignments,
            alignment_render_spans,
            alignment_render_refusals,
            alignment_render_truncated,
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

    /// Evaluate a bounded set of physical locations carrying a displayed
    /// station label. A duplicate label is real, never collapsed; an
    /// excessive number is refused rather than allocated synchronously.
    #[wasm_bindgen(js_name = probeLandXmlAlignmentAtStation)]
    pub fn probe_landxml_alignment_at_station(
        &self,
        data: &[u8],
        alignment_source_id: &str,
        station: f64,
        offset_right: f64,
    ) -> Result<LandXmlAlignmentProbesJs, JsValue> {
        let document = ifc_lite_landxml::alignment::parse_landxml_alignments_optional(data)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let alignment = document
            .alignments
            .iter()
            .find(|value| value.source_id.0 == alignment_source_id)
            .ok_or_else(|| JsValue::from_str("LXMLA229: alignment source id was not found"))?;
        let probes = alignment
            .probes_at_station(
                station,
                offset_right,
                ifc_lite_landxml::alignment::MAX_INTERACTIVE_STATION_PROBES,
            )
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
        probes
            .serialize(&serializer)
            .map(|value| value.unchecked_into())
            .map_err(|error| {
                JsValue::from_str(&format!("LandXML probe serialization failed: {error}"))
            })
    }

    /// Inspect authored cant and superelevation records at a physical distance.
    /// Cant exposes bracketing source records only; no transition value is
    /// fabricated. Superelevation blocks preserve their authored bounds.
    #[wasm_bindgen(js_name = inspectLandXmlAlignmentAtDistance)]
    pub fn inspect_landxml_alignment_at_distance(
        &self,
        data: &[u8],
        alignment_source_id: &str,
        distance: f64,
    ) -> Result<LandXmlAlignmentInspectionJs, JsValue> {
        let document = ifc_lite_landxml::alignment::parse_landxml_alignments_optional(data)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let alignment = document
            .alignments
            .iter()
            .find(|value| value.source_id.0 == alignment_source_id)
            .ok_or_else(|| JsValue::from_str("LXMLA229: alignment source id was not found"))?;
        alignment
            .station_at_distance(distance)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let internal_station = alignment.sta_start + distance;
        let mut superelevations = Vec::new();
        let mut superelevation_block_count = 0usize;
        let mut superelevation_event_count = 0usize;
        let mut retained_events = 0usize;
        for value in &alignment.superelevations {
            if value
                .sta_start
                .is_some_and(|start| internal_station < start)
                || value.sta_end.is_some_and(|end| internal_station > end)
            {
                continue;
            }
            superelevation_block_count = superelevation_block_count.saturating_add(1);
            superelevation_event_count =
                superelevation_event_count.saturating_add(value.events.len());
            if superelevations.len() >= MAX_INTERACTIVE_SUPERELEVATION_BLOCKS
                || retained_events >= MAX_INTERACTIVE_SUPERELEVATION_EVENTS
            {
                continue;
            }
            let remaining = MAX_INTERACTIVE_SUPERELEVATION_EVENTS - retained_events;
            let retained = ifc_lite_landxml::alignment::LandXmlSuperelevation {
                source_id: value.source_id.clone(),
                sta_start: value.sta_start,
                sta_end: value.sta_end,
                events: value.events.iter().take(remaining).cloned().collect(),
            };
            retained_events += retained.events.len();
            superelevations.push(retained);
        }
        let inspection = LandXmlAlignmentInspection {
            cant: alignment
                .cant_at_distance(distance)
                .map_err(|error| JsValue::from_str(&error.to_string()))?,
            superelevations,
            superelevation_block_count,
            superelevation_event_count,
            superelevation_truncated: superelevation_block_count
                > MAX_INTERACTIVE_SUPERELEVATION_BLOCKS
                || superelevation_event_count > retained_events,
        };
        let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
        inspection
            .serialize(&serializer)
            .map(|value| value.unchecked_into())
            .map_err(|error| {
                JsValue::from_str(&format!("LandXML inspection serialization failed: {error}"))
            })
    }
}
