// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Parsing and entity scanning methods for IFC-Lite API

use super::IfcAPI;
use ifc_lite_core::{EntityScanner, ParseEvent};
use wasm_bindgen::prelude::*;

/// Length-preserving replacement of every non-ASCII byte (>= 0x80) with `b'?'`.
///
/// Real IFC/STEP files routinely contain Latin-1 / Windows-1252 bytes in the
/// HEADER section (e.g. accented author names), which are invalid UTF-8.
/// Building a `&str` from such bytes via `from_utf8_unchecked` is undefined
/// behavior, so callers validate first and only fall back to this when the
/// bytes are not valid UTF-8. Each invalid byte is replaced 1:1 so the byte
/// offsets returned to JS stay aligned to the original buffer (JS re-reads it
/// via safeUtf8Decode). ASCII — including the entire DATA section — is
/// untouched.
fn sanitize_ascii(data: &[u8]) -> String {
    let mut buf = data.to_vec();
    for b in buf.iter_mut() {
        if *b >= 0x80 {
            *b = b'?';
        }
    }
    // SAFETY-equivalent: every byte is now < 0x80, i.e. valid ASCII / UTF-8,
    // so this conversion cannot fail.
    String::from_utf8(buf).expect("ascii after sanitize")
}


#[wasm_bindgen]
impl IfcAPI {
    /// Fast entity scanning using SIMD-accelerated Rust scanner
    /// Returns array of entity references for data model parsing
    /// Much faster than TypeScript byte-by-byte scanning (5-10x speedup)
    #[wasm_bindgen(js_name = scanEntitiesFast)]
    pub fn scan_entities_fast(&self, content: &str) -> JsValue {
        Self::scan_entities_fast_inner(content)
    }

    /// Fast entity scanning from raw bytes (avoids TextDecoder.decode on JS side).
    /// Accepts Uint8Array directly — saves ~2-5s for 487MB files by skipping
    /// JS string creation and UTF-16→UTF-8 conversion.
    #[wasm_bindgen(js_name = scanEntitiesFastBytes)]
    pub fn scan_entities_fast_bytes(&self, data: &[u8]) -> JsValue {
        // IFC/STEP DATA is ASCII, but HEADER fields may carry non-UTF-8 bytes
        // (Latin-1/Windows-1252). Validate first; only allocate a sanitized,
        // length-preserving buffer when invalid so entity byte offsets stay
        // aligned to the original buffer JS re-reads.
        let owned: String;
        let content: &str = match std::str::from_utf8(data) {
            Ok(s) => s,
            Err(_) => {
                owned = sanitize_ascii(data);
                &owned
            }
        };
        Self::scan_entities_fast_inner(content)
    }

    fn scan_entities_fast_inner(content: &str) -> JsValue {
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
        let bytes = content.as_bytes();

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

        let mut scanner = EntityScanner::new(content);
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

        to_value(&refs).unwrap_or_else(|_| js_sys::Array::new().into())
    }

}

/// Convert ParseEvent to JavaScript object
fn parse_event_to_js(event: &ParseEvent) -> JsValue {
    let obj = js_sys::Object::new();

    match event {
        ParseEvent::Started {
            file_size,
            timestamp,
        } => {
            super::set_js_prop(&obj, "type", &"started".into());
            super::set_js_prop(&obj, "fileSize", &(*file_size as f64).into());
            super::set_js_prop(&obj, "timestamp", &(*timestamp).into());
        }
        ParseEvent::EntityScanned {
            id,
            ifc_type,
            position,
        } => {
            super::set_js_prop(&obj, "type", &"entityScanned".into());
            super::set_js_prop(&obj, "id", &(*id as f64).into());
            super::set_js_prop(&obj, "ifcType", &ifc_type.as_str().into());
            super::set_js_prop(&obj, "position", &(*position as f64).into());
        }
        ParseEvent::GeometryReady {
            id,
            vertex_count,
            triangle_count,
        } => {
            super::set_js_prop(&obj, "type", &"geometryReady".into());
            super::set_js_prop(&obj, "id", &(*id as f64).into());
            super::set_js_prop(&obj, "vertexCount", &(*vertex_count as f64).into());
            super::set_js_prop(&obj, "triangleCount", &(*triangle_count as f64).into());
        }
        ParseEvent::Progress {
            phase,
            percent,
            entities_processed,
            total_entities,
        } => {
            super::set_js_prop(&obj, "type", &"progress".into());
            super::set_js_prop(&obj, "phase", &phase.as_str().into());
            super::set_js_prop(&obj, "percent", &(*percent as f64).into());
            super::set_js_prop(
                &obj,
                "entitiesProcessed",
                &(*entities_processed as f64).into(),
            );
            super::set_js_prop(&obj, "totalEntities", &(*total_entities as f64).into());
        }
        ParseEvent::Completed {
            duration_ms,
            entity_count,
            triangle_count,
        } => {
            super::set_js_prop(&obj, "type", &"completed".into());
            super::set_js_prop(&obj, "durationMs", &(*duration_ms).into());
            super::set_js_prop(&obj, "entityCount", &(*entity_count as f64).into());
            super::set_js_prop(&obj, "triangleCount", &(*triangle_count as f64).into());
        }
        ParseEvent::Error { message, position } => {
            super::set_js_prop(&obj, "type", &"error".into());
            super::set_js_prop(&obj, "message", &message.as_str().into());
            if let Some(pos) = position {
                super::set_js_prop(&obj, "position", &(*pos as f64).into());
            }
        }
    }

    obj.into()
}
