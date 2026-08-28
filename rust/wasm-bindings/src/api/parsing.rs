// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Parsing and entity scanning methods for IFC-Lite API

use super::IfcAPI;
use ifc_lite_core::EntityScanner;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl IfcAPI {
    /// Fast entity scanning using SIMD-accelerated Rust scanner
    /// Returns array of entity references for data model parsing
    /// Much faster than TypeScript byte-by-byte scanning (5-10x speedup)
    #[wasm_bindgen(js_name = scanEntitiesFast)]
    pub fn scan_entities_fast(&self, content: &str) -> JsValue {
        Self::scan_entities_fast_inner(content.as_bytes())
    }

    /// Fast entity scanning from raw bytes (avoids TextDecoder.decode on JS side).
    /// Accepts Uint8Array directly — saves ~2-5s for 487MB files by skipping
    /// JS string creation and UTF-16→UTF-8 conversion.
    #[wasm_bindgen(js_name = scanEntitiesFastBytes)]
    pub fn scan_entities_fast_bytes(&self, data: &[u8]) -> JsValue {
        Self::scan_entities_fast_inner(data)
    }

    fn scan_entities_fast_inner(content: &[u8]) -> JsValue {
        use serde::{Deserialize, Serialize};
        use serde_wasm_bindgen::to_value;

        #[derive(Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct EntityRefJs {
            express_id: u32,
            #[serde(rename = "type")]
            entity_type: String,
            byte_offset: usize,
            byte_length: usize,
            line_number: usize,
        }

        let mut scanner = EntityScanner::new(content);
        let mut refs = Vec::new();
        let bytes = content;

        // Track line numbers efficiently: count newlines up to each entity start
        let mut last_position = 0;
        let mut line_count = 1; // Start at line 1

        // Cache type name strings: ~776 unique types repeated across 8M+ entities
        let mut type_cache: rustc_hash::FxHashMap<&str, String> = rustc_hash::FxHashMap::default();

        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            // Count newlines between last position and current start
            if start > last_position {
                line_count += bytes[last_position..start]
                    .iter()
                    .filter(|&&b| b == b'\n')
                    .count();
            }

            let entity_type = type_cache
                .entry(type_name)
                .or_insert_with(|| type_name.to_string())
                .clone();

            refs.push(EntityRefJs {
                express_id: id,
                entity_type,
                byte_offset: start,
                byte_length: end - start,
                line_number: line_count,
            });

            last_position = end;
        }

        // The scanner drops records whose instance name does not fit `u32`
        // (issue #3395). Dropping them is the only outcome the u32 express-id
        // columns can hold, but a load that comes back quietly short reads
        // exactly like a load that had nothing to drop — so say it. The message
        // and its destination are core's (the module's `init` bound the sink to
        // the browser console), so this entry point cannot word it differently
        // from the four others that now report the same refusal.
        ifc_lite_core::report_oversized_ids(scanner.skipped_oversized_ids());

        to_value(&refs).unwrap_or_else(|_| js_sys::Array::new().into())
    }

    /// Fast geometry-only entity scanning
    /// Scans only entities that have geometry, skipping 99% of non-geometry entities
    /// Returns array of geometry entity references for parallel processing
    /// Much faster than scanning all entities (3x speedup for large files)
    #[wasm_bindgen(js_name = scanGeometryEntitiesFast)]
    pub fn scan_geometry_entities_fast(&self, content: &str) -> JsValue {
        use serde::{Deserialize, Serialize};
        use serde_wasm_bindgen::to_value;

        #[derive(Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct GeometryEntityRefJs {
            express_id: u32,
            #[serde(rename = "type")]
            entity_type: String,
            byte_offset: usize,
            byte_length: usize,
        }

        let mut scanner = EntityScanner::new(content.as_bytes());
        let mut refs = Vec::new();

        // Only scan entities that have geometry - skip IFCCARTESIANPOINT, IFCDIRECTION, etc.
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            // Fast filter: only process entities that can have geometry
            if ifc_lite_core::has_geometry_by_name(type_name) {
                refs.push(GeometryEntityRefJs {
                    express_id: id,
                    entity_type: type_name.to_string(),
                    byte_offset: start,
                    byte_length: end - start,
                });
            }
        }

        // Same refusal, same report: this scan filters to geometry-bearing
        // entities, but the records the scanner refused never reached the
        // filter, so a caller here is as short as one on the full scan (#3395).
        ifc_lite_core::report_oversized_ids(scanner.skipped_oversized_ids());

        to_value(&refs).unwrap_or_else(|_| js_sys::Array::new().into())
    }

}
