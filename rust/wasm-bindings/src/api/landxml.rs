// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Raw-byte LandXML ingestion binding.
//!
//! XML decoding belongs to `ifc-lite-landxml`: taking a `Uint8Array` prevents
//! callers from accidentally decoding UTF-16 source as JavaScript text first.

use super::IfcAPI;
use serde::{Deserialize, Serialize};
use wasm_bindgen::{prelude::*, JsCast};

pub(crate) mod endpoints;

#[derive(Serialize)]
struct LandXmlSourceDocument<'a> {
    tin: endpoints::LandXmlDocumentJs<'a>,
    alignments: ifc_lite_landxml::alignment::LandXmlAlignmentDocument,
    alignment_render_spans: Vec<ifc_lite_landxml::alignment::LandXmlAlignmentRenderSpan>,
    alignment_render_refusals: Vec<ifc_lite_landxml::alignment::LandXmlAlignmentRenderRefusal>,
    alignment_render_truncated: bool,
}
const MAX_INTERACTIVE_SUPERELEVATION_BLOCKS: usize = 128;
const MAX_INTERACTIVE_SUPERELEVATION_EVENTS: usize = 100;
#[derive(Serialize)]
struct LandXmlAlignmentInspection {
    cant: Option<ifc_lite_landxml::alignment::LandXmlCantProbe>,
    superelevations: Vec<ifc_lite_landxml::alignment::LandXmlSuperelevation>,
    superelevation_block_count: usize,
    superelevation_event_count: usize,
    superelevation_truncated: bool,
}
/// JS-facing limits deliberately expose only allocation-relevant ceilings.
/// Parser defaults remain in force for omitted fields.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LandXmlParseOptions {
    max_bytes: Option<usize>,
    max_depth: Option<usize>,
    max_text_bytes: Option<usize>,
    max_points: Option<usize>,
    max_faces: Option<usize>,
    max_work: Option<usize>,
    max_alignments: Option<usize>,
    max_alignment_segments: Option<usize>,
    max_alignment_points: Option<usize>,
    max_station_equations: Option<usize>,
    max_cant_stations: Option<usize>,
    max_superelevation_events: Option<usize>,
    /// A worker can report cancellation before entering synchronous WASM. Once
    /// parsing starts, the worker termination path remains the cancellation
    /// mechanism because JS cannot interrupt a synchronous wasm invocation.
    cancelled: Option<bool>,
}

impl LandXmlParseOptions {
    fn limits(
        self,
    ) -> Result<
        (
            ifc_lite_landxml::LandXmlLimits,
            ifc_lite_landxml::alignment::LandXmlAlignmentLimits,
        ),
        JsValue,
    > {
        if self.cancelled == Some(true) {
            return Err(JsValue::from_str("LXML005: ingestion cancelled"));
        }
        let mut xml = ifc_lite_landxml::LandXmlLimits::default();
        for (target, value) in [
            (&mut xml.max_bytes, self.max_bytes),
            (&mut xml.max_depth, self.max_depth),
            (&mut xml.max_text_bytes, self.max_text_bytes),
            (&mut xml.max_points, self.max_points),
            (&mut xml.max_faces, self.max_faces),
            (&mut xml.max_work, self.max_work),
        ] {
            if let Some(value) = value {
                if value == 0 {
                    return Err(JsValue::from_str("LXML004: parser limits must be positive"));
                }
                *target = value;
            }
        }
        let mut alignment = ifc_lite_landxml::alignment::LandXmlAlignmentLimits {
            xml: xml.clone(),
            ..Default::default()
        };
        for (target, value) in [
            (&mut alignment.max_alignments, self.max_alignments),
            (
                &mut alignment.max_alignment_segments,
                self.max_alignment_segments,
            ),
            (
                &mut alignment.max_alignment_points,
                self.max_alignment_points,
            ),
            (
                &mut alignment.max_station_equations,
                self.max_station_equations,
            ),
            (&mut alignment.max_cant_stations, self.max_cant_stations),
            (
                &mut alignment.max_superelevation_events,
                self.max_superelevation_events,
            ),
        ] {
            if let Some(value) = value {
                if value == 0 {
                    return Err(JsValue::from_str("LXML004: parser limits must be positive"));
                }
                *target = value;
            }
        }
        Ok((xml, alignment))
    }
}
