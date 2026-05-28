// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 2D symbol extraction for the browser. Thin wrapper over the canonical
//! extractor in `ifc-lite-processing` so the browser and the HTTP server
//! produce bit-identical symbol streams (issue #843 follow-up: full
//! parity, no separate code paths).
//!
//! The heavy lifting — Transform2D composition, IfcGrid bubbles,
//! IfcTrimmedCurve arc handling, IfcAnnotationFillArea with holes,
//! IfcStyledItem colour resolution, etc. — lives in
//! `rust/processing/src/symbolic.rs`. This file just converts the
//! resulting pure-Rust `SymbolicData` into the `wasm_bindgen` types the
//! JS layer consumes.

use super::IfcAPI;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Parse IFC file and extract symbolic representations (Plan,
    /// Annotation, FootPrint, Axis). These are 2D curves used for
    /// architectural drawings instead of sectioning 3D geometry.
    ///
    /// Example:
    /// ```javascript
    /// const api = new IfcAPI();
    /// const symbols = api.parseSymbolicRepresentations(ifcData);
    /// console.log('Found', symbols.totalCount, 'symbolic items');
    /// for (let i = 0; i < symbols.polylineCount; i++) {
    ///   const polyline = symbols.getPolyline(i);
    ///   console.log('Polyline for', polyline.ifcType, ':', polyline.points);
    /// }
    /// ```
    #[wasm_bindgen(js_name = parseSymbolicRepresentations)]
    pub fn parse_symbolic_representations(
        &self,
        content: String,
    ) -> crate::zero_copy::SymbolicRepresentationCollection {
        let data = ifc_lite_processing::extract_symbolic_data(&content);
        crate::zero_copy::SymbolicRepresentationCollection::from_data(data)
    }
}
