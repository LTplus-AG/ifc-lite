// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! WASM API: export_step — re-serialize the parsed model to STEP/IFC (ISO-10303-21).

use super::IfcAPI;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Export-only exact section intersections in IFC world metres.
    #[wasm_bindgen(js_name = planSectionExport)]
    pub fn plan_section_export(&self, content: &[u8], planes_json: &str, trim: bool) -> Result<String, JsError> {
        let planes = serde_json::from_str::<Vec<ifc_lite_export::SectionExportPlane>>(planes_json)
            .map_err(|error| JsError::new(&error.to_string()))?;
        let plan = ifc_lite_export::plan_section_export(content, &planes, trim)
            .map_err(|error| JsError::new(&error))?;
        serde_json::to_string(&plan).map_err(|error| JsError::new(&error.to_string()))
    }

    /// Plan opt-in map similarity normalization on a completed STEP export.
    /// Returns entity patches, allocated IDs and atomic refusal warnings as JSON.
    #[wasm_bindgen(js_name = planMapConversionNormalization)]
    pub fn plan_map_conversion_normalization(&self, content: &[u8]) -> Result<String, JsError> {
        let plan = ifc_lite_export::plan_map_conversion_normalization(content)
            .map_err(|error| JsError::new(&format!("planMapConversionNormalization: {error}")))?;
        serde_json::to_string(&plan)
            .map_err(|error| JsError::new(&format!("planMapConversionNormalization: {error}")))
    }

    /// Re-serialize the model in `content` to STEP/IFC UTF-8 bytes.
    ///
    /// Returned as UTF-8 bytes (`Uint8Array`) so output is not capped by the
    /// V8 max-string ceiling (~512 MB); decode with `TextDecoder` when a string
    /// is genuinely needed.
    ///
    /// `schema` is the FILE_SCHEMA label to write (empty ⇒ preserve the source schema).
    ///
    /// `included` is an express-id allowlist carrying the same null-vs-empty
    /// distinction as `exportObj` / `exportGlb`: omit it (`undefined`) for "no
    /// isolation filter" (whole model); pass an empty `Uint32Array` for "isolation
    /// is ACTIVE and currently matches nothing", which writes a header-only file
    /// with an empty `DATA;` section. Collapsing the two — as a bare `Uint32Array`
    /// parameter would force a caller to do — silently exported the whole model
    /// when a filter matched nothing (#4659, the STEP twin of #4483/#4484). When
    /// set, the forward `#`-reference closure is added so the subset never dangles
    /// a reference.
    /// `mutations_json` carries `MutablePropertyView` edits; empty ⇒ none. It is
    /// either the mutation log `MutablePropertyView.exportMutations()` returns
    /// (an object with a `mutations` array, optionally `newEntities` and
    /// `georefMutations`), written with byte parity to the TypeScript
    /// `StepExporter` (#5941), or the older pre-serialized
    /// `{ attributeUpdates, propertyMutations }` shape. A log does not combine
    /// with `included`. See `export_step_json` for both shapes.
    /// A non-empty but malformed `mutations_json` throws rather than silently
    /// exporting the model with none of the caller's edits applied — mirrors
    /// `exportGlb`'s and `exportMerged`'s fail-closed contract on this same API.
    #[wasm_bindgen(js_name = exportStep)]
    pub fn export_step(
        &self,
        content: &[u8],
        schema: String,
        included: Option<Vec<u32>>,
        mutations_json: String,
    ) -> Result<Vec<u8>, JsError> {
        // Returned as `Err`, not thrown with `throw_str`: a throw from inside a
        // `&self` method leaves the instance's borrow flag held, so the host's
        // later `free()` fails with "attempted to take ownership of Rust value
        // while it was borrowed". An `Err` is thrown by the glue after the
        // borrow is released, and the JS contract (it throws, message prefixed
        // `exportStep:`) is unchanged.
        ifc_lite_export::export_step_json(
            content,
            if schema.is_empty() { None } else { Some(schema) },
            included,
            &mutations_json,
        )
        .map(String::into_bytes)
        .map_err(|msg| JsError::new(&format!("exportStep: {msg}")))
    }

    /// Merge several IFC models into one STEP/IFC UTF-8 byte buffer (`Uint8Array`).
    /// `concatenated` is every model's
    /// bytes laid end-to-end; `lengths[i]` is the byte length of model `i`. The first model
    /// keeps its ids; later models are id-offset and their project unified to the first.
    #[wasm_bindgen(js_name = exportMerged)]
    pub fn export_merged(
        &self,
        concatenated: &[u8],
        lengths: &[u32],
        schema: String,
    ) -> Result<Vec<u8>, JsError> {
        // Strict segmentation: a malformed `lengths` (overflow, out-of-bounds, or not
        // summing to the buffer) must surface an error rather than silently dropping a
        // model and returning a partial merge. Returned as `Err`, not thrown with
        // `throw_str`, for the reason `exportStep` gives: a throw inside `&self`
        // leaves the borrow held, so the host could never `free()` the API (#7677).
        let models = segment_models(concatenated, lengths).map_err(|msg| JsError::new(&format!("exportMerged: {msg}")))?;
        let opts = ifc_lite_export::MergedOptions {
            schema: if schema.is_empty() { None } else { Some(schema) },
            ..Default::default()
        };
        Ok(ifc_lite_export::export_merged(&models, &opts).into_bytes())
    }
}

/// Split `concatenated` into one slice per `lengths` entry, refusing an
/// overflowing, out-of-bounds or incomplete segmentation.
fn segment_models<'a>(concatenated: &'a [u8], lengths: &[u32]) -> Result<Vec<&'a [u8]>, &'static str> {
    let mut models: Vec<&[u8]> = Vec::with_capacity(lengths.len());
    let mut off = 0usize;
    for &len in lengths {
        let end = off.checked_add(len as usize).ok_or("segment length overflow")?;
        let model = concatenated.get(off..end).ok_or("segment lengths exceed concatenated buffer")?;
        models.push(model);
        off = end;
    }
    if off != concatenated.len() {
        return Err("segment lengths do not cover the whole buffer");
    }
    Ok(models)
}
