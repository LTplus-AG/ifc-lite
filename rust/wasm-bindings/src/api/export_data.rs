// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! WASM API: tabular / semantic data exporters — CSV, JSON, JSON-LD.

use super::IfcAPI;
use ifc_lite_export::{CsvMode, CsvOptions, Ifc5Options, JsonLdOptions, JsonOptions};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Export tabular **CSV**. `mode` ∈ {`"entities"`, `"properties"`, `"quantities"`,
    /// `"spatial"`}. `delimiter` defaults to `,` when empty; `include_properties` adds
    /// flattened `Pset_Prop` columns to the entities view.
    #[wasm_bindgen(js_name = exportCsv)]
    pub fn export_csv(
        &self,
        content: &[u8],
        mode: String,
        delimiter: String,
        include_properties: bool,
    ) -> String {
        let mode = match mode.as_str() {
            "properties" => CsvMode::Properties,
            "quantities" => CsvMode::Quantities,
            "spatial" => CsvMode::SpatialHierarchy,
            _ => CsvMode::Entities,
        };
        let opts = CsvOptions {
            delimiter: if delimiter.is_empty() { ",".to_string() } else { delimiter },
            include_properties,
        };
        ifc_lite_export::export_csv(content, mode, &opts)
    }

    /// Export structured **JSON** (array of entity objects with typed property values).
    #[wasm_bindgen(js_name = exportJson)]
    pub fn export_json(
        &self,
        content: &[u8],
        pretty: bool,
        include_properties: bool,
        include_quantities: bool,
    ) -> String {
        let opts = JsonOptions { pretty, include_properties, include_quantities };
        ifc_lite_export::export_json(content, &opts)
    }

    /// Export **JSON-LD** (`@graph` of `ifc:` nodes). Empty `context` ⇒ buildingSMART
    /// IFC4 OWL default. `included` is an express-id isolation filter mirroring the
    /// OBJ/glTF/STEP exporters (empty ⇒ all entities).
    #[wasm_bindgen(js_name = exportJsonld)]
    pub fn export_jsonld(
        &self,
        content: &[u8],
        context: String,
        include_properties: bool,
        include_quantities: bool,
        pretty: bool,
        included: &[u32],
    ) -> String {
        let mut opts = JsonLdOptions {
            include_properties,
            include_quantities,
            pretty,
            included: included.to_vec(),
            ..Default::default()
        };
        if !context.is_empty() {
            opts.context = context;
        }
        ifc_lite_export::export_jsonld(content, &opts)
    }

    /// Export **IFC5 / IFCX** (the USD-style node graph). `only_known_properties` keeps
    /// only properties with an official IFC5 schema.
    #[wasm_bindgen(js_name = exportIfcx)]
    pub fn export_ifcx(
        &self,
        content: &[u8],
        only_known_properties: bool,
        pretty: bool,
    ) -> String {
        let opts = Ifc5Options { only_known_properties, pretty, ..Default::default() };
        ifc_lite_export::export_ifc5(content, &opts)
    }
}
