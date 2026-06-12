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

/// Emit a sub-mesh, splitting it into one mesh per `IfcIndexedColourMap` palette
/// group when the face set carries a per-triangle colour map whose triangle
/// count still matches the produced mesh (issue #858). This restores the split
/// the live viewer lost when the geometry pipeline was unified onto
/// `processGeometryBatch` (#874) — the prepass only carries one dominant colour
/// per geometry, so without this the green/yellow triangles collapse into red.
///
/// Falls back to a single `color` mesh when there is no map, when the map no
/// longer applies (CSG/void retopology changed the triangle count), or when
/// fewer than two distinct palette colours are used — the same guards the native
/// processor relies on (see `split_mesh_by_indexed_colour`).
fn emit_submesh_with_palette_split(
    mesh_collection: &mut MeshCollection,
    express_id: u32,
    ifc_type_name: &str,
    geometry_id: u32,
    mesh: ifc_lite_geometry::Mesh,
    color: [f32; 4],
    indexed_colour_full: &rustc_hash::FxHashMap<
        u32,
        ifc_lite_processing::style::FullIndexedColourMap,
    >,
) {
    if let Some(full) = indexed_colour_full.get(&geometry_id) {
        if let Some(groups) = ifc_lite_processing::style::split_mesh_by_indexed_colour(&mesh, full)
        {
            for (rgba, mut part) in groups {
                if part.normals.len() != part.positions.len() {
                    ifc_lite_geometry::calculate_normals(&mut part);
                }
                mesh_collection.add(MeshDataJs::new(
                    express_id,
                    ifc_type_name.to_string(),
                    part,
                    rgba.to_array(),
                ));
            }
            return;
        }
    }
    mesh_collection.add(MeshDataJs::new(
        express_id,
        ifc_type_name.to_string(),
        mesh,
        color,
    ));
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

        let content = data;

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
        let rtc_offset = router.detect_rtc_offset_with_fallback(&rtc_jobs, &mut decoder, content);
        let needs_shift = rtc_offset.0.abs() > 10000.0
            || rtc_offset.1.abs() > 10000.0
            || rtc_offset.2.abs() > 10000.0;

        // Extract building rotation
        let building_rotation = pre_pass
            .site_position
            .and_then(|pos| extract_building_rotation_from_site(pos, &router, &mut decoder));

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

        result.into()
    }

    /// Streaming pre-pass: emits geometry jobs in chunks via a JS callback
    /// instead of waiting for the full file scan to complete.
    ///
    /// Single linear walk over the file:
    ///   1. Builds the entity index incrementally from the same scan that
    ///      collects geometry jobs (a separate index scan would double
    ///      wall-clock).
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
        let content = data;

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
        // IfcRelAggregates spans — decoded post-scan into the parent→children
        // map that drives aggregate void propagation (no extra file scan).
        let mut aggregate_rel_spans: Vec<(u32, usize, usize)> = Vec::new();

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
                    material_entity_spans.push((
                        id,
                        "IFCMATERIALDEFINITIONREPRESENTATION",
                        start,
                        end,
                    ));
                }
                "IFCRELASSOCIATESMATERIAL" => {
                    material_entity_spans.push((id, "IFCRELASSOCIATESMATERIAL", start, end));
                }
                "IFCRELVOIDSELEMENT" => {
                    void_rel_spans.push((id, start, end));
                }
                "IFCRELAGGREGATES" => {
                    aggregate_rel_spans.push((id, start, end));
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
            if !meta_emitted && project_id.is_some() && buffered_jobs.len() >= RTC_SAMPLE_THRESHOLD
            {
                // Build a decoder over the partial entity index built so far.
                let mut decoder = EntityDecoder::with_index(content, entity_index.clone());
                let pid = project_id.expect("project_id checked");

                // Resolve the length-unit scale. The assignment + IFCSIUNIT
                // usually sit near the top of a STEP file, so the partial
                // index resolves them directly (fast path). But many real
                // exports (Revit) place the IFCPROJECT / IFCUNITASSIGNMENT
                // AFTER the bulk of geometry — there the partial index does
                // not yet contain the assigned IFCSIUNIT, and silently
                // defaulting to metres renders a millimetre model 1000×
                // oversized (and dwarfs any correctly-scaled federated peer).
                // When the chain isn't fully decodable here, resolve against a
                // complete index instead of trusting the metres default.
                let unit_scale =
                    match ifc_lite_core::try_extract_length_unit_scale(&mut decoder, pid) {
                        Some(scale) => scale,
                        None => {
                            let full_index = ifc_lite_core::build_entity_index(content);
                            let mut full_decoder = EntityDecoder::with_index(content, full_index);
                            ifc_lite_core::extract_length_unit_scale(&mut full_decoder, pid)
                                .unwrap_or(1.0)
                        }
                    };

                let router = GeometryRouter::with_scale(unit_scale);
                let is_large = |t: (f64, f64, f64)| {
                    t.0.abs() > 10000.0 || t.1.abs() > 10000.0 || t.2.abs() > 10000.0
                };
                let detected_rtc = router.detect_rtc_offset_from_jobs(&buffered_jobs, &mut decoder);
                let mut rtc_offset = detected_rtc.unwrap_or((0.0, 0.0, 0.0));

                // Streaming emits this meta as soon as RTC_SAMPLE_THRESHOLD geometry
                // jobs are buffered (~the 50th element, near the top of the file), so
                // the partial index here only covers the file head. When a model's
                // world offset lives in spatial-structure placements emitted LATE
                // (a Revit/French export with IfcSite + its placement chain at the
                // END of the file — observed at line 202 339 of a 202 691 line
                // model), the element -> storey -> building -> site chain can't
                // resolve from the partial index, detection returns (0,0,0), and the
                // huge ~8e6 m world coordinates get cast to f32 downstream → ~0.5 m
                // of vertex jitter. If no offset was found AND we haven't even
                // scanned the IfcSite yet, re-detect against a FULL index so the
                // complete chain resolves. Gated on both so the common early-site /
                // origin-local model never pays for a second index build.
                // (`buildPrePassOnce` and the small-file tail already use a full
                // index, so only this early-meta path needs the fallback.)
                if !is_large(rtc_offset) && site_position.is_none() {
                    let full_index = ifc_lite_core::build_entity_index(content);
                    let mut full_decoder = EntityDecoder::with_index(content, full_index);
                    if let Some(full_rtc) =
                        router.detect_rtc_offset_from_jobs(&buffered_jobs, &mut full_decoder)
                    {
                        if is_large(full_rtc) {
                            rtc_offset = full_rtc;
                        }
                    }
                }
                // Server parity: when sampling produced no usable translations
                // at all, fall back to the full placement-bounds scan exactly
                // like `process_geometry` does — otherwise a model whose
                // sampled placements fail to decode renders re-based on the
                // server but jittery (raw >10 km f32 coords) in the browser.
                if detected_rtc.is_none() && !is_large(rtc_offset) {
                    rtc_offset = ifc_lite_core::scan_placement_bounds(content).rtc_offset();
                }
                let needs_shift = is_large(rtc_offset);

                let building_rotation = site_position.and_then(|pos| {
                    extract_building_rotation_from_site(pos, &router, &mut decoder)
                });

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
            let rtc_offset =
                router.detect_rtc_offset_with_fallback(&buffered_jobs, &mut decoder, content);
            let needs_shift = rtc_offset.0.abs() > 10000.0
                || rtc_offset.1.abs() > 10000.0
                || rtc_offset.2.abs() > 10000.0;
            let building_rotation = site_position
                .and_then(|pos| extract_building_rotation_from_site(pos, &router, &mut decoder));

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
        // contract as buildPrePassOnce. Wrapped in Arc
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
        // We deliberately SKIP `MaterialLayerIndex::from_content` here — it
        // does its own full file scan and would add seconds to the streaming
        // pre-pass for a visual refinement (layered material rendering).
        // Aggregate void propagation, by contrast, IS included below: the
        // scan already stashed the IfcRelAggregates spans, so the shared
        // BFS kernel runs without any extra file pass — keeping streaming
        // loads void-parity with `buildPrePassOnce` and the server.
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
                super::styling::extract_color_from_indexed_colour_map_span(
                    id,
                    start,
                    end,
                    &mut decoder,
                )
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
                if let (Some(host_id), Some(opening_id)) = (entity.get_ref(4), entity.get_ref(5)) {
                    void_index.entry(host_id).or_default().push(opening_id);
                }
            }
        }

        // Aggregate void propagation (shared kernel, parity with the once
        // path and the server): openings authored on an aggregating host
        // (IfcWallElementedCase panels, IfcRoof→IfcSlab skylights) must cut
        // every descendant part. Decode the stashed IfcRelAggregates spans
        // into the parent→children map — no extra file scan.
        if !void_index.is_empty() && !aggregate_rel_spans.is_empty() {
            let mut aggregate_children: rustc_hash::FxHashMap<u32, Vec<u32>> =
                rustc_hash::FxHashMap::default();
            for &(id, start, end) in &aggregate_rel_spans {
                if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                    let Some(parent_id) = entity.get_ref(4) else {
                        continue;
                    };
                    if let Some(list) = entity.get(5).and_then(|a| a.as_list()) {
                        let children: Vec<u32> =
                            list.iter().filter_map(|i| i.as_entity_ref()).collect();
                        if !children.is_empty() {
                            aggregate_children.entry(parent_id).or_default().extend(children);
                        }
                    }
                }
            }
            ifc_lite_geometry::propagate_voids_via_aggregates(&mut void_index, &aggregate_children);
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

        // Serialise styles + voids and post a `styles`
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
        let styles_event = js_sys::Object::new();
        super::set_js_prop(&styles_event, "type", &"styles".into());
        super::set_js_prop(&styles_event, "styleIds", &style_ids);
        super::set_js_prop(&styles_event, "styleColors", &style_colors);
        super::set_js_prop(&styles_event, "voidKeys", &void_keys);
        super::set_js_prop(&styles_event, "voidCounts", &void_counts);
        super::set_js_prop(&styles_event, "voidValues", &void_values);
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

        // #957: emit orphan IfcTypeProduct geometry as a final jobs chunk so the
        // browser renders annex-E type-only "tessellated shape with style" files
        // (geometry on the type via RepresentationMaps, no occurrence). The
        // entity index is complete here, so this resolves cleanly.
        //
        // PERF (flagged, #962 review): for files WITH representation maps this is
        // a second linear EntityScanner pass over `content` on top of the
        // streaming scan above. A `IFCREPRESENTATIONMAP` substring guard inside
        // the helper makes the ~all-files-without-type-geometry case free (just a
        // SIMD memmem). The remaining instanced-file cost is a tracked follow-up:
        // fold the mapped-item-source + type-candidate collection into the
        // streaming scan loop so orphans resolve with no extra pass. Kept as a
        // separate pass for now to avoid destabilising the streaming hot path.
        let type_jobs = super::styling::collect_type_geometry_jobs(content, &mut decoder);
        if !type_jobs.is_empty() {
            total_jobs += type_jobs.len() as u32;
            emit_jobs_chunk(on_event, &type_jobs)?;
        }

        // Complete event.
        let done = js_sys::Object::new();
        super::set_js_prop(&done, "type", &"complete".into());
        super::set_js_prop(&done, "totalJobs", &(total_jobs as f64).into());
        on_event.call1(&JsValue::NULL, &done.into())?;

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
        use super::styling::{resolve_element_color, resolve_submesh_color};
        use ifc_lite_core::EntityDecoder;
        use ifc_lite_geometry::{calculate_normals, GeometryHasher, GeometryRouter};
        use ifc_lite_processing::default_color_for_type;

        let content = data;

        // Geometry fingerprinting for the viewer's revision-diff feature.
        // When enabled we hash each entity's meshes *before* MeshDataJs::new
        // applies the Z-up→Y-up swap, in the native IFC frame, reconstructing
        // world coordinates as `local + rtc` so the file's RTC choice never
        // registers as a change. Disabled (None) => zero overhead.
        let hash_tolerance = self.geometry_hash_tolerance();
        let hash_world_rtc: [f64; 3] = if needs_shift {
            [rtc_x, rtc_y, rtc_z]
        } else {
            [0.0, 0.0, 0.0]
        };

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

        // Create geometry router with unit scale and the consumer-selected
        // tessellation quality (issue #976) — Medium unless JS called
        // `setTessellationQuality`, so default output is byte-for-byte
        // identical to the pre-quality pipeline.
        let mut router =
            GeometryRouter::with_scale_and_quality(unit_scale, self.tessellation_quality());

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

        // IfcIndexedColourMap index (geometry id → full per-triangle palette),
        // built once per worker. Drives the #858 per-palette-group split below
        // so a face set whose ColourIndex assigns several colours to different
        // triangles renders multi-coloured instead of collapsing to the single
        // dominant colour the prepass `geometry_styles` carries.
        let indexed_colour_full = self.get_or_build_indexed_colour_maps(content, &mut decoder);

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

                // #957: orphan type-product geometry — an IfcXxxType carrying its
                // own RepresentationMaps with no occurrence to instantiate them
                // (buildingSMART annex-E "tessellated shape with style" files).
                // Render each RepresentationMap NOT referenced by an IfcMappedItem
                // (the referenced ones draw through their occurrence — no double
                // render).
                if ifc_type.is_subtype_of(ifc_lite_core::IfcType::IfcTypeProduct) {
                    // #957 follow-up + Model/Types view switch: type-product
                    // RepresentationMap geometry is ALWAYS emitted here, tagged with
                    // a geometry_class so the viewer can choose what to show:
                    //   class 1 = orphan type (no occurrence) — part of "the model"
                    //             since nothing else renders it (annex-E showcase).
                    //   class 2 = instanced type (an IfcRelDefinesByType links it to
                    //             an occurrence that already draws the real geometry).
                    //             Hidden in Model mode (else the AC20/ArchiCAD
                    //             duplicate-boxes-at-MappingOrigin regression returns);
                    //             shown in Types mode as the type-library shape.
                    // The native process_geometry path still SUPPRESSES class 2 (an
                    // export must not duplicate geometry); only the interactive viewer
                    // emits both and filters by view mode at render time.
                    let instantiated =
                        self.get_or_build_instantiated_type_ids(content, &mut decoder);
                    let type_class: u8 = if instantiated.contains(&id) { 2 } else { 1 };
                    let rep_map_ids: Vec<u32> = entity
                        .get(6)
                        .and_then(|a| a.as_list())
                        .map(|list| list.iter().filter_map(|v| v.as_entity_ref()).collect())
                        .unwrap_or_default();
                    if !rep_map_ids.is_empty() {
                        let referenced =
                            self.get_or_build_referenced_repmaps(content, &mut decoder);
                        // Surface textures + UV maps (#961), built once per worker.
                        let texture_index = self.get_or_build_texture_index(content, &mut decoder);
                        for rm_id in rep_map_ids {
                            if referenced.contains(&rm_id) {
                                continue;
                            }
                            let Ok(rep_map) = decoder.decode_by_id(rm_id) else {
                                continue;
                            };
                            // One part per output mesh: each textured face set
                            // carries its own image; untextured items merge (#961).
                            let Ok(parts) = router.process_representation_map_with_texture(
                                &rep_map,
                                &mut decoder,
                                &texture_index,
                            ) else {
                                continue;
                            };
                            if parts.is_empty() {
                                continue;
                            }
                            let color = super::styling::color_for_representation_map(
                                rm_id,
                                &geometry_styles,
                                &mut decoder,
                            )
                            .unwrap_or_else(|| default_color_for_type(ifc_type).to_array());
                            let ifc_type_name = type_name_cache
                                .entry(ifc_type)
                                .or_insert_with(|| ifc_type.name().to_string())
                                .clone();
                            for (mut mesh, uvs, texture) in parts {
                                if mesh.is_empty() {
                                    continue;
                                }
                                if mesh.normals.len() != mesh.positions.len() {
                                    calculate_normals(&mut mesh);
                                }
                                let mut mesh_js =
                                    MeshDataJs::new(id, ifc_type_name.clone(), mesh, color);
                                mesh_js.set_geometry_class(type_class);
                                if let Some(tex) = texture {
                                    mesh_js.set_texture(
                                        uvs,
                                        tex.rgba,
                                        tex.width,
                                        tex.height,
                                        tex.repeat_s,
                                        tex.repeat_t,
                                    );
                                }
                                mesh_collection.add(mesh_js);
                            }
                        }
                    }
                    continue;
                }

                let has_openings = void_index.contains_key(&id);

                // One fingerprint accumulator per entity. All of an entity's
                // submeshes are produced within this single loop iteration, so
                // the hash is fully resolved here — no cross-batch merge.
                let mut entity_hasher =
                    hash_tolerance.map(|tol| GeometryHasher::new(tol, hash_world_rtc));

                if has_openings {
                    // Submesh-aware cut first (server parity): per-part
                    // colours survive the void subtraction, so a voided
                    // multi-layer wall or window keeps frame/glass split.
                    let mut used_voided_submesh = false;
                    if let Ok(sub_meshes) = router.process_element_with_submeshes_and_voids(
                        &entity,
                        &mut decoder,
                        &void_index,
                    ) {
                        if !sub_meshes.is_empty() {
                            let default_color = default_color_for_type(ifc_type).to_array();
                            let element_color = element_styles.get(&id).copied();
                            let mut mat_color_idx = 0usize;
                            for sub in sub_meshes.sub_meshes {
                                let geometry_id = sub.geometry_id;
                                let mut mesh = sub.mesh;
                                if mesh.is_empty() {
                                    continue;
                                }
                                if mesh.normals.len() != mesh.positions.len() {
                                    calculate_normals(&mut mesh);
                                }
                                let color = resolve_submesh_color(
                                    geometry_id,
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
                                if let Some(h) = entity_hasher.as_mut() {
                                    h.add_mesh(&mesh.positions, &mesh.indices);
                                }
                                emit_submesh_with_palette_split(
                                    &mut mesh_collection,
                                    id,
                                    &ifc_type_name,
                                    geometry_id,
                                    mesh,
                                    color,
                                    &indexed_colour_full,
                                );
                                used_voided_submesh = true;
                            }
                        }
                    }
                    if !used_voided_submesh {
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
                                    .unwrap_or_else(|| default_color_for_type(ifc_type).to_array());
                                let ifc_type_name = type_name_cache
                                    .entry(ifc_type)
                                    .or_insert_with(|| ifc_type.name().to_string())
                                    .clone();
                                if let Some(h) = entity_hasher.as_mut() {
                                    h.add_mesh(&mesh.positions, &mesh.indices);
                                }
                                mesh_collection.add(MeshDataJs::new(id, ifc_type_name, mesh, color));
                            }
                        }
                    }
                } else {
                    // Submesh path for ALL types: per-geometry-item colors
                    // (window glass transparency, multi-material doors) and —
                    // crucially — unsupported representation items are skipped
                    // instead of aborting the entire element (process_element
                    // uses `?`).
                    {
                        if let Ok(sub_meshes) =
                            router.process_element_with_submeshes(&entity, &mut decoder)
                        {
                            if !sub_meshes.is_empty() {
                                let default_color = default_color_for_type(ifc_type).to_array();
                                let element_color = element_styles.get(&id).copied();
                                let mut mat_color_idx = 0usize;
                                for sub in sub_meshes.sub_meshes {
                                    let geometry_id = sub.geometry_id;
                                    let mut mesh = sub.mesh;
                                    if mesh.is_empty() {
                                        continue;
                                    }
                                    if mesh.normals.len() != mesh.positions.len() {
                                        calculate_normals(&mut mesh);
                                    }
                                    let color = resolve_submesh_color(
                                        geometry_id,
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
                                    if let Some(h) = entity_hasher.as_mut() {
                                        h.add_mesh(&mesh.positions, &mesh.indices);
                                    }
                                    emit_submesh_with_palette_split(
                                        &mut mesh_collection,
                                        id,
                                        &ifc_type_name,
                                        geometry_id,
                                        mesh,
                                        color,
                                        &indexed_colour_full,
                                    );
                                }
                            }
                        }
                    }
                }

                // Record the entity's geometry fingerprint (if any geometry
                // was produced and hashing is enabled).
                if let Some(h) = entity_hasher {
                    if !h.is_empty() {
                        mesh_collection.push_geometry_hash(id, h.finish());
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
