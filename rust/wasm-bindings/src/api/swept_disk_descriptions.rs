// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Exact authored swept-disk descriptions at the browser boundary.

use std::collections::{BTreeMap, HashSet};

use super::IfcAPI;
use ifc_lite_processing::{
    extract_swept_disk_descriptions, SweptDiskDescriptions, SweptDiskOccurrence,
};
use serde::Serialize;
use wasm_bindgen::prelude::*;

/// Share the processing extractor with the native and Python APIs. `None`
/// selects all products; a present empty list selects none.
fn extract(content: &[u8], ids: Option<Vec<u32>>) -> SweptDiskDescriptions {
    let wanted: Option<HashSet<u32>> = ids.map(|values| values.into_iter().collect());
    extract_swept_disk_descriptions(content, wanted.as_ref())
}

/// `serde-wasm-bindgen` requires string keys for JS objects. Borrow each
/// occurrence list while converting only the product IDs, so this remains the
/// processing schema without cloning all of its analytic geometry.
#[derive(Serialize)]
struct SweptDiskDescriptionsJs<'a> {
    up_axis: &'a str,
    units: &'a str,
    coordinate_space: &'a str,
    elements: BTreeMap<String, &'a Vec<SweptDiskOccurrence>>,
    diagnostics: &'a [String],
}

impl<'a> From<&'a SweptDiskDescriptions> for SweptDiskDescriptionsJs<'a> {
    fn from(value: &'a SweptDiskDescriptions) -> Self {
        Self {
            up_axis: value.up_axis,
            units: value.units,
            coordinate_space: value.coordinate_space,
            elements: value
                .elements
                .iter()
                .map(|(id, disks)| (id.to_string(), disks))
                .collect(),
            diagnostics: &value.diagnostics,
        }
    }
}

#[wasm_bindgen]
impl IfcAPI {
    /// Return authored swept-disk occurrences, including exact line/arc
    /// directrices and derived measurements, in absolute IFC Z-up metres.
    /// `ids` contains product STEP IDs; omit it for all products or pass an
    /// empty `Uint32Array` for none. Unsupported records keep their status and
    /// a null `directrix_metrics`; malformed representation walks report a
    /// diagnostic and omit that product atomically.
    #[wasm_bindgen(js_name = extractSweptDiskDescriptions)]
    pub fn extract_swept_disk_descriptions(
        &self,
        content: &[u8],
        ids: Option<Vec<u32>>,
    ) -> Result<JsValue, JsValue> {
        let descriptions = extract(content, ids);
        // JS object keys preserve the product IDs as strings. Use explicit
        // nulls for absent IFC/derived values, matching the Python JSON API.
        let serializer = serde_wasm_bindgen::Serializer::new()
            .serialize_maps_as_objects(true)
            .serialize_missing_as_null(true);
        SweptDiskDescriptionsJs::from(&descriptions)
            .serialize(&serializer)
            .map_err(|error| {
                JsValue::from_str(&format!("swept-disk serialization failed: {error}"))
            })
    }
}

#[cfg(test)]
#[path = "swept_disk_descriptions_tests.rs"]
mod tests;
