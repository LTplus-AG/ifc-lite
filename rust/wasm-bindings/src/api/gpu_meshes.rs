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

/// Reduce a 128-bit geometry hash to the 32-bit worker-affinity key the job
/// stream carries. Jobs with the SAME key are routed to the same geometry worker,
/// so their (byte-identical) geometry is meshed once per model instead of once per
/// worker — the win the per-worker content-dedup cache can't get across separate
/// WASM realms. A 32-bit collision only co-locates two unrelated geometries on one
/// worker (harmless: the cache still keys them apart), so xor-folding the lanes is
/// plenty.
#[inline]
fn fold_u128_to_u32(h: u128) -> u32 {
    (h as u32) ^ ((h >> 32) as u32) ^ ((h >> 64) as u32) ^ ((h >> 96) as u32)
}

// The per-submesh #858 palette split lives inside the canonical per-element
// producer (`ifc_lite_processing::element`) — shared with the native pipeline.

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

        // Resolve BOTH unit scales once via the shared resolver (handles a
        // missing project-id hint and partial-index chains internally) and
        // seed the decoder so nothing downstream re-pays the IFCPROJECT hunt.
        let unit_scales = ifc_lite_processing::prepass::resolve_unit_scales(
            content,
            pre_pass.project_id,
            &mut decoder,
        );
        let unit_scale = unit_scales.length_unit_scale;
        decoder.seed_unit_scales(unit_scale, unit_scales.plane_angle_to_radians);
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

        // Flat wire encodings from the shared resolver: styles (layered
        // precedence), voids, and the #407 material colour lists.
        let (style_ids_vec, style_colors_vec) = ifc_lite_processing::prepass::flat_styles_rgba8(
            &pre_pass.resolved,
            &mut decoder,
        );
        let (void_keys_vec, void_counts_vec, void_values_vec) =
            ifc_lite_processing::prepass::flat_voids(&pre_pass.resolved.void_index);
        let (mat_ids_vec, mat_counts_vec, mat_colors_vec) =
            ifc_lite_processing::prepass::flat_material_colors(
                &pre_pass.resolved.element_material_colors,
            );

        let void_keys = js_sys::Uint32Array::from(void_keys_vec.as_slice());
        let void_counts = js_sys::Uint32Array::from(void_counts_vec.as_slice());
        let void_values = js_sys::Uint32Array::from(void_values_vec.as_slice());
        let style_ids = js_sys::Uint32Array::from(style_ids_vec.as_slice());
        let style_colors = js_sys::Uint8Array::from(style_colors_vec.as_slice());
        let material_element_ids = js_sys::Uint32Array::from(mat_ids_vec.as_slice());
        let material_color_counts = js_sys::Uint32Array::from(mat_counts_vec.as_slice());
        let material_colors = js_sys::Uint8Array::from(mat_colors_vec.as_slice());

        // Build result object
        let result = js_sys::Object::new();
        super::set_js_prop(&result, "jobs", &jobs_flat);
        super::set_js_prop(&result, "totalJobs", &(total_jobs as f64).into());
        super::set_js_prop(&result, "unitScale", &unit_scale.into());
        super::set_js_prop(
            &result,
            "planeAngleToRadians",
            &unit_scales.plane_angle_to_radians.into(),
        );

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
        // #407/#913 §2.3: per-element material colour lists so the batch path
        // can run the transparent/opaque sub-mesh alternation.
        super::set_js_prop(&result, "materialElementIds", &material_element_ids);
        super::set_js_prop(&result, "materialColorCounts", &material_color_counts);
        super::set_js_prop(&result, "materialColors", &material_colors);

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
        // #1097 perf: optional load-time visibility filter. `disabled_type_names`
        // (uppercase STEP keywords, e.g. "IFCSPACE", "IFCANNOTATION") are skipped
        // at job generation so their geometry is never decoded/meshed/uploaded;
        // `skip_type_geometry` drops the #957 type-library (IfcTypeProduct) jobs.
        // Both default to "load everything" (None / false) — callers that don't
        // pass them keep the old behaviour. Toggling a type back ON requires a
        // reload (the jobs were never produced).
        disabled_type_names: Option<Vec<String>>,
        skip_type_geometry: bool,
    ) -> Result<JsValue, JsValue> {
        use super::styling::extract_building_rotation_from_site;
        use ifc_lite_core::{has_geometry_by_name, EntityDecoder, EntityScanner, IfcType};
        use ifc_lite_geometry::GeometryRouter;

        let chunk_size = chunk_size.max(1024) as usize;
        let content = data;

        // Build the load-time skip set (uppercase STEP keywords). Empty when the
        // caller passes nothing → no filtering.
        let disabled_types: rustc_hash::FxHashSet<String> = disabled_type_names
            .unwrap_or_default()
            .into_iter()
            .map(|s| s.to_ascii_uppercase())
            .collect();

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
        // Plane-angle scale, resolved with the meta by the shared resolver and
        // carried on the meta event so workers seed their batch decoders.
        let mut plane_angle_to_radians = 1.0f64;

        // Hold a chunk buffer that we drain to JS — these are the last
        // `chunk_size` jobs awaiting flush. After `meta` the buffer is
        // drained as the first jobs event; subsequent flushes happen at
        // every `chunk_size` boundary.
        const RTC_SAMPLE_THRESHOLD: usize = 50;

        // Emit a chunk of jobs to JS as a Uint32Array of [id, start, end] triples,
        // PLUS a parallel `affinity` Uint32Array (one precomputed key per job). The
        // host dispatcher routes all jobs sharing an affinity key to the SAME
        // worker, so byte-identical geometry the exporter failed to share via
        // IfcMappedItem is meshed once per model instead of once per worker (#1130
        // follow-up). `affinity` must be the same length as `jobs`; keys are the
        // element's exact geometry hash (see the post-scan pass that builds them).
        fn emit_jobs_chunk(
            on_event: &Function,
            jobs: &[(u32, usize, usize, IfcType)],
            affinity: &[u32],
        ) -> Result<(), JsValue> {
            if jobs.is_empty() {
                return Ok(());
            }
            let arr = js_sys::Uint32Array::new_with_length((jobs.len() * 3) as u32);
            let aff = js_sys::Uint32Array::new_with_length(jobs.len() as u32);
            let mut idx = 0u32;
            for (j, &(id, start, end, _)) in jobs.iter().enumerate() {
                arr.set_index(idx, id);
                arr.set_index(idx + 1, start as u32);
                arr.set_index(idx + 2, end as u32);
                idx += 3;
                aff.set_index(j as u32, affinity.get(j).copied().unwrap_or(id));
            }
            let event = js_sys::Object::new();
            super::set_js_prop(&event, "type", &"jobs".into());
            super::set_js_prop(&event, "jobs", &arr);
            super::set_js_prop(&event, "affinity", &aff);
            on_event.call1(&JsValue::NULL, &event.into())?;
            Ok(())
        }

        // Spans of entities that need decoding for style collection — we
        // can't decode mid-scan because the decoder borrows `content` and
        // would need `entity_index` populated for any references it follows.
        // Stash them in the SHARED span container and resolve after the scan
        // with `ifc_lite_processing::prepass::resolve_prepass` — the exact
        // resolver the native pipeline and `buildPrePassOnce` run.
        let mut prepass_spans = ifc_lite_processing::prepass::PrepassSpans::default();

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
                    prepass_spans.styled_items.push((id, start, end));
                }
                "IFCINDEXEDCOLOURMAP" => {
                    prepass_spans.indexed_colour_maps.push((id, start, end));
                }
                "IFCMATERIALDEFINITIONREPRESENTATION" => {
                    prepass_spans.material_def_reprs.push((id, start, end));
                }
                "IFCRELASSOCIATESMATERIAL" => {
                    prepass_spans.rel_associates_material.push((id, start, end));
                }
                "IFCRELVOIDSELEMENT" => {
                    prepass_spans.void_rels.push((id, start, end));
                }
                "IFCRELFILLSELEMENT" => {
                    prepass_spans.fills_rels.push((id, start, end));
                }
                "IFCRELAGGREGATES" => {
                    prepass_spans.aggregate_rels.push((id, start, end));
                }
                _ => {
                    if has_geometry_by_name(type_name) && !disabled_types.contains(type_name) {
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

            // Once enough sample jobs are buffered, resolve the meta (unit
            // scales + RTC offset + building rotation) and emit it along with
            // the buffered first chunk so workers can start. The gate
            // deliberately does NOT wait for IFCPROJECT: IfcOpenShell/Revit
            // exports emit it near the END of the file, and waiting would
            // delay every worker until ~90% of the scan on such models. The
            // shared resolver finds a not-yet-scanned project by SIMD
            // substring search and resolves partial-index chains against a
            // full index instead of silently defaulting (a millimetre model
            // resolved as metres renders 1000× oversized).
            if !meta_emitted && buffered_jobs.len() >= RTC_SAMPLE_THRESHOLD {
                // Build a decoder over the partial entity index built so far.
                let mut decoder = EntityDecoder::with_index(content, entity_index.clone());
                let unit_scales = ifc_lite_processing::prepass::resolve_unit_scales(
                    content,
                    project_id,
                    &mut decoder,
                );
                let unit_scale = unit_scales.length_unit_scale;
                decoder.seed_unit_scales(unit_scale, unit_scales.plane_angle_to_radians);
                plane_angle_to_radians = unit_scales.plane_angle_to_radians;

                let router = GeometryRouter::with_scale(unit_scale);
                let is_large = |t: (f64, f64, f64)| {
                    t.0.abs() > 10000.0 || t.1.abs() > 10000.0 || t.2.abs() > 10000.0
                };
                let detected_rtc = router.detect_rtc_offset_from_jobs(&buffered_jobs, &mut decoder);
                let mut rtc_offset = detected_rtc.unwrap_or((0.0, 0.0, 0.0));
                // True once ANY detection (partial OR the full re-detect below)
                // resolved usable placement samples — even if it concluded "no
                // shift" (0,0,0). The placement-bounds fallback must NOT override
                // a successful "no shift": that scan averages ALL placement
                // points incl. a far georef anchor (e.g. IfcSite/MapConversion at
                // national grid), so on a building whose geometry sits near origin
                // but carries a georef datum it returns a bogus ~-792 km offset,
                // pushing the whole model off-screen.
                let mut detection_succeeded = detected_rtc.is_some();

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
                        // The full index resolved the placement chain — this is a
                        // successful detection whether it shifts (large) or not.
                        detection_succeeded = true;
                        if is_large(full_rtc) {
                            rtc_offset = full_rtc;
                        }
                    }
                }
                // Server parity LAST RESORT: only when NO detection (partial or
                // full) found any usable placement translations do we scan the
                // placement bounds (a model whose placements truly can't decode
                // from this index, e.g. a genuine >10 km georef whose chain is
                // unresolved). A successful "no shift" must NOT reach here, or the
                // georef-anchor-skewed scan would re-base an origin-local model.
                if !detection_succeeded && !is_large(rtc_offset) {
                    let raw = ifc_lite_core::scan_placement_bounds(content).rtc_offset();
                    // scan_placement_bounds reads raw IfcCartesianPoint values
                    // (FILE units); the detection path is unit-scaled to metres.
                    rtc_offset = (raw.0 * unit_scale, raw.1 * unit_scale, raw.2 * unit_scale);
                }
                let needs_shift = is_large(rtc_offset);

                let building_rotation = site_position.and_then(|pos| {
                    extract_building_rotation_from_site(pos, &router, &mut decoder)
                });

                // Emit meta event.
                let meta = js_sys::Object::new();
                super::set_js_prop(&meta, "type", &"meta".into());
                super::set_js_prop(&meta, "unitScale", &unit_scale.into());
                super::set_js_prop(
                    &meta,
                    "planeAngleToRadians",
                    &plane_angle_to_radians.into(),
                );
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
                meta_emitted = true;
                // NOTE: jobs are NOT drained here. They are buffered through the
                // whole scan and emitted post-scan with an exact geometry-hash
                // affinity key (which needs the COMPLETE entity index). Deferring
                // is free: workers gate on the styles + entity-index events, both
                // of which are themselves post-scan.
                continue;
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
            let unit_scales = ifc_lite_processing::prepass::resolve_unit_scales(
                content,
                project_id,
                &mut decoder,
            );
            let unit_scale = unit_scales.length_unit_scale;
            decoder.seed_unit_scales(unit_scale, unit_scales.plane_angle_to_radians);
            plane_angle_to_radians = unit_scales.plane_angle_to_radians;
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
            super::set_js_prop(
                &meta,
                "planeAngleToRadians",
                &plane_angle_to_radians.into(),
            );
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

        // ── Geometry-hash affinity + job emission (post-scan) ──
        // The entity index is COMPLETE now, so tag every buffered job with the
        // exact 128-bit hash of its representation subtree (`geometry_routing_key`)
        // and stream the jobs in chunks. The host routes all jobs of a key to ONE
        // worker, so each unique geometry is meshed once per model — the per-worker
        // dedup cache turns the rest into cheap hits — instead of every worker
        // re-meshing the full unique set. Cheap: ~tens of ms for a 25 k-element
        // model (decode is index-cached, the hash is integer folds). On decode
        // failure the key falls back to the element id (its own bucket).
        {
            let mut akey_decoder =
                EntityDecoder::with_arc_index(content, entity_index_arc.clone());
            // The routing key is a STRUCTURAL hash (`item_signature`) — it neither
            // tessellates nor scales, so the router's unit scale is irrelevant here
            // and we skip seeding it.
            let akey_router = GeometryRouter::new();
            let mut affinity: Vec<u32> = Vec::with_capacity(buffered_jobs.len());
            for &(id, _s, _e, _t) in &buffered_jobs {
                let key = match akey_decoder.decode_by_id(id) {
                    Ok(ent) => akey_router
                        .geometry_routing_key(&ent, &mut akey_decoder)
                        .map(fold_u128_to_u32)
                        .unwrap_or(id),
                    Err(_) => id,
                };
                affinity.push(key);
            }
            for (jobs_chunk, aff_chunk) in buffered_jobs
                .chunks(chunk_size)
                .zip(affinity.chunks(chunk_size))
            {
                emit_jobs_chunk(on_event, jobs_chunk, aff_chunk)?;
            }
        }
        buffered_jobs.clear();

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
        decoder.seed_unit_scales(1.0, plane_angle_to_radians);

        // Shared post-scan resolution — the exact resolver the native
        // pipeline and `buildPrePassOnce` run. Full per-triangle palettes
        // (#858) stay per-worker rebuilds; the wire carries dominants only.
        let resolved = ifc_lite_processing::prepass::resolve_prepass(
            &prepass_spans,
            &mut decoder,
            ifc_lite_processing::prepass::ResolveOptions {
                collect_indexed_colour_full: false,
                defer_attached_styles: false,
            },
        );

        // Serialise styles + voids + material colour lists and post a `styles`
        // event before `complete` so the host can dispatch them to all
        // process workers and emit a colorUpdate for already-rendered meshes.
        let (style_ids_vec, style_colors_vec) =
            ifc_lite_processing::prepass::flat_styles_rgba8(&resolved, &mut decoder);
        let (void_keys_vec, void_counts_vec, void_values_vec) =
            ifc_lite_processing::prepass::flat_voids(&resolved.void_index);
        let (mat_ids_vec, mat_counts_vec, mat_colors_vec) =
            ifc_lite_processing::prepass::flat_material_colors(
                &resolved.element_material_colors,
            );

        let styles_event = js_sys::Object::new();
        super::set_js_prop(&styles_event, "type", &"styles".into());
        super::set_js_prop(
            &styles_event,
            "styleIds",
            &js_sys::Uint32Array::from(style_ids_vec.as_slice()),
        );
        super::set_js_prop(
            &styles_event,
            "styleColors",
            &js_sys::Uint8Array::from(style_colors_vec.as_slice()),
        );
        super::set_js_prop(
            &styles_event,
            "voidKeys",
            &js_sys::Uint32Array::from(void_keys_vec.as_slice()),
        );
        super::set_js_prop(
            &styles_event,
            "voidCounts",
            &js_sys::Uint32Array::from(void_counts_vec.as_slice()),
        );
        super::set_js_prop(
            &styles_event,
            "voidValues",
            &js_sys::Uint32Array::from(void_values_vec.as_slice()),
        );
        // #407/#913 §2.3: per-element material colour lists so the batch path
        // can run the transparent/opaque sub-mesh alternation.
        super::set_js_prop(
            &styles_event,
            "materialElementIds",
            &js_sys::Uint32Array::from(mat_ids_vec.as_slice()),
        );
        super::set_js_prop(
            &styles_event,
            "materialColorCounts",
            &js_sys::Uint32Array::from(mat_counts_vec.as_slice()),
        );
        super::set_js_prop(
            &styles_event,
            "materialColors",
            &js_sys::Uint8Array::from(mat_colors_vec.as_slice()),
        );
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
        // #1097 perf: the viewer's default Model view does not render the
        // type-library (#957) geometry, so skip producing it at load when the
        // caller asks (the Types view re-loads on demand).
        if !skip_type_geometry {
            let type_jobs = super::styling::collect_type_geometry_jobs(content, &mut decoder);
            if !type_jobs.is_empty() {
                total_jobs += type_jobs.len() as u32;
                // Type-library geometry is a small, usually-suppressed tail; route
                // each job to its own bucket (id key) so they spread round-robin.
                let type_affinity: Vec<u32> = type_jobs.iter().map(|&(id, ..)| id).collect();
                emit_jobs_chunk(on_event, &type_jobs, &type_affinity)?;
            }
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
        // Trailing optional wire fields (additive — older callers omit them):
        // the prepass-resolved plane-angle scale (falls back to the per-worker
        // cache when absent), and the #407 per-element material colour lists
        // in `flat_material_colors` encoding.
        plane_angle_to_radians: Option<f64>,
        material_element_ids: Option<Vec<u32>>,
        material_color_counts: Option<Vec<u32>>,
        material_colors_rgba: Option<Vec<u8>>,
    ) -> MeshCollection {
        use super::styling::resolve_element_color;
        use ifc_lite_core::EntityDecoder;
        use ifc_lite_geometry::GeometryRouter;
        use ifc_lite_processing::element::{
            plan_type_geometry, produce_element_meshes, ElementJobKind, ElementMeshJob,
            GeometryHashConfig, MeshProductionContext, MeshProductionOptions, TypeGeometryMode,
        };
        use ifc_lite_processing::style::GeometryStyleInfo;

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
        // Seed the unit-scale caches so curve/arc tessellation never re-pays the
        // O(file) IFCPROJECT scan: this decoder is fresh on every batch call,
        // and `plane_angle_to_radians()` would otherwise walk the whole DATA
        // section per batch on files whose IFCPROJECT sits near the end
        // (IfcOpenShell exports) — the geometry-stream stall on large models.
        let plane_angle_to_radians = plane_angle_to_radians
            .unwrap_or_else(|| self.get_or_resolve_plane_angle(&mut decoder));
        decoder.seed_unit_scales(unit_scale, plane_angle_to_radians);

        // Create geometry router with unit scale and the consumer-selected
        // tessellation quality (issue #976) — Medium unless JS called
        // `setTessellationQuality`, so default output is byte-for-byte
        // identical to the pre-quality pipeline.
        let mut router =
            GeometryRouter::with_scale_and_quality(unit_scale, self.tessellation_quality());

        // Arm content-dedup against the per-worker shared cache so byte-identical
        // geometry (e.g. Tekla parts the exporter failed to share via
        // IfcMappedItem) is meshed ONCE across batches, not once per batch.
        // content-dedup default OFF: its structural hash costs more than the
        // meshing it skips on real models (see GeometryRouter::content_dedup_enabled).
        if GeometryRouter::content_dedup_enabled() {
            let mut slot = self
                .cached_item_dedup
                .lock()
                .expect("ifc-lite cached_item_dedup Mutex poisoned");
            let cache = slot
                .get_or_insert_with(GeometryRouter::new_dedup_cache)
                .clone();
            router.enable_content_dedup_shared(cache);
        }

        // Attach the per-content material-layer index so single-solid walls and
        // slabs carrying an IfcMaterialLayerSetUsage slice into one coloured
        // sub-mesh per layer (#563). Built once per load and Arc-shared across
        // batches; #874 dropped this wiring, silently disabling layered-wall
        // rendering for the entire browser stream. Cheap on files with no layer
        // set (substring bail-out inside the index builder).
        //
        // "Merge Multilayer Walls" (the merge_layers toggle, #540) means exactly
        // "render walls as ONE solid": NOT attaching the index leaves each wall as
        // its single swept solid (no per-layer slice). So gate the index on the
        // flag — off (default) ⇒ slice into layers; on ⇒ one solid. The separate
        // part-skip path below keeps its own index, so IfcBuildingElementPart
        // merging is unaffected.
        if !self.merge_layers() {
            router.set_material_layer_index(self.get_or_build_material_layer_index(content, &mut decoder));
        }

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

        // #1097: the wire styles are session-constant, so build the colour map
        // AND the GeometryStyleInfo index the producer consumes ONCE per worker
        // and reuse across batches (was ~18 M HashMap inserts each on a 140 K-
        // styled model). Keyed by a cheap (len, first_id, last_id) signature.
        let style_maps: std::sync::Arc<(
            rustc_hash::FxHashMap<u32, [f32; 4]>,
            rustc_hash::FxHashMap<u32, GeometryStyleInfo>,
        )> = {
            let sig_len = style_ids.len();
            let sig_first = style_ids.first().copied().unwrap_or(0);
            let sig_last = style_ids.last().copied().unwrap_or(0);
            let mut slot = self
                .cached_geometry_styles
                .lock()
                .expect("ifc-lite cached_geometry_styles Mutex poisoned");
            match slot.as_ref() {
                Some((l, f, la, arc)) if *l == sig_len && *f == sig_first && *la == sig_last => {
                    std::sync::Arc::clone(arc)
                }
                _ => {
                    let mut colors: rustc_hash::FxHashMap<u32, [f32; 4]> =
                        rustc_hash::FxHashMap::with_capacity_and_hasher(sig_len, Default::default());
                    for i in 0..style_ids.len() {
                        let base = i * 4;
                        if base + 3 < style_colors.len() {
                            colors.insert(
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
                    let index: rustc_hash::FxHashMap<u32, GeometryStyleInfo> = colors
                        .iter()
                        .map(|(&id, &c)| (id, GeometryStyleInfo::from_color(c)))
                        .collect();
                    let arc = std::sync::Arc::new((colors, index));
                    *slot = Some((sig_len, sig_first, sig_last, std::sync::Arc::clone(&arc)));
                    arc
                }
            }
        };
        let geometry_styles = &style_maps.0;
        // #1097: element colours were resolved in a separate pre-pass that
        // re-decoded every job entity (a second full decode + deep-clone pass).
        // That resolution is now folded into the main loop below — each entity
        // is decoded ONCE (as an Arc, no deep clone), so we no longer build an
        // `element_styles` map up front.

        // Pre-allocate
        let num_jobs = jobs_flat.len() / 3;
        decoder.reserve_cache(num_jobs * 2);
        let mut mesh_collection = MeshCollection::with_capacity(num_jobs);

        if needs_shift {
            mesh_collection.set_rtc_offset(rtc_x, rtc_y, rtc_z);
        }

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
        // built once per worker (#858) — the canonical producer splits face
        // sets per palette group so multi-coloured triangles don't collapse to
        // the single dominant colour the prepass `geometry_styles` carries.
        let indexed_colour_full = self.get_or_build_indexed_colour_maps(content, &mut decoder);

        // The canonical styled-item index the shared producer consumes — built
        // once per worker alongside `geometry_styles` above (#1097).
        let geometry_style_index = &style_maps.1;
        // Surface textures + UV maps (#961), built once per worker (cheap
        // substring bail-out for untextured files).
        let texture_index = self.get_or_build_texture_index(content, &mut decoder);
        // #407/#913 §2.3: per-element material colour lists from the prepass
        // wire, so the canonical producer's transparent/opaque sub-mesh
        // alternation fires in the browser exactly like on the server.
        // Absent (older callers) ⇒ empty map ⇒ alternation never fires.
        let element_material_colors: rustc_hash::FxHashMap<u32, Vec<[f32; 4]>> = match (
            material_element_ids.as_deref(),
            material_color_counts.as_deref(),
            material_colors_rgba.as_deref(),
        ) {
            (Some(ids), Some(counts), Some(rgba)) => {
                ifc_lite_processing::prepass::material_colors_from_flat(ids, counts, rgba)
            }
            _ => rustc_hash::FxHashMap::default(),
        };

        let ctx = MeshProductionContext {
            void_index: &void_index,
            geometry_style_index,
            indexed_colour_full: &indexed_colour_full,
            element_material_colors: &element_material_colors,
            texture_index: &texture_index,
            // The browser's axis change (IFC Z-up → WebGL Y-up) happens at the
            // FFI boundary in `MeshDataJs::from_mesh_data`, not here.
            site_local_rotation: None,
        };
        let opts = MeshProductionOptions {
            geometry_hash: hash_tolerance.map(|tolerance| GeometryHashConfig {
                tolerance,
                world_rtc: hash_world_rtc,
            }),
        };

        // CSG diagnostics, aggregated across the batch: the canonical producer
        // drains the (warm, batch-shared) router per element so one element's
        // failures never bleed into the next; we collect them here and hand
        // them to the logger below.
        let mut batch_csg_failures: rustc_hash::FxHashMap<
            u32,
            Vec<ifc_lite_geometry::BoolFailure>,
        > = rustc_hash::FxHashMap::default();

        // Process only the entities specified in jobs_flat — every job runs
        // THE canonical per-element producer (`ifc_lite_processing::element`),
        // the same code the native pipeline runs.
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

            // #1097: decode_and_cache returns the cached Arc (cheap Arc::clone),
            // not a deep clone of the DecodedEntity — was the dominant per-job
            // marshalling cost across ~60-110 K jobs. produce_element_meshes
            // takes `&DecodedEntity`, so we deref the Arc at the call site.
            let Ok(entity) = decoder.decode_and_cache(id, start, end) else {
                continue;
            };
            let ifc_type = entity.ifc_type;

            // Resolve the element-level colour inline (folded from the deleted
            // pre-pass) so the entity is decoded exactly once.
            let element_color = if !geometry_styles.is_empty()
                && entity.get(6).map(|a| !a.is_null()).unwrap_or(false)
            {
                resolve_element_color(entity.as_ref(), geometry_styles, &mut decoder)
            } else {
                None
            };

            // #957: type products render their planned RepresentationMaps. The
            // viewer emits BOTH orphan (class 1) and instanced (class 2) maps —
            // `EmitTagged` — so the Model/Types switch can filter at render
            // time; the native pipeline plans the same jobs with
            // `SuppressInstanced` (an export must not duplicate geometry).
            let kind = if ifc_type.is_subtype_of(ifc_lite_core::IfcType::IfcTypeProduct) {
                let rep_map_ids: Vec<u32> = entity
                    .get(6)
                    .and_then(|a| a.as_list())
                    .map(|list| list.iter().filter_map(|v| v.as_entity_ref()).collect())
                    .unwrap_or_default();
                if rep_map_ids.is_empty() {
                    continue;
                }
                let referenced = self.get_or_build_referenced_repmaps(content, &mut decoder);
                let instantiated = self.get_or_build_instantiated_type_ids(content, &mut decoder);
                let rep_maps = plan_type_geometry(
                    &rep_map_ids,
                    &referenced,
                    instantiated.contains(&id),
                    TypeGeometryMode::EmitTagged,
                );
                if rep_maps.is_empty() {
                    continue;
                }
                ElementJobKind::TypeProduct { rep_maps }
            } else {
                ElementJobKind::Product
            };

            let produced = produce_element_meshes(
                &ElementMeshJob {
                    id,
                    ifc_type,
                    entity: entity.as_ref(),
                    kind,
                    element_color,
                    // The viewer gets element metadata from the parser worker.
                    metadata: None,
                },
                &ctx,
                &opts,
                &mut decoder,
                &router,
            );

            for mesh_data in produced.meshes {
                mesh_collection.add(MeshDataJs::from_mesh_data(mesh_data));
            }
            if let Some(hash) = produced.geometry_hash {
                mesh_collection.push_geometry_hash(id, hash);
            }
            for (product_id, fails) in produced.csg_failures {
                batch_csg_failures.entry(product_id).or_default().extend(fails);
            }
        }

        // Surface the opening / CSG diagnostics. The viewer's large-file path
        // goes processAdaptive -> processParallel -> Web Workers ->
        // `processGeometryBatch`, so the log has to fire here or the
        // diagnostic helper never runs for real-world files.
        let _ = super::drain_and_log_csg_diagnostics(&router, batch_csg_failures);

        // Layered-wall slicing diagnostics (#563): a quiet success summary, but a
        // per-element warning (id + reason) when a sliceable wall fails to slice
        // — so future regressions surface without spamming healthy loads. Reasons:
        // not-single-unshifted-item / thin-layers-collapsed-to-1 /
        // placement-unresolved / cut-produced-<2 / base-mesh-error.
        let layer_diag = router.take_layer_slice_diag();
        if !layer_diag.is_empty() {
            let sliced = layer_diag.iter().filter(|(_, r)| r.starts_with("ok:")).count();
            let not_sliced = layer_diag.len() - sliced;
            if not_sliced == 0 {
                web_sys::console::info_1(
                    &format!("[ifc-lite layers] batch: sliced {} wall(s) into layers", sliced)
                        .into(),
                );
            } else {
                let detail: Vec<String> = layer_diag
                    .iter()
                    .filter(|(_, r)| !r.starts_with("ok:"))
                    .map(|(id, r)| format!("#{}={}", id, r))
                    .collect();
                web_sys::console::warn_1(
                    &format!(
                        "[ifc-lite layers] batch: sliced {}, {} NOT sliced — {}",
                        sliced,
                        not_sliced,
                        detail.join(", ")
                    )
                    .into(),
                );
            }
        }

        mesh_collection
    }
}

#[cfg(test)]
mod affinity_tests {
    use super::fold_u128_to_u32;

    #[test]
    fn fold_is_stable_and_mixes_all_lanes() {
        // Identical hashes fold to identical keys (routing stickiness).
        assert_eq!(fold_u128_to_u32(0x1234_5678_9abc_def0_1111_2222_3333_4444),
                   fold_u128_to_u32(0x1234_5678_9abc_def0_1111_2222_3333_4444));
        // A change confined to ANY single 32-bit lane changes the key — so two
        // geometries differing only in their high bits still route apart.
        let base = 0u128;
        assert_ne!(fold_u128_to_u32(base), fold_u128_to_u32(base | (1u128 << 0)));
        assert_ne!(fold_u128_to_u32(base), fold_u128_to_u32(base | (1u128 << 40)));
        assert_ne!(fold_u128_to_u32(base), fold_u128_to_u32(base | (1u128 << 72)));
        assert_ne!(fold_u128_to_u32(base), fold_u128_to_u32(base | (1u128 << 120)));
    }
}
