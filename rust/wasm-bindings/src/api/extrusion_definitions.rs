// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Exact authored extrusion sources and occurrence transforms for JavaScript.

use std::collections::{BTreeMap, HashSet};
use ifc_lite_processing::{ExtrusionDefinition, ExtrusionDefinitions, ExtrusionInstance};
use serde::Serialize;
use wasm_bindgen::prelude::*;
use super::analytic_serialization::string_keyed_refs;
use super::IfcAPI;

#[derive(Serialize)]
struct ExtrusionDefinitionsView<'a> {
    up_axis: &'a str,
    source_units: &'a str,
    world_units: &'a str,
    coordinate_space: &'a str,
    model_sha256: &'a str,
    schema: &'a Option<String>,
    length_unit_scale: f64,
    sources: &'a [ExtrusionDefinition],
    instances: BTreeMap<String, &'a Vec<ExtrusionInstance>>,
    diagnostics: &'a [String],
}

impl<'a> From<&'a ExtrusionDefinitions> for ExtrusionDefinitionsView<'a> {
    fn from(value: &'a ExtrusionDefinitions) -> Self {
        Self {
            up_axis: value.up_axis, source_units: value.source_units,
            world_units: value.world_units, coordinate_space: value.coordinate_space,
            model_sha256: &value.model_sha256, schema: &value.schema,
            length_unit_scale: value.length_unit_scale, sources: &value.sources,
            instances: string_keyed_refs(&value.instances), diagnostics: &value.diagnostics,
        }
    }
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "ExtrusionDefinitionsJs")]
    pub type ExtrusionDefinitionsJs;
}

#[wasm_bindgen(typescript_custom_section)]
const EXTRUSION_DEFINITIONS_TYPES: &str = r#"
export type AnalyticStatusJs = { type: "complete" } | { type: "unsupported"; reason: string };
export type AnalyticSourceContextJs =
  | { kind: "direct"; representation_id: number }
  | { kind: "mapped"; representation_map_path: number[] };
export interface AnalyticSourceKeyJs {
  model_sha256: string; schema: string | null; length_unit_scale_bits: string;
  context: AnalyticSourceContextJs; solid_id: number;
}
export type AnalyticCurveSegmentJs =
  | { type: "line"; start: number[]; end: number[] }
  | { type: "arc"; center: number[]; normal: number[]; x_axis: number[];
      radius: number; start_angle: number; sweep_angle: number };
export interface AnalyticProfileLoopJs {
  kind: "outer" | "inner"; segments: AnalyticCurveSegmentJs[];
  signed_area: number; perimeter: number;
}
export interface AnalyticProfileJs {
  profile_id: number; ifc_type_name: string; ProfileType: string | null;
  Position: number | null; profile_position: number[] | null;
  loops: AnalyticProfileLoopJs[]; status: AnalyticStatusJs;
}
export interface AnalyticExtrusionJs {
  solid_id: number; SweptArea: number | null; profile: AnalyticProfileJs | null;
  Position: number | null; position_matrix: number[] | null;
  ExtrudedDirection: number | null; DirectionRatios: number[] | null;
  axis_unit_vector: number[] | null; Depth: number | null; status: AnalyticStatusJs;
}
export interface ExtrusionNominalQuantitiesJs {
  profile_area: number; projected_height: number; nominal_volume: number;
}
export interface ExtrusionDefinitionJs {
  key: AnalyticSourceKeyJs; source: AnalyticExtrusionJs;
  /** Squared/cubed IFC file-length units; null for unsupported or invalid sources. */
  nominal_quantities: ExtrusionNominalQuantitiesJs | null;
}
export interface ExtrusionInstanceJs {
  ordinal: number; source: AnalyticSourceKeyJs; product_id: number;
  solid_id: number; mapping_path: number[]; source_modified: boolean;
  world_from_source: number[] | null; status: AnalyticStatusJs;
}
export interface ExtrusionDefinitionsJs {
  up_axis: "Z"; source_units: "ifc_file_length_units"; world_units: "m";
  coordinate_space: "absolute_ifc_world"; model_sha256: string;
  schema: string | null; length_unit_scale: number;
  sources: ExtrusionDefinitionJs[];
  instances: Record<number, ExtrusionInstanceJs[]>; diagnostics: string[];
}
"#;

#[wasm_bindgen]
impl IfcAPI {
    /// `ids` is an optional product STEP-ID filter; `None` selects all and
    /// `Some([])` selects no products, matching the Rust and Python APIs.
    /// Matrices are column-major f64; profile_position and position_matrix are
    /// applied before world_from_source. No mesh is decoded on this path.
    #[wasm_bindgen(js_name = extrusionDefinitions)]
    pub fn extrusion_definitions(&self, content: &[u8], ids: Option<Vec<u32>>) -> Result<ExtrusionDefinitionsJs, JsValue> {
        let wanted = ids.map(|ids| ids.into_iter().collect::<HashSet<_>>());
        let view = ifc_lite_processing::extract_extrusion_definitions(content, wanted.as_ref());
        let serializer = serde_wasm_bindgen::Serializer::new()
            .serialize_maps_as_objects(true).serialize_missing_as_null(true);
        ExtrusionDefinitionsView::from(&view).serialize(&serializer)
            .map(|value| value.unchecked_into())
            .map_err(|error| JsValue::from_str(&format!("extrusionDefinitions serialization failed: {error}")))
    }
}
