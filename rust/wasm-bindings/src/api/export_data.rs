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
    ) -> Vec<u8> {
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
        ifc_lite_export::export_csv(content, mode, &opts).into_bytes()
    }

    /// Export structured **JSON** (array of entity objects with typed property values).
    #[wasm_bindgen(js_name = exportJson)]
    pub fn export_json(
        &self,
        content: &[u8],
        pretty: bool,
        include_properties: bool,
        include_quantities: bool,
    ) -> Vec<u8> {
        let opts = JsonOptions { pretty, include_properties, include_quantities };
        ifc_lite_export::export_json(content, &opts).into_bytes()
    }

    /// Export **JSON-LD** (`@graph` of `ifc:` nodes). Empty `context` ⇒ buildingSMART
    /// IFC4 OWL default.
    ///
    /// `included` is an express-id isolation filter mirroring `exportObj` /
    /// `exportGlb`, and carries the same null-vs-empty distinction across the wasm
    /// boundary: omit it (`undefined`) for "no isolation filter" (every entity is
    /// emitted); pass an empty `Uint32Array` for "isolation is ACTIVE and currently
    /// matches nothing", which emits an empty `@graph`. Collapsing the two — as a
    /// bare `Uint32Array` parameter would force a caller to do — silently exported
    /// the whole model when a filter matched nothing (#4659, the JSON-LD twin of
    /// #4483/#4484). A non-empty `Uint32Array` is the ordinary allowlist.
    #[wasm_bindgen(js_name = exportJsonld)]
    pub fn export_jsonld(
        &self,
        content: &[u8],
        context: String,
        include_properties: bool,
        include_quantities: bool,
        pretty: bool,
        included: Option<Vec<u32>>,
    ) -> Vec<u8> {
        let mut opts = JsonLdOptions {
            include_properties,
            include_quantities,
            pretty,
            ..Default::default()
        };
        if !context.is_empty() {
            opts.context = context;
        }
        ifc_lite_export::export_jsonld_with_filter(content, &opts, included.as_deref()).into_bytes()
    }

    /// Export **IFC5 / IFCX** (the USD-style node graph). `only_known_properties` keeps
    /// only properties with an official IFC5 schema.
    #[wasm_bindgen(js_name = exportIfcx)]
    pub fn export_ifcx(
        &self,
        content: &[u8],
        only_known_properties: bool,
        pretty: bool,
    ) -> Vec<u8> {
        let opts = Ifc5Options { only_known_properties, pretty, ..Default::default() };
        ifc_lite_export::export_ifc5(content, &opts).into_bytes()
    }

    /// Export **OpenUSD** (`.usda` ASCII): a real Z-up USD stage — spatial hierarchy of
    /// `Xform` prims, `UsdGeomMesh` geometry, `UsdPreviewSurface` materials, IFC
    /// metadata as custom attributes. Whole-model (geometry-backed).
    #[wasm_bindgen(js_name = exportUsd)]
    pub fn export_usd(&self, content: &[u8]) -> Vec<u8> {
        ifc_lite_export::export_usd(content, &Default::default()).into_bytes()
    }
}
