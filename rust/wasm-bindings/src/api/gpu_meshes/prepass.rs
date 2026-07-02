// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::api::IfcAPI;
use js_sys::Function;
use wasm_bindgen::prelude::*;

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
        use crate::api::styling::{combined_pre_pass, extract_building_rotation_from_site};
        use ifc_lite_core::EntityDecoder;
        use ifc_lite_geometry::GeometryRouter;

        // Load START on the serial/main-thread path: the previous load's
        // pipeline diagnostics must not accumulate into this one. (The worker
        // path resets via setEntityIndex; every load-start entry point resets.)
        self.reset_pipeline_diagnostics();

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
        let router = GeometryRouter::with_scale(unit_scale);

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
        crate::api::set_js_prop(&result, "jobs", &jobs_flat);
        crate::api::set_js_prop(&result, "totalJobs", &(total_jobs as f64).into());
        crate::api::set_js_prop(&result, "unitScale", &unit_scale.into());
        crate::api::set_js_prop(
            &result,
            "planeAngleToRadians",
            &unit_scales.plane_angle_to_radians.into(),
        );

        let rtc_arr = js_sys::Float64Array::new_with_length(3);
        rtc_arr.set_index(0, rtc_offset.0);
        rtc_arr.set_index(1, rtc_offset.1);
        rtc_arr.set_index(2, rtc_offset.2);
        crate::api::set_js_prop(&result, "rtcOffset", &rtc_arr);
        crate::api::set_js_prop(&result, "needsShift", &needs_shift.into());

        match building_rotation {
            Some(rot) => crate::api::set_js_prop(&result, "buildingRotation", &rot.into()),
            None => crate::api::set_js_prop(&result, "buildingRotation", &JsValue::NULL),
        };

        crate::api::set_js_prop(&result, "voidKeys", &void_keys);
        crate::api::set_js_prop(&result, "voidCounts", &void_counts);
        crate::api::set_js_prop(&result, "voidValues", &void_values);
        crate::api::set_js_prop(&result, "styleIds", &style_ids);
        crate::api::set_js_prop(&result, "styleColors", &style_colors);
        // #407/#913 §2.3: per-element material colour lists so the batch path
        // can run the transparent/opaque sub-mesh alternation.
        crate::api::set_js_prop(&result, "materialElementIds", &material_element_ids);
        crate::api::set_js_prop(&result, "materialColorCounts", &material_color_counts);
        crate::api::set_js_prop(&result, "materialColors", &material_colors);

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
        use crate::api::styling::extract_building_rotation_from_site;
        // Load START on the streaming pre-pass path (see build_pre_pass_once).
        self.reset_pipeline_diagnostics();
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
            crate::api::set_js_prop(&event, "type", &"jobs".into());
            crate::api::set_js_prop(&event, "jobs", &arr);
            crate::api::set_js_prop(&event, "affinity", &aff);
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
                // of vertex jitter. Re-detect against a FULL index when no large
                // offset was found AND either (a) we haven't scanned the IfcSite
                // yet, or (b) the partial index resolved NO usable placement
                // samples at all. Case (b) covers the inverse ordering: the
                // IfcSite *entity* is early (so `site_position` is already set) but
                // its IfcAxis2Placement3D *location* — where the national-grid
                // offset actually lives — is forward-referenced past the file head,
                // so the element→storey→building→site chain still can't resolve and
                // detection returns None. Gating on `!detection_succeeded` instead
                // of site scan order alone keeps the common early-site model that
                // DID resolve a (0,0,0) "no shift" from paying for a second index
                // build, while rescuing the forward-referenced-placement case that
                // otherwise fell through to the placement-bounds centroid — which
                // averages the near-origin relative placements against the lone far
                // anchor and lands at ~half the true offset, leaving geometry
                // stranded in the f32-collapse zone.
                // (`buildPrePassOnce` and the small-file tail already use a full
                // index, so only this early-meta path needs the fallback.)
                if !is_large(rtc_offset) && (site_position.is_none() || !detection_succeeded) {
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
                crate::api::set_js_prop(&meta, "type", &"meta".into());
                crate::api::set_js_prop(&meta, "unitScale", &unit_scale.into());
                crate::api::set_js_prop(
                    &meta,
                    "planeAngleToRadians",
                    &plane_angle_to_radians.into(),
                );
                let rtc_arr = js_sys::Float64Array::new_with_length(3);
                rtc_arr.set_index(0, rtc_offset.0);
                rtc_arr.set_index(1, rtc_offset.1);
                rtc_arr.set_index(2, rtc_offset.2);
                crate::api::set_js_prop(&meta, "rtcOffset", &rtc_arr);
                crate::api::set_js_prop(&meta, "needsShift", &needs_shift.into());
                match building_rotation {
                    Some(rot) => crate::api::set_js_prop(&meta, "buildingRotation", &rot.into()),
                    None => crate::api::set_js_prop(&meta, "buildingRotation", &JsValue::NULL),
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
            crate::api::set_js_prop(&meta, "type", &"meta".into());
            crate::api::set_js_prop(&meta, "unitScale", &unit_scale.into());
            crate::api::set_js_prop(
                &meta,
                "planeAngleToRadians",
                &plane_angle_to_radians.into(),
            );
            let rtc_arr = js_sys::Float64Array::new_with_length(3);
            rtc_arr.set_index(0, rtc_offset.0);
            rtc_arr.set_index(1, rtc_offset.1);
            rtc_arr.set_index(2, rtc_offset.2);
            crate::api::set_js_prop(&meta, "rtcOffset", &rtc_arr);
            crate::api::set_js_prop(&meta, "needsShift", &needs_shift.into());
            match building_rotation {
                Some(rot) => crate::api::set_js_prop(&meta, "buildingRotation", &rot.into()),
                None => crate::api::set_js_prop(&meta, "buildingRotation", &JsValue::NULL),
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

        // ── FAST FIRST GEOMETRY ──
        // Workers gate on three post-scan events: entity-index, styles, and the
        // first jobs chunk. Previously all three waited behind a whole-model
        // per-job affinity hash (geometry_routing_key over every job, ~4 s), and
        // the entity-index event was emitted LAST of all — so workers idled until
        // ~the end of the pre-pass. Now we ship entity-index + styles + a SMALL
        // first job wave right here (the index is already complete), then run the
        // affinity pass only over the REST. Only the first wave routes by id; the
        // bulk keeps exact geometry-hash affinity, so dedup distribution is intact.

        // (A) Entity-index — workers re-scan the whole file (~5 s) without it, so
        // it must reach them as early as possible. Built from the complete index.
        {
            let n = index_for_export.len();
            let ids_arr = js_sys::Uint32Array::new_with_length(n as u32);
            let starts_arr = js_sys::Uint32Array::new_with_length(n as u32);
            let lengths_arr = js_sys::Uint32Array::new_with_length(n as u32);
            for (i, (&id, &(start, end))) in index_for_export.iter().enumerate() {
                ids_arr.set_index(i as u32, id);
                starts_arr.set_index(i as u32, start as u32);
                lengths_arr.set_index(i as u32, (end - start) as u32);
            }
            let index_event = js_sys::Object::new();
            crate::api::set_js_prop(&index_event, "type", &"entity-index".into());
            crate::api::set_js_prop(&index_event, "ids", &ids_arr);
            crate::api::set_js_prop(&index_event, "starts", &starts_arr);
            crate::api::set_js_prop(&index_event, "lengths", &lengths_arr);
            on_event.call1(&JsValue::NULL, &index_event.into())?;
        }

        // (B) Styles + voids — workers also gate on this. Resolve once (the same
        // shared resolver the native pipeline and buildPrePassOnce run) and emit.
        // `decoder` stays in scope below for the orphan type-geometry pass.
        // MaterialLayerIndex::from_content is deliberately skipped (its own full
        // scan); aggregate void propagation IS included via the stashed
        // IfcRelAggregates spans, keeping void-parity with the server.
        let mut decoder = EntityDecoder::with_arc_index(content, entity_index_arc.clone());
        decoder.seed_unit_scales(1.0, plane_angle_to_radians);
        let resolved = ifc_lite_processing::prepass::resolve_prepass(
            &prepass_spans,
            &mut decoder,
            ifc_lite_processing::prepass::ResolveOptions {
                collect_indexed_colour_full: false,
                defer_attached_styles: false,
            },
        );
        let (style_ids_vec, style_colors_vec) =
            ifc_lite_processing::prepass::flat_styles_rgba8(&resolved, &mut decoder);
        let (void_keys_vec, void_counts_vec, void_values_vec) =
            ifc_lite_processing::prepass::flat_voids(&resolved.void_index);
        let (mat_ids_vec, mat_counts_vec, mat_colors_vec) =
            ifc_lite_processing::prepass::flat_material_colors(
                &resolved.element_material_colors,
            );
        let styles_event = js_sys::Object::new();
        crate::api::set_js_prop(&styles_event, "type", &"styles".into());
        crate::api::set_js_prop(
            &styles_event,
            "styleIds",
            &js_sys::Uint32Array::from(style_ids_vec.as_slice()),
        );
        crate::api::set_js_prop(
            &styles_event,
            "styleColors",
            &js_sys::Uint8Array::from(style_colors_vec.as_slice()),
        );
        crate::api::set_js_prop(
            &styles_event,
            "voidKeys",
            &js_sys::Uint32Array::from(void_keys_vec.as_slice()),
        );
        crate::api::set_js_prop(
            &styles_event,
            "voidCounts",
            &js_sys::Uint32Array::from(void_counts_vec.as_slice()),
        );
        crate::api::set_js_prop(
            &styles_event,
            "voidValues",
            &js_sys::Uint32Array::from(void_values_vec.as_slice()),
        );
        crate::api::set_js_prop(
            &styles_event,
            "materialElementIds",
            &js_sys::Uint32Array::from(mat_ids_vec.as_slice()),
        );
        crate::api::set_js_prop(
            &styles_event,
            "materialColorCounts",
            &js_sys::Uint32Array::from(mat_counts_vec.as_slice()),
        );
        crate::api::set_js_prop(
            &styles_event,
            "materialColors",
            &js_sys::Uint8Array::from(mat_colors_vec.as_slice()),
        );
        on_event.call1(&JsValue::NULL, &styles_event.into())?;

        // (C) First wave — a small chunk routed by element id (no affinity hash)
        // so workers get a quick, cheap first batch the instant the gate opens.
        // Small enough to mesh in a fraction of a second across the pool; the
        // dedup it forgoes on these few elements is negligible.
        const FIRST_WAVE_JOBS: usize = 1024;
        let first_n = buffered_jobs.len().min(FIRST_WAVE_JOBS);
        if first_n > 0 {
            let first_aff: Vec<u32> =
                buffered_jobs[..first_n].iter().map(|&(id, ..)| id).collect();
            emit_jobs_chunk(on_event, &buffered_jobs[..first_n], &first_aff)?;
        }

        // (D) Affinity-route the REST + stream the bulk. The host routes all jobs
        // of a key to ONE worker so each unique geometry is meshed once per model;
        // the per-worker dedup cache turns the rest into cheap hits. On decode
        // failure the key falls back to the element id (its own bucket).
        {
            let mut akey_decoder =
                EntityDecoder::with_arc_index(content, entity_index_arc.clone());
            let akey_router = GeometryRouter::new();
            let rest = &buffered_jobs[first_n..];
            let mut affinity: Vec<u32> = Vec::with_capacity(rest.len());
            for &(id, _s, _e, _t) in rest {
                let key = match akey_decoder.decode_by_id(id) {
                    Ok(ent) => akey_router
                        .geometry_routing_key(&ent, &mut akey_decoder)
                        .map(fold_u128_to_u32)
                        .unwrap_or(id),
                    Err(_) => id,
                };
                affinity.push(key);
            }
            for (jobs_chunk, aff_chunk) in
                rest.chunks(chunk_size).zip(affinity.chunks(chunk_size))
            {
                emit_jobs_chunk(on_event, jobs_chunk, aff_chunk)?;
            }
        }
        buffered_jobs.clear();

        // (Style + void resolution and the entity-index export now run ABOVE,
        // before the affinity bulk, so workers receive them as early as possible —
        // see the FAST FIRST GEOMETRY block. `decoder` from there stays in scope
        // for the orphan type-geometry pass below.)

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
            let type_jobs = crate::api::styling::collect_type_geometry_jobs(content, &mut decoder);
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
        crate::api::set_js_prop(&done, "type", &"complete".into());
        crate::api::set_js_prop(&done, "totalJobs", &(total_jobs as f64).into());
        on_event.call1(&JsValue::NULL, &done.into())?;

        Ok(JsValue::UNDEFINED)
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
