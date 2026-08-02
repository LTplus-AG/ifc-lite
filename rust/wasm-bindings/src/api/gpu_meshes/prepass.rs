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
        use crate::api::styling::combined_pre_pass;
        use ifc_lite_core::EntityDecoder;
        use ifc_lite_processing::stream_meta::{resolve_stream_meta, MetaMode};

        // Load START on the serial/main-thread path: the previous load's
        // pipeline diagnostics must not accumulate into this one. (The worker
        // path resets via setEntityIndex; every load-start entry point resets.)
        self.reset_pipeline_diagnostics();

        let content = data;

        // Build entity index — a compact columnar index (sorted u32 columns +
        // binary search, #1682) wrapped in Arc for cheap reuse.
        let entity_index = std::sync::Arc::new(ifc_lite_core::ColumnarEntityIndex::from_scan(content));
        // Cache for reuse by processGeometryBatch.
        // Mutex held only briefly to install the Arc; rayon helpers
        // pick up clones below without re-locking. Panic on poison —
        // an earlier panic with the lock held would mean the cached
        // index is in an inconsistent state.
        let mut slot = self
            .cached_entity_index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = Some(entity_index.clone());
        drop(slot);
        let mut decoder = EntityDecoder::with_arc_columnar_index(content, entity_index);

        // Run combined pre-pass
        let pre_pass = combined_pre_pass(content, &mut decoder);

        // Resolve the load-time meta (unit scales + RTC offset + needs-shift +
        // building rotation) via the shared resolver. This decoder already sees
        // the FULL entity index, so the single-stage `SmallFileSingle` ladder is
        // correct. It also seeds the decoder so nothing downstream re-pays the
        // IFCPROJECT hunt.
        let rtc_jobs: Vec<_> = pre_pass
            .simple_jobs
            .iter()
            .take(25)
            .chain(pre_pass.complex_jobs.iter().take(25))
            .copied()
            .collect();
        let meta = resolve_stream_meta(
            MetaMode::SmallFileSingle,
            content,
            pre_pass.project_id,
            pre_pass.site_position,
            &rtc_jobs,
            &mut decoder,
        );

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
        // unitScale / planeAngleToRadians / rtcOffset / needsShift / buildingRotation
        // from the shared resolver.
        super::prepass_sharded::set_stream_meta_props(&result, &meta);

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
        self.pre_pass_streaming_impl(
            data,
            on_event,
            chunk_size,
            disabled_type_names,
            skip_type_geometry,
            None,
            false,
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn pre_pass_streaming_impl(
        &self,
        data: &[u8],
        on_event: &Function,
        chunk_size: u32,
        disabled_type_names: Option<Vec<String>>,
        skip_type_geometry: bool,
        prebuilt: Option<ifc_lite_core::ColumnarEntityIndex>,
        external_styles: bool,
        columns: Option<super::prepass_discovery::IndexColumns<'_>>,
    ) -> Result<JsValue, JsValue> {
        let prebuilt_arc: Option<std::sync::Arc<ifc_lite_core::ColumnarEntityIndex>> =
            prebuilt.map(std::sync::Arc::new);
        // Load START on the streaming pre-pass path (see build_pre_pass_once).
        self.reset_pipeline_diagnostics();
        use ifc_lite_core::{has_geometry_by_name, EntityDecoder, EntityScanner, IfcType};
        use ifc_lite_geometry::GeometryRouter;
        use ifc_lite_processing::stream_meta::{resolve_stream_meta, MetaMode};

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
        // Cap the up-front index reservation. On wasm32 the whole `content` slice
        // is already resident in the 4GB linear memory (wasm-bindgen copies the
        // buffer in), so reserving `len/50` slots — ~82M entries (~1GB) for a
        // ~4GB file — ON TOP of that exhausts the address space before the scan
        // even starts, aborting with a bare `unreachable executed`. Reserve at
        // most CAP entries; a rarer huge model grows the map via rehash (a
        // one-time cost) instead of a fatal up-front OOM. Ordinary (<2GB) files
        // are unaffected — their `len/50` estimate stays under the cap.
        const PREPASS_INDEX_RESERVE_CAP: usize = 40_000_000; // ~0.5GB reserved
        let estimated = (content.len() / 50).min(PREPASS_INDEX_RESERVE_CAP);
        let mut entity_index: rustc_hash::FxHashMap<u32, (usize, usize)> =
            rustc_hash::FxHashMap::with_capacity_and_hasher(estimated, Default::default());

        let mut buffered_jobs: Vec<(u32, usize, usize, IfcType)> = Vec::with_capacity(chunk_size);
        let mut total_jobs: u32 = 0;
        let mut project_id: Option<u32> = None;
        let mut site_position: Option<(u32, usize, usize)> = None;
        let mut meta_emitted = false;

        // #957 / #563 single-scan hoist: the workers each re-walk the whole file
        // on their first batch to rebuild these three per-content structures
        // (referenced RepresentationMaps, instantiated type ids, the material-
        // layer index). Collect the spans they need HERE, during the one scan the
        // pre-pass already runs, then build + ship each ONCE below so every
        // worker skips its own full-file walk. `rel_associates_material` spans are
        // already stashed in `prepass_spans`.
        let mut mapped_item_spans: Vec<(u32, usize, usize)> = Vec::new();
        let mut rel_defines_by_type_spans: Vec<(u32, usize, usize)> = Vec::new();
        // #957/#962: IfcTypeProduct candidates (id, span, resolved type), stashed
        // here so the orphan-type-geometry pass reuses THIS scan instead of a
        // second full EntityScanner walk over the file. `IfcType` is captured
        // from the scanner's `type_name` so it matches `collect_type_geometry_jobs`
        // byte-for-byte.
        let mut type_candidate_spans: Vec<(u32, usize, usize, IfcType)> = Vec::new();
        // Mirror `get_or_build_material_layer_index`'s `IFCMATERIALLAYERSET`
        // substring gate exactly, but detect it from the scan (a layer-set
        // keyword only appears as an entity type) so we never re-scan the file:
        // an `IfcMaterialLayerSet`/`...Usage` entity is present iff the gate fires.
        let mut has_layer_set = false;
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

        // STAGE 2: fill collectors from the class columns; no byte scan.
        if let Some((cids, cstarts, clengths, cclasses)) = columns {
            let d = super::prepass_discovery::discover_from_columns(
                content, cids, cstarts, clengths, cclasses, &disabled_types,
            );
            buffered_jobs = d.buffered_jobs;
            total_jobs = d.total_jobs;
            project_id = d.project_id;
            site_position = d.site_position;
            prepass_spans = d.prepass_spans;
            prepass_spans.styled_items = Vec::new(); // shards resolve styles
            mapped_item_spans = d.mapped_item_spans;
            rel_defines_by_type_spans = d.rel_defines_by_type_spans;
            type_candidate_spans = d.type_candidate_spans;
            has_layer_set = d.has_layer_set;
        } else {
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            if prebuilt_arc.is_none() {
                entity_index.insert(id, (start, end)); // prebuilt mode: map unused
            }

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
                "IFCMAPPEDITEM" => {
                    mapped_item_spans.push((id, start, end));
                }
                "IFCRELDEFINESBYTYPE" => {
                    rel_defines_by_type_spans.push((id, start, end));
                }
                "IFCMATERIALLAYERSET" | "IFCMATERIALLAYERSETUSAGE" => {
                    has_layer_set = true;
                }
                _ => {
                    // #957/#962: an IfcTypeProduct subtype (its geometry is
                    // authored on RepresentationMaps, not the type itself, so it
                    // never matches `has_geometry_by_name`). Stash it for the
                    // orphan-type pass; the RepresentationMaps attr-6 decode +
                    // referenced-filter happens later in
                    // `collect_type_geometry_jobs_from_spans`.
                    if type_name.ends_with("TYPE") || type_name.ends_with("STYLE") {
                        let type_ty = IfcType::from_str(type_name);
                        if type_ty.is_subtype_of(IfcType::IfcTypeProduct) {
                            type_candidate_spans.push((id, start, end, type_ty));
                        }
                    }
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
                // MID-SCAN meta emission — the streaming win (~17 s → ~3 s
                // time-to-first-geometry on a 986 MB file). The RESOLUTION logic
                // (3-stage RTC ladder: partial-index detect → full-index
                // re-detect when the partial index resolved no placement chain →
                // placement-bounds last resort) lives in the shared
                // `resolve_stream_meta` so it cannot drift from the tail /
                // `buildPrePassOnce` paths. Emission STAYS HERE, unchanged: the
                // meta event is dispatched the moment RTC_SAMPLE_THRESHOLD jobs
                // are buffered, near the top of the file, so workers spin up
                // early. Do NOT move this to a post-scan point — that regresses
                // every large file.
                // PREBUILT index (sharded): full index available, so run the
                // single-stage full-index ladder (what the partial ladder
                // escalates to anyway) — no mid-scan full-rescan detour.
                let meta_res = if let Some(pi) = &prebuilt_arc {
                    let mut decoder =
                        EntityDecoder::with_arc_columnar_index(content, pi.clone());
                    resolve_stream_meta(
                        MetaMode::SmallFileSingle,
                        content,
                        project_id,
                        site_position,
                        &buffered_jobs,
                        &mut decoder,
                    )
                } else {
                    let mut decoder = EntityDecoder::with_index(content, entity_index.clone());
                    resolve_stream_meta(
                        MetaMode::StreamingPartial,
                        content,
                        project_id,
                        site_position,
                        &buffered_jobs,
                        &mut decoder,
                    )
                };
                plane_angle_to_radians = meta_res.plane_angle_to_radians;

                // Emit meta event.
                let meta = js_sys::Object::new();
                crate::api::set_js_prop(&meta, "type", &"meta".into());
                super::prepass_sharded::set_stream_meta_props(&meta, &meta_res);
                on_event.call1(&JsValue::NULL, &meta.into())?;
                meta_emitted = true;
                // Jobs stay buffered through the scan; the post-scan pass
                // emits them with exact geometry-hash affinity keys (workers
                // gate on post-scan events anyway, so deferring is free).
                continue;
            }
        }

        }

        // Tail meta: small files (scan path) + every columns-path file.
        if !meta_emitted {
            // Build a decoder lazily for unit/RTC/site lookups. With a
            // sub-50-job file the scan is essentially instant anyway, so the
            // full entity index is already complete here — the single-stage
            // `SmallFileSingle` ladder (one detect_rtc_offset_with_fallback) is
            // correct, sharing its resolution with `buildPrePassOnce`.
            let meta_jobs = &buffered_jobs[..buffered_jobs.len().min(RTC_SAMPLE_THRESHOLD)];
            let meta_res = if let Some(pi) = &prebuilt_arc {
                let mut decoder = EntityDecoder::with_arc_columnar_index(content, pi.clone());
                resolve_stream_meta(
                    MetaMode::SmallFileSingle,
                    content,
                    project_id,
                    site_position,
                    meta_jobs,
                    &mut decoder,
                )
            } else {
                let mut decoder = EntityDecoder::with_index(content, entity_index.clone());
                resolve_stream_meta(
                    MetaMode::SmallFileSingle,
                    content,
                    project_id,
                    site_position,
                    &buffered_jobs,
                    &mut decoder,
                )
            };
            plane_angle_to_radians = meta_res.plane_angle_to_radians;

            let meta = js_sys::Object::new();
            crate::api::set_js_prop(&meta, "type", &"meta".into());
            super::prepass_sharded::set_stream_meta_props(&meta, &meta_res);
            on_event.call1(&JsValue::NULL, &meta.into())?;
        }

        // Cache for processGeometryBatch reuse. Convert the scan's FxHashMap
        // into a compact columnar index (sorted u32 columns + binary search):
        // ~229 MB vs the hashmap's ~436 MB on a 19.1 M-entity model (#1682).
        // Consuming frees the map before sorting: one interleaved transient.
        let entity_index_arc = match prebuilt_arc {
            Some(pi) => pi,
            None => std::sync::Arc::new(ifc_lite_core::ColumnarEntityIndex::from_hashmap_consuming(
                entity_index,
            )),
        };
        let have_prebuilt = external_styles; // sharded mode always passes both

        // Mutex held only briefly to install the Arc.
        {
            let mut slot = self
                .cached_entity_index
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            *slot = Some(entity_index_arc.clone());
        }
        // Hold a second clone for the post-scan entity-index export below;
        // `with_arc_columnar_index` consumes the Arc so we'd lose the
        // reference after the decoder is created.
        let index_for_export = entity_index_arc.clone();

        // ── FAST FIRST GEOMETRY ──
        // Workers gate on entity-index + styles + the first jobs chunk; all
        // three ship right here post-scan (a SMALL id-routed first wave, then
        // the affinity pass over the REST — dedup distribution stays intact).

        // (A) Entity-index — workers re-scan the whole file (~5 s) without it.
        // Sharded mode skips this: the host delivered the stitched index first.
        if !have_prebuilt {
            // Bulk-copy in 3 boundary crossings, not ~8.4M per-entry set_index
            // calls (workers' critical path). Columns are already sorted by id,
            // so consumers hit ColumnarEntityIndex::from_columns' O(n)
            // already-sorted fast path (no per-worker argsort).
            let ids_arr = js_sys::Uint32Array::from(index_for_export.ids());
            let starts_arr = js_sys::Uint32Array::from(index_for_export.starts());
            let lengths_arr = js_sys::Uint32Array::from(index_for_export.lengths());
            let index_event = js_sys::Object::new();
            crate::api::set_js_prop(&index_event, "type", &"entity-index".into());
            crate::api::set_js_prop(&index_event, "ids", &ids_arr);
            crate::api::set_js_prop(&index_event, "starts", &starts_arr);
            crate::api::set_js_prop(&index_event, "lengths", &lengths_arr);
            on_event.call1(&JsValue::NULL, &index_event.into())?;
        }

        // (B) Styles + voids — workers also gate on this. Serial mode resolves
        // + emits here (shared resolver; MaterialLayerIndex::from_content is
        // deliberately skipped, aggregate void propagation included); sharded
        // (external_styles) mode leaves styles to the worker shards + finalize.
        // `decoder` stays in scope below for the orphan type-geometry pass.
        let mut decoder = EntityDecoder::with_arc_columnar_index(content, entity_index_arc.clone());
        decoder.seed_unit_scales(1.0, plane_angle_to_radians);
        if !external_styles {
            let resolved = ifc_lite_processing::prepass::resolve_prepass(
                &prepass_spans,
                &mut decoder,
                ifc_lite_processing::prepass::ResolveOptions {
                    collect_indexed_colour_full: false,
                    defer_attached_styles: false,
                },
            );
            let styles_event = super::prepass_sharded::styles_payload(&resolved, &mut decoder);
            crate::api::set_js_prop(&styles_event, "type", &"styles".into());
            on_event.call1(&JsValue::NULL, &styles_event.into())?;
        }

        // (B2) Pre-pass columns — the three per-content structures each geometry
        // worker would otherwise rebuild with its OWN full-file walk on its first
        // batch (issue #957 orphan/instanced type geometry + #563 material-layer
        // slicing). Built ONCE here from spans this scan already collected, then
        // installed on every worker via `set{ReferencedRepmaps,InstantiatedTypeIds,
        // MaterialLayerIndex}`. Emitted BEFORE the first jobs chunk (below) and
        // workers apply messages FIFO, so the injected data is always in place
        // before any `processGeometryBatch` — the lazy per-worker build (the
        // byte-identical fallback) never fires on the streaming path.
        let referenced_repmaps =
            crate::api::styling::build_referenced_representation_maps_from_spans(
                &mapped_item_spans,
                &mut decoder,
            );
        let instantiated_type_ids =
            crate::api::styling::build_instantiated_type_ids_from_spans(
                &rel_defines_by_type_spans,
                &mut decoder,
            );
        // #1623 Phase 3 don't-bake plan: the RepresentationMap ids an IfcMappedItem
        // instantiates >= 2 times, tallied from the SAME spans (no extra scan). The
        // batch path arms its router with these so a repeated single-solid mapped
        // source materializes once per batch and the rest ride as shard instances.
        let mapped_instance_plan =
            crate::api::styling::build_mapped_instance_plan_from_spans(
                &mapped_item_spans,
                &mut decoder,
            );
        // Gate on `has_layer_set` to stay bit-identical to
        // `get_or_build_material_layer_index`, which ships an EMPTY index when the
        // file authors no layer set (its substring bail-out). from_spans reuses
        // the already-stashed IfcRelAssociatesMaterial spans — no extra walk.
        let material_layer_flat = if has_layer_set {
            ifc_lite_geometry::MaterialLayerIndex::from_spans(
                &prepass_spans.rel_associates_material,
                &mut decoder,
            )
            .to_flat()
        } else {
            ifc_lite_geometry::MaterialLayerFlat::default()
        };

        let repmaps_arr: Vec<u32> = referenced_repmaps.into_iter().collect();
        let type_ids_arr: Vec<u32> = instantiated_type_ids.into_iter().collect();
        let columns_event = js_sys::Object::new();
        crate::api::set_js_prop(&columns_event, "type", &"prepass-columns".into());
        crate::api::set_js_prop(
            &columns_event,
            "referencedRepmaps",
            &js_sys::Uint32Array::from(repmaps_arr.as_slice()),
        );
        crate::api::set_js_prop(
            &columns_event,
            "instantiatedTypeIds",
            &js_sys::Uint32Array::from(type_ids_arr.as_slice()),
        );
        crate::api::set_js_prop(
            &columns_event,
            "mappedInstancePlan",
            &js_sys::Uint32Array::from(mapped_instance_plan.as_slice()),
        );
        crate::api::set_js_prop(
            &columns_event,
            "mliElementIds",
            &js_sys::Uint32Array::from(material_layer_flat.element_ids.as_slice()),
        );
        crate::api::set_js_prop(
            &columns_event,
            "mliAxis",
            &js_sys::Uint32Array::from(material_layer_flat.axis.as_slice()),
        );
        crate::api::set_js_prop(
            &columns_event,
            "mliLayerCounts",
            &js_sys::Uint32Array::from(material_layer_flat.layer_counts.as_slice()),
        );
        crate::api::set_js_prop(
            &columns_event,
            "mliDirectionSense",
            &js_sys::Float64Array::from(&material_layer_flat.direction_sense[..]),
        );
        crate::api::set_js_prop(
            &columns_event,
            "mliOffset",
            &js_sys::Float64Array::from(&material_layer_flat.offset[..]),
        );
        crate::api::set_js_prop(
            &columns_event,
            "mliLayerMaterialIds",
            &js_sys::Uint32Array::from(material_layer_flat.layer_material_ids.as_slice()),
        );
        crate::api::set_js_prop(
            &columns_event,
            "mliLayerThicknesses",
            &js_sys::Float64Array::from(&material_layer_flat.layer_thicknesses[..]),
        );
        on_event.call1(&JsValue::NULL, &columns_event.into())?;

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
                EntityDecoder::with_arc_columnar_index(content, entity_index_arc.clone());
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
        // #962 done: the mapped-item source + type-candidate spans were collected
        // by the streaming scan above, so this resolves orphans from those stashes
        // with NO second EntityScanner pass. The gate is the SAME predicate the old
        // `collect_type_geometry_jobs` bailed on — an `IFCREPRESENTATIONMAP`
        // substring (a SIMD memmem, not a full scan) — so behaviour stays byte-
        // identical to the old path and `combined_pre_pass`, free on the no-type case.
        // #1097 perf: the viewer's default Model view does not render the
        // type-library (#957) geometry, so skip producing it at load when the
        // caller asks (the Types view re-loads on demand).
        if !skip_type_geometry
            && memchr::memmem::find(content, b"IFCREPRESENTATIONMAP").is_some()
        {
            let type_jobs = crate::api::styling::collect_type_geometry_jobs_from_spans(
                &mapped_item_spans,
                &type_candidate_spans,
                &mut decoder,
            );
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
