// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Parsing and entity scanning methods for IFC-Lite API

use super::IfcAPI;
use ifc_lite_core::{EntityScanner, ParseEvent};
use js_sys::{Function, Promise};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::spawn_local;

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

fn is_relevant_metadata_type(type_name: &str) -> bool {
    matches!(
        type_name,
        "IFCWALL"
            | "IFCWALLSTANDARDCASE"
            | "IFCDOOR"
            | "IFCWINDOW"
            | "IFCSLAB"
            | "IFCCOLUMN"
            | "IFCBEAM"
            | "IFCROOF"
            | "IFCSTAIR"
            | "IFCSTAIRFLIGHT"
            | "IFCRAILING"
            | "IFCRAMP"
            | "IFCRAMPFLIGHT"
            | "IFCPLATE"
            | "IFCMEMBER"
            | "IFCCURTAINWALL"
            | "IFCFOOTING"
            | "IFCPILE"
            | "IFCBUILDINGELEMENTPROXY"
            | "IFCFURNISHINGELEMENT"
            | "IFCFLOWSEGMENT"
            | "IFCFLOWTERMINAL"
            | "IFCFLOWCONTROLLER"
            | "IFCFLOWFITTING"
            | "IFCSPACE"
            | "IFCOPENINGELEMENT"
            | "IFCSITE"
            | "IFCBUILDING"
            | "IFCBUILDINGSTOREY"
            | "IFCPROJECT"
            | "IFCFACILITY"
            | "IFCFACILITYPART"
            | "IFCBRIDGE"
            | "IFCBRIDGEPART"
            | "IFCROAD"
            | "IFCROADPART"
            | "IFCRAILWAY"
            | "IFCRAILWAYPART"
            | "IFCMARINEFACILITY"
            | "IFCMAPCONVERSION"
            | "IFCPROJECTEDCRS"
            | "IFCRELAGGREGATES"
            | "IFCRELCONTAINEDINSPATIALSTRUCTURE"
            | "IFCRELDEFINESBYTYPE"
            | "IFCRELVOIDSELEMENT"
            | "IFCRELFILLSELEMENT"
            | "IFCRELCONNECTSPATHELEMENTS"
            | "IFCRELCONNECTSELEMENTS"
            | "IFCRELSPACEBOUNDARY"
            | "IFCRELASSIGNSTOGROUP"
            | "IFCRELASSIGNSTOPRODUCT"
            | "IFCRELREFERENCEDINSPATIALSTRUCTURE"
            | "IFCRELDEFINESBYPROPERTIES"
            | "IFCPROPERTYSET"
            | "IFCPROPERTYSINGLEVALUE"
            | "IFCPROPERTYENUMERATEDVALUE"
            | "IFCPROPERTYBOUNDEDVALUE"
            | "IFCPROPERTYLISTVALUE"
            | "IFCPROPERTYTABLEVALUE"
            | "IFCPROPERTYREFERENCEVALUE"
            | "IFCCOMPLEXPROPERTY"
            | "IFCELEMENTQUANTITY"
            | "IFCQUANTITYLENGTH"
            | "IFCQUANTITYAREA"
            | "IFCQUANTITYVOLUME"
            | "IFCQUANTITYCOUNT"
            | "IFCQUANTITYWEIGHT"
            | "IFCQUANTITYTIME"
            | "IFCRELASSOCIATESMATERIAL"
            | "IFCRELASSOCIATESCLASSIFICATION"
            | "IFCRELASSOCIATESDOCUMENT"
            | "IFCCOVERING"
            | "IFCANNOTATION"
            | "IFCGRID"
    ) || type_name.ends_with("TYPE")
}

#[wasm_bindgen]
impl IfcAPI {
    /// Parse IFC file with streaming events
    /// Calls the callback function for each parse event
    ///
    /// Example:
    /// ```javascript
    /// const api = new IfcAPI();
    /// await api.parseStreaming(ifcData, (event) => {
    ///   console.log('Event:', event);
    /// });
    /// ```
    #[wasm_bindgen(js_name = parseStreaming)]
    pub fn parse_streaming(&self, content: String, callback: Function) -> Promise {
        use futures_util::StreamExt;
        use ifc_lite_core::StreamConfig;

        // Use Option::take() to move ownership into the closure without cloning.
        // This avoids doubling WASM memory usage for large files.
        let mut content = Some(content);
        let mut callback = Some(callback);
        let promise = Promise::new(&mut |resolve, reject| {
            let content = content.take().expect("content already taken");
            let callback = callback.take().expect("callback already taken");
            let reject = reject.clone();
            spawn_local(async move {
                let config = StreamConfig::default();
                let mut stream = ifc_lite_core::parse_stream(&content, config);

                while let Some(event) = stream.next().await {
                    // Convert event to JsValue and call callback
                    let event_obj = parse_event_to_js(&event);
                    if let Err(e) = callback.call1(&JsValue::NULL, &event_obj) {
                        let _ = reject.call1(&JsValue::NULL, &e);
                        return;
                    }

                    // Check if this is the completion event
                    if matches!(event, ParseEvent::Completed { .. }) {
                        if let Err(e) = resolve.call0(&JsValue::NULL) {
                            let _ = reject.call1(&JsValue::NULL, &e);
                        }
                        return;
                    }
                }

                if let Err(e) = resolve.call0(&JsValue::NULL) {
                    let _ = reject.call1(&JsValue::NULL, &e);
                }
            });
        });

        promise
    }

    /// Parse IFC file (traditional - waits for completion)
    ///
    /// Example:
    /// ```javascript
    /// const api = new IfcAPI();
    /// const result = await api.parse(ifcData);
    /// console.log('Entities:', result.entityCount);
    /// ```
    #[wasm_bindgen]
    pub fn parse(&self, content: String) -> Promise {
        // Use Option::take() to move ownership into the closure without cloning.
        let mut content = Some(content);
        let promise = Promise::new(&mut |resolve, reject| {
            let content = content.take().expect("content already taken");
            let reject = reject.clone();
            spawn_local(async move {
                // Quick scan to get entity count
                let mut scanner = EntityScanner::new(&content);
                let counts = scanner.count_by_type();

                let total_entities: usize = counts.values().sum();

                // Create result object
                let result = js_sys::Object::new();
                super::set_js_prop(
                    &result,
                    "entityCount",
                    &JsValue::from_f64(total_entities as f64),
                );
                super::set_js_prop(&result, "entityTypes", &super::counts_to_js(&counts));

                if let Err(e) = resolve.call1(&JsValue::NULL, &result) {
                    let _ = reject.call1(&JsValue::NULL, &e);
                }
            });
        });

        promise
    }

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

    /// Fast scan that only returns metadata-relevant entity refs.
    /// This drastically reduces transfer size for huge-file metadata hydration.
    #[wasm_bindgen(js_name = scanRelevantEntitiesFastBytes)]
    pub fn scan_relevant_entities_fast_bytes(&self, data: &[u8]) -> JsValue {
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

        // HEADER fields may carry non-UTF-8 bytes (Latin-1/Windows-1252).
        // Validate first; only allocate a sanitized, length-preserving buffer
        // when invalid so entity byte offsets stay aligned to the original
        // buffer JS re-reads.
        let owned: String;
        let content: &str = match std::str::from_utf8(data) {
            Ok(s) => s,
            Err(_) => {
                owned = sanitize_ascii(data);
                &owned
            }
        };
        let mut scanner = EntityScanner::new(content);
        let mut refs = Vec::new();
        let bytes = content.as_bytes();
        let mut last_position = 0;
        let mut line_count = 1;
        let mut type_cache: rustc_hash::FxHashMap<&str, Option<String>> =
            rustc_hash::FxHashMap::default();

        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            if start > last_position {
                line_count += bytes[last_position..start]
                    .iter()
                    .filter(|&&b| b == b'\n')
                    .count();
            }

            let cached = type_cache
                .entry(type_name)
                .or_insert_with(|| {
                    let upper = type_name.to_ascii_uppercase();
                    if is_relevant_metadata_type(&upper) {
                        Some(upper)
                    } else {
                        None
                    }
                });

            if let Some(entity_type) = cached {
                refs.push(EntityRefJs {
                    express_id: id,
                    entity_type: entity_type.clone(),
                    byte_offset: start,
                    byte_length: end - start,
                    line_number: line_count,
                });
            }

            last_position = end;
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
