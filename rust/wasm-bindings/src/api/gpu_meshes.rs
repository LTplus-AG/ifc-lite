// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! GPU mesh parsing methods for IFC-Lite API
//!
//! Includes synchronous and async mesh parsing, instanced geometry,
//! and GPU-ready geometry generation.

use super::IfcAPI;
use crate::zero_copy::{MeshCollection, MeshDataJs};
use js_sys::Function;
use wasm_bindgen::prelude::*;

fn decode_ifc_bytes<'a>(data: &'a [u8]) -> &'a str {
    match std::str::from_utf8(data) {
        Ok(content) => content,
        Err(error) => wasm_bindgen::throw_str(&format!("Invalid UTF-8 IFC data: {error}")),
    }
}

#[wasm_bindgen]
impl IfcAPI {
    /// Run the pre-pass ONCE and return serialized results for worker distribution.
    /// Takes raw bytes (&[u8]) to avoid TextDecoder overhead.
    #[wasm_bindgen(js_name = buildPrePassOnce)]
    pub fn build_pre_pass_once(&self, data: &[u8]) -> JsValue {
        use super::styling::{combined_pre_pass, extract_building_rotation_from_site};
        use ifc_lite_core::EntityDecoder;
        use ifc_lite_geometry::GeometryRouter;

        let content = decode_ifc_bytes(data);

        // Build entity index — wrap in Arc so processGeometryBatch can
        // share it across many calls without cloning the HashMap.
        let entity_index = std::sync::Arc::new(ifc_lite_core::build_entity_index(content));
        // Cache for reuse by processGeometryBatch.
        // Mutex held only briefly to install the Arc; rayon helpers
        // pick up clones below without re-locking. Panic on poison —
        // an earlier panic with the lock held would mean the cached
        // index is in an inconsistent state.
        let mut slot = self
            .cached_entity_index
            .lock()
            .expect("ifc-lite cached_entity_index Mutex poisoned");
        *slot = Some(entity_index.clone());
        drop(slot);
        let mut decoder = EntityDecoder::with_arc_index(content, entity_index);

        // Run combined pre-pass
        let pre_pass = combined_pre_pass(content, &mut decoder);

        // Extract unit scale
        let unit_scale = pre_pass
            .project_id
            .and_then(|pid| ifc_lite_core::extract_length_unit_scale(&mut decoder, pid).ok())
            .unwrap_or(1.0);
        let mut router = GeometryRouter::with_scale(unit_scale);

        // Detect RTC offset
        let rtc_jobs: Vec<_> = pre_pass
            .simple_jobs
            .iter()
            .take(25)
            .chain(pre_pass.complex_jobs.iter().take(25))
            .copied()
            .collect();
        let rtc_offset = router
            .detect_rtc_offset_from_jobs(&rtc_jobs, &mut decoder)
            .unwrap_or((0.0, 0.0, 0.0));
        let needs_shift = rtc_offset.0.abs() > 10000.0
            || rtc_offset.1.abs() > 10000.0
            || rtc_offset.2.abs() > 10000.0;

        // Extract building rotation
        let building_rotation = pre_pass
            .site_position
            .and_then(|pos| extract_building_rotation_from_site(pos, &mut decoder));

        // Build combined job list: simple first, then complex
        let total_jobs = pre_pass.simple_jobs.len() + pre_pass.complex_jobs.len();

        // Serialize jobs as flat Uint32Array: [id, start, end, id, start, end, ...]
        let jobs_flat = js_sys::Uint32Array::new_with_length((total_jobs * 3) as u32);
        let mut idx = 0u32;
        for &(id, start, end, _ifc_type) in pre_pass
            .simple_jobs
            .iter()
            .chain(pre_pass.complex_jobs.iter())
        {
            jobs_flat.set_index(idx, id);
            jobs_flat.set_index(idx + 1, start as u32);
            jobs_flat.set_index(idx + 2, end as u32);
            idx += 3;
        }

        // Serialize void_index as 3 flat arrays: keys, counts, values
        let void_keys_vec: Vec<u32> = pre_pass.void_index.keys().copied().collect();
        let mut void_counts_vec: Vec<u32> = Vec::with_capacity(void_keys_vec.len());
        let mut void_values_vec: Vec<u32> = Vec::new();
        for &key in &void_keys_vec {
            if let Some(openings) = pre_pass.void_index.get(&key) {
                void_counts_vec.push(openings.len() as u32);
                void_values_vec.extend_from_slice(openings);
            }
        }

        let void_keys = js_sys::Uint32Array::new_with_length(void_keys_vec.len() as u32);
        for (i, &k) in void_keys_vec.iter().enumerate() {
            void_keys.set_index(i as u32, k);
        }
        let void_counts = js_sys::Uint32Array::new_with_length(void_counts_vec.len() as u32);
        for (i, &c) in void_counts_vec.iter().enumerate() {
            void_counts.set_index(i as u32, c);
        }
        let void_values = js_sys::Uint32Array::new_with_length(void_values_vec.len() as u32);
        for (i, &v) in void_values_vec.iter().enumerate() {
            void_values.set_index(i as u32, v);
        }

        // Serialize geometry_styles as two arrays: styleIds (u32) + styleColors (u8 RGBA)
        let styles_len = pre_pass.geometry_styles.len();
        let style_ids = js_sys::Uint32Array::new_with_length(styles_len as u32);
        let style_colors = js_sys::Uint8Array::new_with_length((styles_len * 4) as u32);
        let mut si = 0u32;
        for (&id, &color) in &pre_pass.geometry_styles {
            style_ids.set_index(si, id);
            let ci = si * 4;
            style_colors.set_index(ci, (color[0] * 255.0) as u8);
            style_colors.set_index(ci + 1, (color[1] * 255.0) as u8);
            style_colors.set_index(ci + 2, (color[2] * 255.0) as u8);
            style_colors.set_index(ci + 3, (color[3] * 255.0) as u8);
            si += 1;
        }

        // Serialize faceted_brep_ids
        let faceted_brep_ids =
            js_sys::Uint32Array::new_with_length(pre_pass.faceted_brep_ids.len() as u32);
        for (i, &id) in pre_pass.faceted_brep_ids.iter().enumerate() {
            faceted_brep_ids.set_index(i as u32, id);
        }

        // Build result object
        let result = js_sys::Object::new();
        super::set_js_prop(&result, "jobs", &jobs_flat);
        super::set_js_prop(&result, "totalJobs", &(total_jobs as f64).into());
        super::set_js_prop(&result, "unitScale", &unit_scale.into());

        let rtc_arr = js_sys::Float64Array::new_with_length(3);
        rtc_arr.set_index(0, rtc_offset.0);
        rtc_arr.set_index(1, rtc_offset.1);
        rtc_arr.set_index(2, rtc_offset.2);
        super::set_js_prop(&result, "rtcOffset", &rtc_arr);
        super::set_js_prop(&result, "needsShift", &needs_shift.into());

        match building_rotation {
            Some(rot) => super::set_js_prop(&result, "buildingRotation", &rot.into()),
            None => super::set_js_prop(&result, "buildingRotation", &JsValue::NULL),
        };

        super::set_js_prop(&result, "voidKeys", &void_keys);
        super::set_js_prop(&result, "voidCounts", &void_counts);
        super::set_js_prop(&result, "voidValues", &void_values);
        super::set_js_prop(&result, "styleIds", &style_ids);
        super::set_js_prop(&result, "styleColors", &style_colors);
        super::set_js_prop(&result, "facetedBrepIds", &faceted_brep_ids);

        result.into()
    }

    /// Fast pre-pass: scans for geometry entities ONLY (skips style/void/material resolution).
    /// Returns job list + unit scale + RTC offset in ~1-2s instead of ~6s.
    /// Geometry workers can start immediately with default colors + no void subtraction.
    /// A parallel style worker can run buildPrePassOnce for correct colors later.
    #[wasm_bindgen(js_name = buildPrePassFast)]
    pub fn build_pre_pass_fast(&self, data: &[u8]) -> JsValue {
        use super::styling::extract_building_rotation_from_site;
        use ifc_lite_core::{is_simple_geometry_type, EntityDecoder, EntityScanner, IfcType};
        use ifc_lite_geometry::GeometryRouter;

        let content = decode_ifc_bytes(data);

        let mut scanner = EntityScanner::new(content);
        let estimated = content.len() / 2000;
        let mut simple_jobs: Vec<(u32, usize, usize, IfcType)> = Vec::with_capacity(estimated / 2);
        let mut complex_jobs: Vec<(u32, usize, usize, IfcType)> = Vec::with_capacity(estimated / 2);
        let mut project_id: Option<u32> = None;
        let mut site_position: Option<(u32, usize, usize)> = None;

        // Fast scan: only collect geometry entity locations + project/site
        // Skip ALL style/void/material/brep collection
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            match type_name {
                "IFCPROJECT" => {
                    if project_id.is_none() {
                        project_id = Some(id);
                    }
                }
                "IFCSITE" => {
                    if site_position.is_none() {
                        site_position = Some((id, start, end));
                    }
                    let ifc_type = IfcType::from_str(type_name);
                    complex_jobs.push((id, start, end, ifc_type));
                }
                _ => {
                    if ifc_lite_core::has_geometry_by_name(type_name) {
                        let ifc_type = IfcType::from_str(type_name);
                        if is_simple_geometry_type(type_name) {
                            simple_jobs.push((id, start, end, ifc_type));
                        } else {
                            complex_jobs.push((id, start, end, ifc_type));
                        }
                    }
                }
            }
        }

        // Resolve unit scale + RTC offset (needs entity index for decoder).
        // Wrap in Arc so subsequent processGeometryBatch calls share by ref.
        let entity_index = std::sync::Arc::new(ifc_lite_core::build_entity_index(content));
        // Mutex held only briefly to install the Arc; rayon helpers
        // pick up clones below without re-locking. Panic on poison —
        // an earlier panic with the lock held would mean the cached
        // index is in an inconsistent state.
        let mut slot = self
            .cached_entity_index
            .lock()
            .expect("ifc-lite cached_entity_index Mutex poisoned");
        *slot = Some(entity_index.clone());
        drop(slot);
        let mut decoder = EntityDecoder::with_arc_index(content, entity_index);

        let unit_scale = project_id
            .and_then(|pid| ifc_lite_core::extract_length_unit_scale(&mut decoder, pid).ok())
            .unwrap_or(1.0);
        let mut router = GeometryRouter::with_scale(unit_scale);

        let rtc_jobs: Vec<_> = simple_jobs
            .iter()
            .take(25)
            .chain(complex_jobs.iter().take(25))
            .copied()
            .collect();
        let rtc_offset = router
            .detect_rtc_offset_from_jobs(&rtc_jobs, &mut decoder)
            .unwrap_or((0.0, 0.0, 0.0));
        let needs_shift = rtc_offset.0.abs() > 10000.0
            || rtc_offset.1.abs() > 10000.0
            || rtc_offset.2.abs() > 10000.0;

        let building_rotation =
            site_position.and_then(|pos| extract_building_rotation_from_site(pos, &mut decoder));

        // Serialize job list
        let total_jobs = simple_jobs.len() + complex_jobs.len();
        let jobs_flat = js_sys::Uint32Array::new_with_length((total_jobs * 3) as u32);
        let mut idx = 0u32;
        for &(id, start, end, _) in simple_jobs.iter().chain(complex_jobs.iter()) {
            jobs_flat.set_index(idx, id);
            jobs_flat.set_index(idx + 1, start as u32);
            jobs_flat.set_index(idx + 2, end as u32);
            idx += 3;
        }

        let result = js_sys::Object::new();
        super::set_js_prop(&result, "jobs", &jobs_flat);
        super::set_js_prop(&result, "totalJobs", &(total_jobs as f64).into());
        super::set_js_prop(&result, "unitScale", &unit_scale.into());

        let rtc_arr = js_sys::Float64Array::new_with_length(3);
        rtc_arr.set_index(0, rtc_offset.0);
        rtc_arr.set_index(1, rtc_offset.1);
        rtc_arr.set_index(2, rtc_offset.2);
        super::set_js_prop(&result, "rtcOffset", &rtc_arr);
        super::set_js_prop(&result, "needsShift", &needs_shift.into());

        match building_rotation {
            Some(rot) => super::set_js_prop(&result, "buildingRotation", &rot.into()),
            None => super::set_js_prop(&result, "buildingRotation", &JsValue::NULL),
        };

        // Empty style/void arrays — workers use default colors, no void subtraction
        super::set_js_prop(
            &result,
            "voidKeys",
            &js_sys::Uint32Array::new_with_length(0),
        );
        super::set_js_prop(
            &result,
            "voidCounts",
            &js_sys::Uint32Array::new_with_length(0),
        );
        super::set_js_prop(
            &result,
            "voidValues",
            &js_sys::Uint32Array::new_with_length(0),
        );
        super::set_js_prop(
            &result,
            "styleIds",
            &js_sys::Uint32Array::new_with_length(0),
        );
        super::set_js_prop(
            &result,
            "styleColors",
            &js_sys::Uint8Array::new_with_length(0),
        );

        result.into()
    }

    /// Streaming pre-pass: emits geometry jobs in chunks via a JS callback
    /// instead of waiting for the full file scan to complete.
    ///
    /// Single linear walk over the file:
    ///   1. Builds the entity index incrementally from the same scan that
    ///      collects geometry jobs (the old `build_pre_pass_fast` did two
    ///      full-file scans — one for entities, one for the index — which
    ///      doubled wall-clock).
    ///   2. As soon as `IFCPROJECT` has been seen, the unit scale and the
    ///      first ~50 geometry jobs have been collected, resolves
    ///      `unitScale` + `rtcOffset` and emits a `meta` callback so the
    ///      JS host can spin up geometry process workers.
    ///   3. Emits `jobs` callbacks every `chunk_size` jobs (or fewer if
    ///      the meta phase already buffered some).
    ///   4. Emits `complete` with the total job count at end of scan.
    ///
    /// On a 986 MB / 14 M-entity file this drops time-to-first-geometry
    /// from ~17 s (full pre-pass + worker spawn + first batch) to ~3 s
    /// (first 100 K bytes scanned + meta + first chunk).
    ///
    /// The callback receives a single `JsValue` argument shaped as one of:
    ///   `{ type: "meta", unitScale, rtcOffset: [x,y,z], needsShift, buildingRotation? }`
    ///   `{ type: "jobs", jobs: Uint32Array }`     // [id, start, end] triples
    ///   `{ type: "complete", totalJobs }`
    #[wasm_bindgen(js_name = buildPrePassStreaming)]
    pub fn build_pre_pass_streaming(
        &self,
        data: &[u8],
        on_event: &Function,
        chunk_size: u32,
    ) -> Result<JsValue, JsValue> {
        use super::styling::extract_building_rotation_from_site;
        use ifc_lite_core::{has_geometry_by_name, EntityDecoder, EntityScanner, IfcType};
        use ifc_lite_geometry::GeometryRouter;

        let chunk_size = chunk_size.max(1024) as usize;
        let content = decode_ifc_bytes(data);

        // Single-pass scan: gather (id, start, end, type) for everything,
        // tag geometry-bearing rows so we can emit jobs incrementally.
        // Entity index is built from the same pass — no second walk.
        let mut scanner = EntityScanner::new(content);
        let estimated = content.len() / 50;
        let mut entity_index: rustc_hash::FxHashMap<u32, (usize, usize)> =
            rustc_hash::FxHashMap::with_capacity_and_hasher(estimated, Default::default());

        let mut buffered_jobs: Vec<(u32, usize, usize, IfcType)> = Vec::with_capacity(chunk_size);
        let mut total_jobs: u32 = 0;
        let mut project_id: Option<u32> = None;
        let mut site_position: Option<(u32, usize, usize)> = None;
        let mut meta_emitted = false;

        // Style/void/material data collected during the scan — same shape as
        // `combined_pre_pass` collects for `buildPrePassOnce`. Emitted as a
        // `styles` event after the scan completes so workers can switch from
        // default colors to resolved colors mid-stream and the host can fire a
        // `colorUpdate` to retroactively fix already-emitted meshes.
        let mut geometry_styles: rustc_hash::FxHashMap<u32, [f32; 4]> =
            rustc_hash::FxHashMap::default();
        let mut void_index: rustc_hash::FxHashMap<u32, Vec<u32>> = rustc_hash::FxHashMap::default();
        let mut faceted_brep_ids: Vec<u32> = Vec::new();
        let mut orphan_styled_items: rustc_hash::FxHashMap<u32, [f32; 4]> =
            rustc_hash::FxHashMap::default();
        let mut material_def_reprs: rustc_hash::FxHashMap<u32, Vec<u32>> =
            rustc_hash::FxHashMap::default();
        let mut element_to_material: rustc_hash::FxHashMap<u32, u32> =
            rustc_hash::FxHashMap::default();
        // Hold a chunk buffer that we drain to JS — these are the last
        // `chunk_size` jobs awaiting flush. After `meta` the buffer is
        // drained as the first jobs event; subsequent flushes happen at
        // every `chunk_size` boundary.
        const RTC_SAMPLE_THRESHOLD: usize = 50;

        // Emit a chunk of jobs to JS as a Uint32Array of [id, start, end] triples.
        // Internal helper, returns total emitted so far.
        fn emit_jobs_chunk(
            on_event: &Function,
            jobs: &[(u32, usize, usize, IfcType)],
        ) -> Result<(), JsValue> {
            if jobs.is_empty() {
                return Ok(());
            }
            let arr = js_sys::Uint32Array::new_with_length((jobs.len() * 3) as u32);
            let mut idx = 0u32;
            for &(id, start, end, _) in jobs {
                arr.set_index(idx, id);
                arr.set_index(idx + 1, start as u32);
                arr.set_index(idx + 2, end as u32);
                idx += 3;
            }
            let event = js_sys::Object::new();
            super::set_js_prop(&event, "type", &"jobs".into());
            super::set_js_prop(&event, "jobs", &arr);
            on_event.call1(&JsValue::NULL, &event.into())?;
            Ok(())
        }

        // Spans of entities that need decoding for style collection — we
        // can't decode mid-scan because the decoder borrows `content` and
        // would need `entity_index` populated for any references it follows.
        // Stash the spans here and process them after the scan in one pass.
        let mut styled_item_spans: Vec<(u32, usize, usize)> = Vec::new();
        // IfcIndexedColourMap entries — the second IFC4 colouring mechanism
        // used by CATIA / 3DEXPERIENCE exports (#663). Resolved in the same
        // post-scan pass as IfcStyledItem.
        let mut indexed_colour_map_spans: Vec<(u32, usize, usize)> = Vec::new();
        let mut material_entity_spans: Vec<(u32, &'static str, usize, usize)> = Vec::new();
        let mut void_rel_spans: Vec<(u32, usize, usize)> = Vec::new();

        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            // Build entity index inline (same data we'd otherwise re-scan for).
            entity_index.insert(id, (start, end));

            match type_name {
                "IFCPROJECT" => {
                    if project_id.is_none() {
                        project_id = Some(id);
                    }
                }
                "IFCSITE" => {
                    if site_position.is_none() {
                        site_position = Some((id, start, end));
                    }
                    let ifc_type = IfcType::from_str(type_name);
                    buffered_jobs.push((id, start, end, ifc_type));
                    total_jobs += 1;
                }
                "IFCSTYLEDITEM" => {
                    styled_item_spans.push((id, start, end));
                }
                "IFCINDEXEDCOLOURMAP" => {
                    indexed_colour_map_spans.push((id, start, end));
                }
                "IFCMATERIALDEFINITIONREPRESENTATION" => {
                    material_entity_spans.push((id, "IFCMATERIALDEFINITIONREPRESENTATION", start, end));
                }
                "IFCRELASSOCIATESMATERIAL" => {
                    material_entity_spans.push((id, "IFCRELASSOCIATESMATERIAL", start, end));
                }
                "IFCRELVOIDSELEMENT" => {
                    void_rel_spans.push((id, start, end));
                }
                "IFCFACETEDBREP" => {
                    faceted_brep_ids.push(id);
                }
                _ => {
                    if has_geometry_by_name(type_name) {
                        let ifc_type = IfcType::from_str(type_name);
                        // We don't bucket by simple/complex here — the host
                        // distributes work across N geometry workers anyway,
                        // and the simple/complex split was a heuristic for
                        // RTC sampling that we now resolve once after
                        // RTC_SAMPLE_THRESHOLD jobs have been collected.
                        buffered_jobs.push((id, start, end, ifc_type));
                        total_jobs += 1;
                    }
                }
            }

            // Once we have project + enough sample jobs, resolve the meta
            // (unit scale + RTC offset + building rotation) and emit it
            // along with the buffered first chunk so workers can start.
            if !meta_emitted
                && project_id.is_some()
                && buffered_jobs.len() >= RTC_SAMPLE_THRESHOLD
            {
                // Build a decoder over the partial entity index. The unit
                // assignment + IFCSIUNIT entities live near the top of every
                // STEP file — with RTC_SAMPLE_THRESHOLD geometry jobs already
                // scanned we are well past them.
                let mut decoder = EntityDecoder::with_index(content, entity_index.clone());

                let unit_scale = ifc_lite_core::extract_length_unit_scale(
                    &mut decoder,
                    project_id.expect("project_id checked"),
                )
                .unwrap_or(1.0);

                let router = GeometryRouter::with_scale(unit_scale);
                let rtc_offset = router
                    .detect_rtc_offset_from_jobs(&buffered_jobs, &mut decoder)
                    .unwrap_or((0.0, 0.0, 0.0));
                let needs_shift = rtc_offset.0.abs() > 10000.0
                    || rtc_offset.1.abs() > 10000.0
                    || rtc_offset.2.abs() > 10000.0;

                let building_rotation = site_position
                    .and_then(|pos| extract_building_rotation_from_site(pos, &mut decoder));

                // Emit meta event.
                let meta = js_sys::Object::new();
                super::set_js_prop(&meta, "type", &"meta".into());
                super::set_js_prop(&meta, "unitScale", &unit_scale.into());
                let rtc_arr = js_sys::Float64Array::new_with_length(3);
                rtc_arr.set_index(0, rtc_offset.0);
                rtc_arr.set_index(1, rtc_offset.1);
                rtc_arr.set_index(2, rtc_offset.2);
                super::set_js_prop(&meta, "rtcOffset", &rtc_arr);
                super::set_js_prop(&meta, "needsShift", &needs_shift.into());
                match building_rotation {
                    Some(rot) => super::set_js_prop(&meta, "buildingRotation", &rot.into()),
                    None => super::set_js_prop(&meta, "buildingRotation", &JsValue::NULL),
                };
                on_event.call1(&JsValue::NULL, &meta.into())?;

                // Drain the buffered jobs as the first jobs event so workers
                // start immediately on whatever we already collected.
                emit_jobs_chunk(on_event, &buffered_jobs)?;
                buffered_jobs.clear();
                meta_emitted = true;
                continue;
            }

            // Steady state: flush every chunk_size jobs.
            if meta_emitted && buffered_jobs.len() >= chunk_size {
                emit_jobs_chunk(on_event, &buffered_jobs)?;
                buffered_jobs.clear();
            }
        }

        // Tail: if we never hit the meta threshold (very small file with
        // <50 geometry jobs), emit meta now with whatever data we have so
        // workers can still process the trailing buffer.
        if !meta_emitted {
            // Build a decoder lazily for unit/RTC/site lookups. With a
            // sub-50-job file the scan is essentially instant anyway, so
            // buying a second pass here is irrelevant.
            let mut decoder = EntityDecoder::with_index(content, entity_index.clone());
            let unit_scale = project_id
                .and_then(|pid| ifc_lite_core::extract_length_unit_scale(&mut decoder, pid).ok())
                .unwrap_or(1.0);
            let router = GeometryRouter::with_scale(unit_scale);
            let rtc_offset = router
                .detect_rtc_offset_from_jobs(&buffered_jobs, &mut decoder)
                .unwrap_or((0.0, 0.0, 0.0));
            let needs_shift = rtc_offset.0.abs() > 10000.0
                || rtc_offset.1.abs() > 10000.0
                || rtc_offset.2.abs() > 10000.0;
            let building_rotation = site_position
                .and_then(|pos| extract_building_rotation_from_site(pos, &mut decoder));

            let meta = js_sys::Object::new();
            super::set_js_prop(&meta, "type", &"meta".into());
            super::set_js_prop(&meta, "unitScale", &unit_scale.into());
            let rtc_arr = js_sys::Float64Array::new_with_length(3);
            rtc_arr.set_index(0, rtc_offset.0);
            rtc_arr.set_index(1, rtc_offset.1);
            rtc_arr.set_index(2, rtc_offset.2);
            super::set_js_prop(&meta, "rtcOffset", &rtc_arr);
            super::set_js_prop(&meta, "needsShift", &needs_shift.into());
            match building_rotation {
                Some(rot) => super::set_js_prop(&meta, "buildingRotation", &rot.into()),
                None => super::set_js_prop(&meta, "buildingRotation", &JsValue::NULL),
            };
            on_event.call1(&JsValue::NULL, &meta.into())?;
        }

        // Final tail chunk.
        emit_jobs_chunk(on_event, &buffered_jobs)?;
        buffered_jobs.clear();

        // Cache the entity index for processGeometryBatch reuse — same
        // contract as buildPrePassFast / buildPrePassOnce. Wrapped in Arc
        // so process workers reuse the same index by reference instead of
        // cloning the 14 M-entry HashMap on every batch call.
        let entity_index_arc = std::sync::Arc::new(entity_index);
        // Mutex held only briefly to install the Arc.
        {
            let mut slot = self
                .cached_entity_index
                .lock()
                .expect("ifc-lite cached_entity_index Mutex poisoned");
            *slot = Some(entity_index_arc.clone());
        }
        // Hold a second clone for the post-scan entity-index export below;
        // `with_arc_index` consumes the Arc so we'd lose the reference
        // after the decoder is created.
        let index_for_export = entity_index_arc.clone();

        // ── Style + void resolution (post-scan) ──
        // The streaming scan stashed entity spans for IfcStyledItem,
        // material entities, and void rels. Now that the entity index is
        // complete we decode them in one pass — the same logic
        // `combined_pre_pass` runs inline, but split into a post-phase so
        // we don't block streaming jobs on style decoding.
        //
        // We deliberately SKIP `MaterialLayerIndex::from_content` and
        // `propagate_voids_to_parts` here — both do their own full file
        // scans and would add ~7 s to the streaming pre-pass for visual
        // refinements (multilayer wall cuts, layered material rendering).
        // Primary surface colors come through correctly without them, and
        // the missing detail can be added later without changing the
        // protocol shape.
        let mut decoder = EntityDecoder::with_arc_index(content, entity_index_arc);

        for &(id, start, end) in &styled_item_spans {
            if let Ok(styled_item) = decoder.decode_at_with_id(id, start, end) {
                if let Some(geometry_id) = styled_item.get_ref(0) {
                    if !geometry_styles.contains_key(&geometry_id) {
                        if let Some(styles_attr) = styled_item.get(1) {
                            if let Some(color) =
                                super::styling::extract_color_from_styles(styles_attr, &mut decoder)
                            {
                                geometry_styles.insert(geometry_id, color);
                            }
                        }
                    }
                } else {
                    // Orphan IfcStyledItem (null Item) — material-based color.
                    if let Some(styles_attr) = styled_item.get(1) {
                        if let Some(color) =
                            super::styling::extract_color_from_styles(styles_attr, &mut decoder)
                        {
                            orphan_styled_items.insert(id, color);
                        }
                    }
                }
            }
        }

        // Resolve IfcIndexedColourMap entries — IFC4's per-tessellated-face-set
        // colouring mechanism used by CATIA / 3DEXPERIENCE exports (#663).
        // IfcStyledItem entries above win when both target the same geometry,
        // so `entry().or_insert` preserves the authored-intent path.
        for &(id, start, end) in &indexed_colour_map_spans {
            if let Some((geometry_id, color)) =
                super::styling::extract_color_from_indexed_colour_map_span(id, start, end, &mut decoder)
            {
                geometry_styles.entry(geometry_id).or_insert(color);
            }
        }

        for &(id, type_name, start, end) in &material_entity_spans {
            super::styling::collect_material_entity(
                id,
                type_name,
                start,
                end,
                &mut decoder,
                &mut orphan_styled_items,
                &mut material_def_reprs,
                &mut element_to_material,
            );
        }

        for &(id, start, end) in &void_rel_spans {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let (Some(host_id), Some(opening_id)) =
                    (entity.get_ref(4), entity.get_ref(5))
                {
                    void_index.entry(host_id).or_default().push(opening_id);
                }
            }
        }

        // Resolve material chains → element colors.
        let material_styles = super::styling::build_material_style_index(
            &material_def_reprs,
            &orphan_styled_items,
            &mut decoder,
        );
        let element_material_styles = super::styling::build_element_material_styles(
            &element_to_material,
            &material_styles,
            &mut decoder,
        );
        // Flat material_id → color, merge into geometry_styles for layered
        // resolution per `combined_pre_pass`.
        for (&mat_id, &color) in
            super::styling::flatten_material_color_index(&material_styles).iter()
        {
            geometry_styles.entry(mat_id).or_insert(color);
        }
        // For elements that have a single resolved material color, register
        // it so processGeometryBatch's per-type fallback picks it up.
        for (&element_id, colors) in &element_material_styles {
            if let Some(&color) = colors.first() {
                geometry_styles.entry(element_id).or_insert(color);
            }
        }

        // Serialise styles + voids + faceted_brep_ids and post a `styles`
        // event before `complete` so the host can dispatch them to all
        // process workers and emit a colorUpdate for already-rendered meshes.
        let styles_len = geometry_styles.len();
        let style_ids = js_sys::Uint32Array::new_with_length(styles_len as u32);
        let style_colors = js_sys::Uint8Array::new_with_length((styles_len * 4) as u32);
        let mut si = 0u32;
        for (&id, &color) in &geometry_styles {
            style_ids.set_index(si, id);
            let ci = si * 4;
            style_colors.set_index(ci, (color[0] * 255.0).clamp(0.0, 255.0) as u8);
            style_colors.set_index(ci + 1, (color[1] * 255.0).clamp(0.0, 255.0) as u8);
            style_colors.set_index(ci + 2, (color[2] * 255.0).clamp(0.0, 255.0) as u8);
            style_colors.set_index(ci + 3, (color[3] * 255.0).clamp(0.0, 255.0) as u8);
            si += 1;
        }

        // void_index → flat (keys, counts, values) arrays in the same shape
        // processGeometryBatch already accepts.
        let mut void_keys_vec: Vec<u32> = Vec::with_capacity(void_index.len());
        let mut void_counts_vec: Vec<u32> = Vec::with_capacity(void_index.len());
        let mut void_values_vec: Vec<u32> = Vec::new();
        for (&host_id, openings) in &void_index {
            void_keys_vec.push(host_id);
            void_counts_vec.push(openings.len() as u32);
            void_values_vec.extend(openings.iter().copied());
        }
        let void_keys = js_sys::Uint32Array::new_with_length(void_keys_vec.len() as u32);
        for (i, &k) in void_keys_vec.iter().enumerate() {
            void_keys.set_index(i as u32, k);
        }
        let void_counts = js_sys::Uint32Array::new_with_length(void_counts_vec.len() as u32);
        for (i, &c) in void_counts_vec.iter().enumerate() {
            void_counts.set_index(i as u32, c);
        }
        let void_values = js_sys::Uint32Array::new_with_length(void_values_vec.len() as u32);
        for (i, &v) in void_values_vec.iter().enumerate() {
            void_values.set_index(i as u32, v);
        }
        let faceted_brep_arr = js_sys::Uint32Array::new_with_length(faceted_brep_ids.len() as u32);
        for (i, &id) in faceted_brep_ids.iter().enumerate() {
            faceted_brep_arr.set_index(i as u32, id);
        }

        let styles_event = js_sys::Object::new();
        super::set_js_prop(&styles_event, "type", &"styles".into());
        super::set_js_prop(&styles_event, "styleIds", &style_ids);
        super::set_js_prop(&styles_event, "styleColors", &style_colors);
        super::set_js_prop(&styles_event, "voidKeys", &void_keys);
        super::set_js_prop(&styles_event, "voidCounts", &void_counts);
        super::set_js_prop(&styles_event, "voidValues", &void_values);
        super::set_js_prop(&styles_event, "facetedBrepIds", &faceted_brep_arr);
        on_event.call1(&JsValue::NULL, &styles_event.into())?;

        // Export the entity_index as 3 column arrays so process workers
        // can install it via `setEntityIndex` (skipping the ~5 s file
        // re-scan they'd otherwise pay on the first processGeometryBatch
        // call). The arrays are filled directly from the Arc'd HashMap;
        // the Arc shares with `cached_entity_index` so we don't clone the
        // map data — only walk it once to fill the output arrays.
        //
        // Output shape mirrors `setEntityIndex`'s input contract:
        //   ids[i]     → entity ID (u32)
        //   starts[i]  → byte offset of entity start
        //   lengths[i] → byte length of entity (NOT end offset)
        let n = index_for_export.len();
        let ids_arr = js_sys::Uint32Array::new_with_length(n as u32);
        let starts_arr = js_sys::Uint32Array::new_with_length(n as u32);
        let lengths_arr = js_sys::Uint32Array::new_with_length(n as u32);
        let mut i = 0u32;
        for (&id, &(start, end)) in index_for_export.iter() {
            ids_arr.set_index(i, id);
            starts_arr.set_index(i, start as u32);
            lengths_arr.set_index(i, (end - start) as u32);
            i += 1;
        }
        let index_event = js_sys::Object::new();
        super::set_js_prop(&index_event, "type", &"entity-index".into());
        super::set_js_prop(&index_event, "ids", &ids_arr);
        super::set_js_prop(&index_event, "starts", &starts_arr);
        super::set_js_prop(&index_event, "lengths", &lengths_arr);
        on_event.call1(&JsValue::NULL, &index_event.into())?;

        // Complete event.
        let done = js_sys::Object::new();
        super::set_js_prop(&done, "type", &"complete".into());
        super::set_js_prop(&done, "totalJobs", &(total_jobs as f64).into());
        on_event.call1(&JsValue::NULL, &done.into())?;

        Ok(JsValue::UNDEFINED)
    }

    /// Phase 1 of Path C — sharded entity-index scan.
    ///
    /// Walks the bytes in `[range_start, range_end)` once and emits
    /// `(express_id, byte_offset, byte_length)` triples for every entity
    /// whose `#N=` opener falls in that range. Byte offsets are GLOBAL
    /// (relative to file start), so multiple shards' outputs concatenate
    /// without rewriting.
    ///
    /// Cross-boundary handling: the scanner rewinds `range_start` to the
    /// byte after the previous `\n` so we don't mis-parse a half entity.
    /// The previous shard owns any entity whose opener is BEFORE its own
    /// range_end (its terminator may extend past it; that's fine — the
    /// scanner walks STEP entities to their terminating `;`, even if that
    /// terminator is past the shard's nominal range_end).
    ///
    /// Returns nothing through the JS callback for performance signals;
    /// emits exactly one `index-shard` event with three Uint32Arrays:
    ///   `{ type: "index-shard", ids: Uint32Array, starts: Uint32Array,
    ///      lengths: Uint32Array, shardStart: u32, shardEnd: u32 }`
    ///
    /// Used by the JS-side shard coordinator to merge N shards' indices
    /// into a single entity-index without paying the 3 s single-threaded
    /// scan cost. Style and job emission are NOT done here — they remain
    /// the job of the existing `build_pre_pass_streaming` (which can be
    /// called on shard 0 in parallel with the other shards' index-only
    /// scans).
    #[wasm_bindgen(js_name = scanEntityIndexShard)]
    pub fn scan_entity_index_shard(
        &self,
        data: &[u8],
        on_event: &Function,
        range_start: u32,
        range_end: u32,
    ) -> Result<JsValue, JsValue> {
        use ifc_lite_core::EntityScanner;

        let content = decode_ifc_bytes(data);
        let bytes = content.as_bytes();
        let total_len = bytes.len();

        let nominal_start = (range_start as usize).min(total_len);
        let nominal_end = (range_end as usize).min(total_len);

        // Rewind to the byte after the previous `\n`. Entities can span
        // multiple lines but every entity is preceded by some line break
        // in valid STEP files, so the byte right after a `\n` is always
        // a safe scanner restart point. If the rewind hits position 0
        // we just start from there.
        let mut actual_start = nominal_start;
        while actual_start > 0 && bytes[actual_start - 1] != b'\n' {
            actual_start -= 1;
        }

        // Estimate capacity from byte range / 70 (avg entity size).
        let estimated = (nominal_end.saturating_sub(actual_start)) / 70;
        let mut ids: Vec<u32> = Vec::with_capacity(estimated);
        let mut starts: Vec<u32> = Vec::with_capacity(estimated);
        let mut lengths: Vec<u32> = Vec::with_capacity(estimated);

        let mut scanner = EntityScanner::new_at(content, actual_start);
        while let Some((id, _type_name, byte_start, byte_end)) = scanner.next_entity() {
            // Skip entities whose opener is BEFORE our range — they belong
            // to the previous shard, which rewound past the boundary too.
            // (Only happens at non-zero range starts.)
            if byte_start < nominal_start {
                continue;
            }
            // Stop once an entity's opener is past our range_end. The
            // entity itself might extend past range_end (its terminator
            // could be in the next shard's range), but we still own it
            // here because its OPENER is in our range. Correction: we
            // own only entities whose opener is in [nominal_start,
            // nominal_end). The next shard's scanner will skip this same
            // entity because its opener is before that shard's start.
            if byte_start >= nominal_end {
                break;
            }
            ids.push(id);
            starts.push(byte_start as u32);
            lengths.push((byte_end - byte_start) as u32);
        }

        // Emit one event with the columns. Receiver allocates SAB-backed
        // typed arrays from these on the JS side and merges with peers.
        let n = ids.len() as u32;
        let ids_arr = js_sys::Uint32Array::new_with_length(n);
        let starts_arr = js_sys::Uint32Array::new_with_length(n);
        let lengths_arr = js_sys::Uint32Array::new_with_length(n);
        for (i, ((&id, &start), &length)) in ids.iter().zip(starts.iter()).zip(lengths.iter()).enumerate() {
            let i = i as u32;
            ids_arr.set_index(i, id);
            starts_arr.set_index(i, start);
            lengths_arr.set_index(i, length);
        }

        let event = js_sys::Object::new();
        super::set_js_prop(&event, "type", &"index-shard".into());
        super::set_js_prop(&event, "ids", &ids_arr);
        super::set_js_prop(&event, "starts", &starts_arr);
        super::set_js_prop(&event, "lengths", &lengths_arr);
        super::set_js_prop(&event, "shardStart", &(nominal_start as f64).into());
        super::set_js_prop(&event, "shardEnd", &(nominal_end as f64).into());
        on_event.call1(&JsValue::NULL, &event.into())?;

        Ok(JsValue::UNDEFINED)
    }

    /// Process geometry for a subset of pre-scanned entities.
    /// Takes raw bytes and pre-pass data from buildPrePassOnce.
    #[wasm_bindgen(js_name = processGeometryBatch)]
    pub fn process_geometry_batch(
        &self,
        data: &[u8],
        jobs_flat: &[u32],
        unit_scale: f64,
        rtc_x: f64,
        rtc_y: f64,
        rtc_z: f64,
        needs_shift: bool,
        void_keys: &[u32],
        void_counts: &[u32],
        void_values: &[u32],
        style_ids: &[u32],   // geometry style entity IDs
        style_colors: &[u8], // [r, g, b, a, r, g, b, a, ...] (0-255)
    ) -> MeshCollection {
        use super::styling::{
            get_default_color_for_type, resolve_element_color, resolve_submesh_color,
        };
        use ifc_lite_core::EntityDecoder;
        use ifc_lite_geometry::{calculate_normals, GeometryRouter};

        let content = decode_ifc_bytes(data);

        // Reuse the cached Arc<EntityIndex> across calls so we don't
        // re-clone the 14 M-entry HashMap on every batch. On streaming
        // paths this turns ~36 calls/worker into 1 build + 35 Arc::clone()
        // (a single refcount bump) instead of 36 full HashMap clones.
        //
        // If the cache is empty (which happens on every process worker
        // because they're separate WASM realms from the pre-pass worker),
        // build once here and store under Arc so subsequent calls hit
        // the fast path.
        let entity_index_arc: std::sync::Arc<ifc_lite_core::EntityIndex> = {
            // Mutex briefly held: peek at cache, build-if-empty, clone Arc.
            // The clone is what gets handed to rayon — no lock contention
            // on the per-job hot path that follows. Poison panics here
            // (an earlier panic-with-lock-held has corrupted the cache).
            let mut slot = self
                .cached_entity_index
                .lock()
                .expect("ifc-lite cached_entity_index Mutex poisoned");
            if let Some(existing) = slot.as_ref() {
                std::sync::Arc::clone(existing)
            } else {
                let built = std::sync::Arc::new(ifc_lite_core::build_entity_index(content));
                *slot = Some(std::sync::Arc::clone(&built));
                built
            }
        };
        let mut decoder = EntityDecoder::with_arc_index(content, entity_index_arc);

        // Create geometry router with unit scale
        let mut router = GeometryRouter::with_scale(unit_scale);

        // Set RTC offset if needed
        if needs_shift {
            router.set_rtc_offset((rtc_x, rtc_y, rtc_z));
        }

        // Reconstruct void_index from flat arrays
        let mut void_index: rustc_hash::FxHashMap<u32, Vec<u32>> = rustc_hash::FxHashMap::default();
        let mut value_offset = 0usize;
        for i in 0..void_keys.len() {
            let host_id = void_keys[i];
            let count = void_counts[i] as usize;
            let openings = void_values[value_offset..value_offset + count].to_vec();
            void_index.insert(host_id, openings);
            value_offset += count;
        }

        // Reconstruct geometry_styles from flat arrays
        let mut geometry_styles: rustc_hash::FxHashMap<u32, [f32; 4]> =
            rustc_hash::FxHashMap::default();
        for i in 0..style_ids.len() {
            let base = i * 4;
            if base + 3 < style_colors.len() {
                geometry_styles.insert(
                    style_ids[i],
                    [
                        style_colors[base] as f32 / 255.0,
                        style_colors[base + 1] as f32 / 255.0,
                        style_colors[base + 2] as f32 / 255.0,
                        style_colors[base + 3] as f32 / 255.0,
                    ],
                );
            }
        }

        // Build element_styles by resolving colors for each entity in this batch
        let mut element_styles: rustc_hash::FxHashMap<u32, [f32; 4]> =
            rustc_hash::FxHashMap::default();
        if !geometry_styles.is_empty() {
            for chunk in jobs_flat.chunks(3) {
                if chunk.len() < 3 {
                    break;
                }
                let id = chunk[0];
                let start = chunk[1] as usize;
                let end = chunk[2] as usize;
                if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                    if entity.get(6).map(|a| !a.is_null()).unwrap_or(false) {
                        if let Some(color) =
                            resolve_element_color(&entity, &geometry_styles, &mut decoder)
                        {
                            element_styles.insert(id, color);
                        }
                    }
                }
            }
        }

        // Pre-allocate
        let num_jobs = jobs_flat.len() / 3;
        decoder.reserve_cache(num_jobs * 2);
        let mut mesh_collection = MeshCollection::with_capacity(num_jobs);

        if needs_shift {
            mesh_collection.set_rtc_offset(rtc_x, rtc_y, rtc_z);
        }

        // Cache IFC type name strings
        let mut type_name_cache: rustc_hash::FxHashMap<ifc_lite_core::IfcType, String> =
            rustc_hash::FxHashMap::default();

        // When merge-layers is on, fetch (or lazily build) the set of
        // IfcBuildingElementPart express IDs to skip. Built once per worker
        // and reused across every subsequent batch on the same content via
        // the cached_parts_to_skip slot on IfcAPI.
        let parts_to_skip: std::sync::Arc<rustc_hash::FxHashSet<u32>> = if self.merge_layers() {
            self.get_or_build_parts_to_skip(content, &mut decoder)
        } else {
            std::sync::Arc::new(rustc_hash::FxHashSet::default())
        };

        // Process only the entities specified in jobs_flat
        for chunk in jobs_flat.chunks(3) {
            if chunk.len() < 3 {
                break;
            }
            let id = chunk[0];
            let start = chunk[1] as usize;
            let end = chunk[2] as usize;

            if parts_to_skip.contains(&id) {
                continue;
            }

            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                // IfcAlignment exception — see `parse_meshes`.
                let has_representation = entity.get(6).map(|a| !a.is_null()).unwrap_or(false);
                let is_alignment = entity.ifc_type == ifc_lite_core::IfcType::IfcAlignment;
                if !has_representation && !is_alignment {
                    continue;
                }

                let ifc_type = entity.ifc_type;
                let has_openings = void_index.contains_key(&id);

                if has_openings {
                    if let Ok(mut mesh) =
                        router.process_element_with_voids(&entity, &mut decoder, &void_index)
                    {
                        if !mesh.is_empty() {
                            if mesh.normals.len() != mesh.positions.len() {
                                calculate_normals(&mut mesh);
                            }
                            let color = element_styles
                                .get(&id)
                                .copied()
                                .unwrap_or_else(|| get_default_color_for_type(&ifc_type));
                            let ifc_type_name = type_name_cache
                                .entry(ifc_type)
                                .or_insert_with(|| ifc_type.name().to_string())
                                .clone();
                            mesh_collection.add(MeshDataJs::new(id, ifc_type_name, mesh, color));
                        }
                    }
                } else {
                    // Only use expensive sub-mesh processing for types that need
                    // per-item colors (windows with glass transparency, doors, etc).
                    // Skip for ~90% of entities (beams, columns, slabs, walls).
                    let needs_submesh = matches!(
                        ifc_type,
                        ifc_lite_core::IfcType::IfcWindow
                            | ifc_lite_core::IfcType::IfcDoor
                            | ifc_lite_core::IfcType::IfcCurtainWall
                            | ifc_lite_core::IfcType::IfcPlate
                            | ifc_lite_core::IfcType::IfcMember
                    );

                    let mut used_submesh = false;
                    if needs_submesh {
                        if let Ok(sub_meshes) =
                            router.process_element_with_submeshes(&entity, &mut decoder)
                        {
                            if !sub_meshes.is_empty() {
                                let default_color = get_default_color_for_type(&ifc_type);
                                let element_color = element_styles.get(&id).copied();
                                let mut mat_color_idx = 0usize;
                                for sub in sub_meshes.sub_meshes {
                                    let mut mesh = sub.mesh;
                                    if mesh.is_empty() {
                                        continue;
                                    }
                                    if mesh.normals.len() != mesh.positions.len() {
                                        calculate_normals(&mut mesh);
                                    }
                                    let color = resolve_submesh_color(
                                        sub.geometry_id,
                                        &geometry_styles,
                                        &mut decoder,
                                        None,
                                        &mut mat_color_idx,
                                        element_color,
                                        default_color,
                                    );
                                    let ifc_type_name = type_name_cache
                                        .entry(ifc_type)
                                        .or_insert_with(|| ifc_type.name().to_string())
                                        .clone();
                                    mesh_collection.add(MeshDataJs::new(
                                        id,
                                        ifc_type_name,
                                        mesh,
                                        color,
                                    ));
                                    used_submesh = true;
                                }
                            }
                        }
                    }

                    if !used_submesh {
                        // Use submesh path even for non-whitelisted types so that
                        // unsupported representation items are skipped instead of
                        // aborting the entire element (process_element uses `?`).
                        if let Ok(sub_meshes) =
                            router.process_element_with_submeshes(&entity, &mut decoder)
                        {
                            if !sub_meshes.is_empty() {
                                let default_color = get_default_color_for_type(&ifc_type);
                                let element_color = element_styles.get(&id).copied();
                                let mut mat_color_idx = 0usize;
                                for sub in sub_meshes.sub_meshes {
                                    let mut mesh = sub.mesh;
                                    if mesh.is_empty() {
                                        continue;
                                    }
                                    if mesh.normals.len() != mesh.positions.len() {
                                        calculate_normals(&mut mesh);
                                    }
                                    let color = resolve_submesh_color(
                                        sub.geometry_id,
                                        &geometry_styles,
                                        &mut decoder,
                                        None,
                                        &mut mat_color_idx,
                                        element_color,
                                        default_color,
                                    );
                                    let ifc_type_name = type_name_cache
                                        .entry(ifc_type)
                                        .or_insert_with(|| ifc_type.name().to_string())
                                        .clone();
                                    mesh_collection.add(MeshDataJs::new(
                                        id,
                                        ifc_type_name,
                                        mesh,
                                        color,
                                    ));
                                }
                            }
                        }
                    }
                }
            }
        }

        // Drain & surface the opening / CSG diagnostics. The viewer's
        // large-file path goes processAdaptive -> processParallel -> Web
        // Workers -> `processGeometryBatch`, so the drain has to run here
        // or the diagnostic helper never fires for real-world files.
        let _ = super::drain_and_log_csg_diagnostics(&router);

        mesh_collection
    }
}
