// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::batch_partition::{
    encode_shard_routing_refusals_back, is_instancing_candidate, meets_instance_threshold,
    take_back_rejected, tallyable_rep, INSTANCE_MIN_OCCURRENCES,
};
use super::partitioned_batch::PartitionedBatch;
use super::style_finishes::{finish_at, mesh_js_with_finish, BatchFinishes};
use ifc_lite_processing::prepass::finish_to_wire;
use crate::api::IfcAPI;
use crate::zero_copy::{GeometryFingerprint, MeshCollection};
use wasm_bindgen::prelude::*;
/// Per-element output of [`IfcAPI::produce_batch`] — the canonical producer's
/// meshes (with `instance` metadata intact, BEFORE the MeshDataJs Z-up→Y-up
/// swap) plus everything the element's geometry-hash pass measured. The flat
/// path converts each to MeshDataJs; the instanced path collates them into an
/// IFNS shard.
struct ElementMeshOutput {
    id: u32,
    meshes: Vec<ifc_lite_processing::MeshData>,
    /// #5984: `meshes[i]`'s finish at `[i]`; empty when none are installed.
    finishes: Vec<Option<ifc_lite_processing::style::SpecularMaterial>>,
    geometry_hash: Option<u64>,
    /// World AABB from the same hashing pass, `Some` exactly when
    /// `geometry_hash` is (see `ProducedElementMeshes::geometry_aabb`).
    geometry_aabb: Option<[f64; 6]>,
    /// Enclosed volume in m³, `Some` only for a provably closed single solid
    /// (see `ProducedElementMeshes::geometry_volume`). `None` is normal.
    geometry_volume: Option<f64>,
    /// Packed closure verdict; `0` when nothing was hashed.
    geometry_closure_bits: u8,
}
impl ElementMeshOutput {
    /// The element's diff-engine record, or `None` when hashing was off / it
    /// produced nothing. Built in ONE place so the two push sites (flat and
    /// partitioned) cannot drift into filling different subsets of the
    /// index-parallel arrays.
    fn fingerprint(&self) -> Option<GeometryFingerprint> {
        Some(GeometryFingerprint {
            express_id: self.id,
            hash: self.geometry_hash?,
            aabb: self.geometry_aabb,
            volume: self.geometry_volume,
            closure_bits: self.geometry_closure_bits,
        })
    }
}
impl IfcAPI {
    /// Shared core for both batch outputs: run the canonical per-element
    /// producer over `jobs_flat` (setup + loop + CSG/layer diagnostics),
    /// returning each element's meshes (instance metadata intact) + geometry
    /// hash. `process_geometry_batch` (→ MeshCollection, flat) and
    /// `process_geometry_batch_instanced` (→ IFNS shard) both call this so the
    /// hot path is written once. The web path stays serial (no rayon in wasm);
    /// the entity-index Arc, warm router, and per-worker style/void/material
    /// caches are reused exactly as before.
    #[allow(clippy::too_many_arguments)]
    fn produce_batch(
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
        // #1623 Phase 3: when `true` AND a mapped-instance plan is installed AND the
        // model is unshifted AND geometry hashing is off, arm the batch router in
        // BATCH-LOCAL don't-bake mode so a repeated single-solid mapped source
        // materializes once per batch and the rest ride the IFNS shard. Only the
        // partitioned entry point (which holds a flat MeshCollection for the
        // sub-threshold recovery) passes `true`; the flat / instanced-only entry
        // points pass `false`, keeping their output byte-identical.
        arm_instancing: bool,
    ) -> (
        Vec<ElementMeshOutput>,
        ifc_lite_geometry::GeometryDiagnostics,
        Vec<super::instancing::ShardOccurrence>,
    ) {
        use crate::api::styling::resolve_element_color;
        use ifc_lite_processing::element::{
            produce_element_meshes_owned, ElementJobKind, ElementMeshJob,
        };
        // Batch wall-clock for the PipelineDiagnostics channel. std::time::Instant
        // traps on wasm32, so the host clock is the JS one there (two Date.now()
        // reads per batch — negligible, always on); see `batch_host`.
        let batch_clock = super::batch_host::BatchClock::start();
        let content = data;
        let wire = super::batch_wire::BatchWire {
            jobs_flat, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, void_keys, void_counts, void_values, style_ids, style_colors, plane_angle_to_radians, material_element_ids, material_color_counts, material_colors_rgba,
        };
        let super::batch_prepare::BatchSetup {
            mut decoder, router, ctx, opts, style_maps, parts_to_skip, mapped_item_cache,
        } = self.prepare_batch(content, &wire, arm_instancing);
        let geometry_styles = &style_maps.0;
        let installed_finishes = self.style_finishes_for(style_ids);
        let mut batch_finishes = BatchFinishes::new(installed_finishes.as_deref(), geometry_styles);
        let mut outputs = Vec::with_capacity(jobs_flat.len() / 3);
        // CSG diagnostics, aggregated across the batch: the canonical producer
        // drains the (warm, batch-shared) router per element so one element's
        // failures never bleed into the next; we collect them here and hand
        // them to the logger below.
        let mut batch_csg_failures: rustc_hash::FxHashMap<
            u32,
            Vec<ifc_lite_geometry::BoolFailure>,
        > = rustc_hash::FxHashMap::default();

        // PipelineDiagnostics tallies for this batch (elements actually run
        // through the producer, degenerate-backstop drops, refused products).
        let mut batch_elements: u64 = 0;
        let (mut batch_backstop, mut batch_refused): (u64, u64) = (0, 0);

        // #1623 Phase 3: don't-bake occurrences collected across the batch's
        // elements (empty when the router is unarmed). Resolved after the loop into
        // shard instances (kept) + recovered flat meshes (sub-threshold).
        let mut all_occurrences: Vec<ifc_lite_processing::RawInstanceOccurrence> = Vec::new();

        // Process only the entities specified in jobs_flat — every job runs
        // THE canonical per-element producer (`ifc_lite_processing::element`),
        // the same code the native pipeline runs.
        self.collect_pipeline_refusals(&decoder);
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
            let span = ifc_lite_processing::execution::JobSpan { id, start, end };
            let Ok(entity) = ifc_lite_processing::execution::decode_job(
                &mut decoder, span, ifc_lite_processing::execution::SchedulerPolicy::PerBatch,
            ) else {
                self.record_input_refusals(&decoder, false);
                continue;
            };
            // Schema-resolved, like the native pre-pass at
            // `processing/src/processor/mod.rs:711`. Supported keywords retain
            // their exact generated variants; raw-record fallback preserves an
            // owned unknown keyword where decoding could not retain it (#3179,
            // #4203).
            //
            // Not every dropped keyword reaches this line: the four arms with
            // `has_geometry: false` are refused by `has_geometry_by_name` in
            // all three element producers, so this fix misses them. #3187 has
            // the trace, including the type-geometry gate that would make
            // THREE of the four eligible -- eligible, not certain.
            //
            // Recomputed from the SOURCE KEYWORD rather than recovered from
            // `entity.ifc_type` -- why it cannot be recovered is on
            // `ifc_type_from_record` itself. What is specific to
            // HERE: the bytes are already in hand -- `content[start..end]` is
            // the span THIS JOB carries, so this is a ~20-byte scan to the
            // first `(`, not a re-read. Note it is the job's span, not
            // necessarily what `decode_and_cache` parsed: on a cache hit
            // (`core/src/decoder.rs:443`) it returns the cached `Arc` without
            // reading `start`/`end` at all, so only the miss path bounds-checks
            // them. `content.get(..)` is fail-soft for that reason -- an
            // out-of-range span yields an empty slice and `decoded` is returned
            // unchanged.
            //
            // Cheaper than widening the jobs wire, which is 3 u32 per job
            // across Rust and TS and would have paid marshalling cost on every
            // job to fix the few that are legacy.
            let ifc_type = ifc_lite_processing::execution::job_type(&entity, content, span, None);

            // Resolve the element-level colour inline (folded from the deleted
            // pre-pass) so the entity is decoded exactly once.
            let element_color = if !geometry_styles.is_empty()
                && entity.get(6).map(|a| !a.is_null()).unwrap_or(false)
            {
                resolve_element_color(&entity, geometry_styles, &mut decoder)
            } else {
                None
            };

            // #957: type products render their planned RepresentationMaps. The
            // viewer emits BOTH orphan (class 1) and instanced (class 2) maps —
            // `EmitTagged` — so the Model/Types switch can filter at render
            // time; the native pipeline plans the same jobs with
            // `SuppressInstanced` (an export must not duplicate geometry).
            let kind = if ifc_type.is_subtype_of(ifc_lite_core::IfcType::IfcTypeProduct) {
                let rep_map_ids = ifc_lite_processing::discovery::record_refs_at(
                    content.get(start..end).unwrap_or_default(),
                    ifc_lite_core::slot::IfcTypeProduct::REPRESENTATION_MAPS.index(),
                );
                if rep_map_ids.is_empty() {
                    self.record_input_refusals(&decoder, router.length_unit_refused());
                    continue;
                }
                let type_plan = self.get_or_build_type_geometry_plan(content, &mut decoder);
                let rep_maps = type_plan.maps_for(id, &rep_map_ids);
                if rep_maps.is_empty() {
                    self.record_input_refusals(&decoder, router.length_unit_refused());
                    continue;
                }
                ElementJobKind::TypeProduct { rep_maps }
            } else {
                ElementJobKind::Product
            };

            #[cfg(test)]
            parity::record_job(id, &kind);
            let produced = produce_element_meshes_owned(
                &ElementMeshJob {
                    id,
                    ifc_type,
                    entity: &entity,
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
            let Ok(produced) = produced else {
                self.record_input_refusals(&decoder, router.length_unit_refused());
                batch_refused += 1;
                continue;
            };

            for (product_id, fails) in produced.csg_failures {
                batch_csg_failures.entry(product_id).or_default().extend(fails);
            }
            batch_elements += 1;
            batch_backstop += produced.degenerate_triangles_dropped;
            if !produced.instance_occurrences.is_empty() {
                all_occurrences.extend(produced.instance_occurrences);
            }
            outputs.push(ElementMeshOutput {
                id,
                finishes: batch_finishes.for_meshes(&produced.meshes, &mut decoder),
                meshes: produced.meshes,
                geometry_hash: produced.geometry_hash,
                geometry_aabb: produced.geometry_aabb,
                geometry_volume: produced.geometry_volume,
                geometry_closure_bits: produced
                    .geometry_closure
                    .map_or(0, |c| c.bits()),
            });
            // Finish resolution can re-decode refused items too. Drain the whole
            // element scope only after the join, before the next job starts.
            self.record_input_refusals(&decoder, router.length_unit_refused());
        }

        // Surface refused products and the opening / CSG diagnostics. The
        // viewer's large-file path goes processAdaptive -> processParallel ->
        // Web Workers -> `processGeometryBatch`, so the logs must fire here.
        crate::api::warn_refused_products(batch_refused);
        let csg_diag = crate::api::drain_and_log_csg_diagnostics(&router, batch_csg_failures);

        // Layered-wall slicing diagnostics (#563), from this batch's one drain.
        super::batch_host::log_layers(&router.take_layer_slice_diag());


        // #1623 Phase 3: resolve the batch's don't-bake occurrences into shard
        // instances (kept) + recovered flat meshes (sub-threshold / ineligible
        // template). Build the per-rep template facts from the retained instanceable
        // meshes (batch-local mode materialized one template per source), then split.
        // Empty (unarmed / no occurrences) ⇒ nothing changes, byte-identical output.
        let shard_occurrences = if all_occurrences.is_empty() {
            Vec::new()
        } else {
            let mut template_by_rep: rustc_hash::FxHashMap<u128, super::instancing::TemplateInfo> =
                rustc_hash::FxHashMap::default();
            for out in &outputs {
                for m in &out.meshes {
                    if m.positions.is_empty() {
                        continue;
                    }
                    if let Some(im) = m.instance.as_ref() {
                        if im.instanceable {
                            // Shard-eligible = the partition's candidate gate: opaque,
                            // untextured, ordinary-occurrence (class 0) geometry. The
                            // SAME function the partition calls, so the two cannot drift.
                            let eligible = is_instancing_candidate(m);
                            template_by_rep
                                .entry(im.rep_identity)
                                .or_insert(super::instancing::TemplateInfo { eligible });
                        }
                    }
                }
            }
            let rtc = if needs_shift {
                [rtc_x, rtc_y, rtc_z]
            } else {
                [0.0, 0.0, 0.0]
            };
            let mut recovered_flats: Vec<ifc_lite_processing::MeshData> = Vec::new();
            let mut shard = super::instancing::resolve_batch_occurrences(
                std::mem::take(&mut all_occurrences),
                &template_by_rep,
                &mapped_item_cache,
                rtc,
                INSTANCE_MIN_OCCURRENCES as usize,
                &mut recovered_flats,
            );
            // Recovered occurrences ride as their own single-mesh outputs; the
            // partition routes them to the flat MeshCollection (instance meta is None
            // ⇒ never instanced), byte-identical to the flat baseline for that element.
            for m in recovered_flats {
                let id = m.express_id;
                outputs.push(ElementMeshOutput {
                    id,
                    finishes: batch_finishes.for_meshes(std::slice::from_ref(&m), &mut decoder),
                    meshes: vec![m],
                    geometry_hash: None,
                    geometry_aabb: None,
                    geometry_volume: None,
                    geometry_closure_bits: 0,
                });
            }
            for occ in &mut shard {
                occ.finish = batch_finishes.for_occurrence(occ.entity_id, occ.geometry_item_id, occ.color, &mut decoder);
            }
            shard
        };

        // Fold this batch into the per-worker PipelineDiagnostics accumulator
        // (read by JS via getPipelineDiagnostics). Counts + two Date.now()
        // reads — cheap enough to stay on the normal load path unconditionally.
        let batch_meshes: u64 = outputs.iter().map(|o| o.meshes.len() as u64).sum();
        let batch_triangles: u64 = outputs
            .iter()
            .flat_map(|o| o.meshes.iter())
            .map(|m| (m.indices.len() / 3) as u64)
            .sum();
        let batch_ms = batch_clock.elapsed_ms();
        // The batch reuses ONE decoder across every element (the point cache is
        // already hoisted here), so its cumulative point-cache stats ARE this
        // batch's faceted-brep memoization tally.
        let (point_cache_hits, point_cache_misses) = decoder.point_cache_stats();
        self.collect_pipeline_refusals(&decoder);
        self.record_pipeline_batch(
            batch_elements,
            batch_meshes,
            batch_triangles,
            batch_backstop,
            point_cache_hits,
            point_cache_misses,
            batch_ms,
            &csg_diag,
        );

        (outputs, csg_diag, shard_occurrences)
    }
}

#[wasm_bindgen]
impl IfcAPI {
    /// Process geometry for a subset of pre-scanned entities → flat
    /// MeshCollection. Takes raw bytes + pre-pass data from buildPrePassOnce.
    /// Thin wrapper over [`IfcAPI::produce_batch`]; converts each produced mesh
    /// to MeshDataJs (the IFC Z-up→WebGL Y-up rotation with preserved winding happens
    /// there). Flat indices preserve source order through this proper rotation.
    #[wasm_bindgen(js_name = processGeometryBatch)]
    #[allow(clippy::too_many_arguments)]
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
        style_ids: &[u32],
        style_colors: &[u8],
        plane_angle_to_radians: Option<f64>,
        material_element_ids: Option<Vec<u32>>,
        material_color_counts: Option<Vec<u32>>,
        material_colors_rgba: Option<Vec<u8>>,
    ) -> MeshCollection {
        let num_jobs = jobs_flat.len() / 3;
        // arm_instancing = false: the flat path has no IFNS shard to hold don't-bake
        // occurrences, so every occurrence must materialize (byte-identical output).
        let (outputs, csg_diag, _shard_occurrences) = self.produce_batch(
            data, jobs_flat, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, void_keys,
            void_counts, void_values, style_ids, style_colors, plane_angle_to_radians,
            material_element_ids, material_color_counts, material_colors_rgba, false,
        );
        let mut mesh_collection = MeshCollection::with_capacity(num_jobs);
        if needs_shift {
            mesh_collection.set_rtc_offset(rtc_x, rtc_y, rtc_z);
        }
        for out in outputs {
            // Taken BEFORE the meshes are moved out of `out` below.
            let fingerprint = out.fingerprint();
            for (i, mesh_data) in out.meshes.into_iter().enumerate() {
                mesh_collection.add(mesh_js_with_finish(mesh_data, finish_at(&out.finishes, i)));
            }
            if let Some(fp) = fingerprint {
                mesh_collection.push_geometry_hash(fp);
            }
        }
        mesh_collection.set_diagnostics(csg_diag);
        mesh_collection
    }

    /// Like [`IfcAPI::process_geometry_batch`] but collates the batch's meshes
    /// into a GPU-instancing shard (IFNS wire format) instead of a flat
    /// MeshCollection. Repeated geometry collapses to one template + per-
    /// occurrence transforms; non-instanceable meshes ride as flat singleton
    /// templates so nothing is dropped. The shard stays in the producer-native
    /// (IFC Z-up) frame — the renderer composes the constant Z-up→Y-up swap at
    /// upload. Each batch shard renders independently: affinity routing already
    /// co-locates identical geometry on one worker, so per-batch collation
    /// captures ~all the dedup and no cross-batch merge is needed. Returns empty
    /// bytes only when the batch produced zero non-empty meshes.
    #[wasm_bindgen(js_name = processGeometryBatchInstanced)]
    #[allow(clippy::too_many_arguments)]
    pub fn process_geometry_batch_instanced(
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
        style_ids: &[u32],
        style_colors: &[u8],
        plane_angle_to_radians: Option<f64>,
        material_element_ids: Option<Vec<u32>>,
        material_color_counts: Option<Vec<u32>>,
        material_colors_rgba: Option<Vec<u8>>,
    ) -> Vec<u8> {
        // NB: this instanced-only export returns raw shard bytes with no
        // MeshCollection carrier, so CSG diagnostics are intentionally dropped. It
        // is not the worker's default path (partitioned/flat carry the counts).
        // arm_instancing = false: with no flat carrier there is nowhere to route the
        // don't-bake sub-threshold recovery, so every occurrence materializes here
        // and this export stays byte-identical (it collates the baked meshes as
        // before). Only `process_geometry_batch_partitioned` arms the don't-bake path.
        let (outputs, _, _shard_occurrences) = self.produce_batch(
            data, jobs_flat, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, void_keys,
            void_counts, void_values, style_ids, style_colors, plane_angle_to_radians,
            material_element_ids, material_color_counts, material_colors_rgba, false,
        );
        let (meshes, wires): (Vec<ifc_lite_processing::MeshData>, Vec<[f32; 2]>) = outputs
            .into_iter()
            .flat_map(|o| {
                let finishes = o.finishes;
                o.meshes.into_iter().enumerate().map(move |(i, m)| (m, finish_to_wire(finish_at(&finishes, i))))
            })
            .filter(|(m, _)| m.geometry_class == 0)
            .unzip();
        // `refs` borrows the geometry in `meshes`; both live to the end of this
        // method and collate_and_encode consumes them synchronously below.
        //
        // ONLY ordinary occurrences (geometry_class == 0) are instanced. Type-
        // product geometry — orphan type maps (class 1) and instanced type maps
        // (class 2) — is left to the flat path, which the viewer's Model/Types
        // view-mode filter gates (ViewportContainer drops class 2 in Model mode,
        // class 0 in Types mode). The instanced path has no view-mode filter, so
        // including class 1/2 here would render type geometry unconditionally
        // (the opaque type-template shapes drawing over the real occurrences —
        // the "blue windows/roof" + type geometry showing in Model mode).
        let refs: Vec<ifc_lite_geometry::InstanceMeshRef> = meshes
            .iter()
            .map(|m| ifc_lite_geometry::InstanceMeshRef {
                positions: &m.positions,
                normals: &m.normals,
                indices: &m.indices,
                origin: m.origin,
                instance_meta: m.instance.as_ref(),
                entity_id: m.express_id,
                color: m.color,
                // #2985: the originating representation item, so a host can drill
                // from an instanced piece back to the source entity.
                item_id: m.geometry_item_id,
            })
            .collect();
        // min_group = 2: instance any repeat; singletons + non-instanceable flat.
        // Pass the applied RTC so per-occurrence transforms are reduced to the
        // post-RTC frame (matches the small baked origins; without it a rotated
        // occurrence lands at 2× the georef offset and collapses GLB exports).
        let rtc = if needs_shift { [rtc_x, rtc_y, rtc_z] } else { [0.0, 0.0, 0.0] };
        let collated = ifc_lite_geometry::collate_refs(&refs, 2, rtc);
        ifc_lite_geometry::encode_refs_with_finishes(&refs, &collated, &wires)
    }

    /// Produce a batch ONCE and PARTITION it (the instanced-ONLY path): opaque
    /// ordinary occurrences (colour alpha >= 0.99 AND geometry_class == 0) are
    /// collated into the instanced shard; everything else (transparent glass,
    /// type-product geometry) goes to the flat MeshCollection. Each mesh takes
    /// exactly ONE route, so produce_batch runs once (no emit-both 2× meshing)
    /// and the renderer draws opaque occurrences via instancing instead of flat.
    /// Partition mirrors the renderer gates: INSTANCED_ALPHA_CUTOFF (0.99 =
    /// OPAQUE_ALPHA_CUTOFF) for transparency, geometry_class for the Model/Types
    /// split.
    ///
    /// NOTE: the renderer must be instanced-feature-complete (picking / selection
    /// / lens overlays on instanced geometry) before the worker calls this in
    /// place of processGeometryBatch — otherwise those features break for the
    /// opaque bulk. See the instanced-only follow-ups.
    #[wasm_bindgen(js_name = processGeometryBatchPartitioned)]
    #[allow(clippy::too_many_arguments)]
    pub fn process_geometry_batch_partitioned(
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
        style_ids: &[u32],
        style_colors: &[u8],
        plane_angle_to_radians: Option<f64>,
        material_element_ids: Option<Vec<u32>>,
        material_color_counts: Option<Vec<u32>>,
        material_colors_rgba: Option<Vec<u8>>,
    ) -> PartitionedBatch {
        let num_jobs = jobs_flat.len() / 3;
        // arm_instancing = true (#1623 Phase 3): the partitioned path holds a flat
        // MeshCollection, so it CAN route the don't-bake sub-threshold recovery to
        // flat — the only entry point that arms it. `shard_occurrences` are the kept
        // don't-bake occurrences (pose-only, no baked vertices); their template
        // materialized once in `outputs`, and any recovered flats are already
        // appended to `outputs`.
        let (outputs, csg_diag, shard_occurrences) = self.produce_batch(
            data, jobs_flat, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, void_keys,
            void_counts, void_values, style_ids, style_colors, plane_angle_to_radians,
            material_element_ids, material_color_counts, material_colors_rgba, true,
        );
        let mut mesh_collection = MeshCollection::with_capacity(num_jobs);
        if needs_shift {
            mesh_collection.set_rtc_offset(rtc_x, rtc_y, rtc_z);
        }
        // Route opaque + untextured + class-0 occurrences by per-batch REPETITION.
        // Instancing trades 1 consolidated, frustum-culled flat draw for 1 drawIndexed
        // per template. That only pays off when geometry repeats enough that the saved
        // upload/memory is real and the per-template draw is amortized over many
        // instances. Singleton / low-count geometry encoded as 1-instance templates was
        // the orbit-FPS regression: it replaced the flat path's ~3-15 consolidated draws
        // with O(unique-geometry) per-frame draws (e.g. an 8 MB-geom architectural model
        // where memory was never the constraint). So: only rep_identity groups occurring
        // >= INSTANCE_MIN_OCCURRENCES times in this batch go to the instanced shard;
        // everything else (singletons, low-count, non-instanceable, no-meta) joins the
        // flat MeshCollection and is consolidated + culled exactly as before the flip.
        //
        // Transparent (alpha < cutoff), textured (no UV slot in the instanced pipeline),
        // type-product (class 1/2) and class-toggled (IfcSpace, IfcOpeningElement, …,
        // #5409) geometry are never instancing candidates — they must stay on the flat
        // pipelines for correct blending / texturing / view-mode / class-toggle gating.
        type Finish = Option<ifc_lite_processing::style::SpecularMaterial>;
        let mut candidates: Vec<(ifc_lite_processing::MeshData, Finish)> = Vec::new();
        let mut counts: rustc_hash::FxHashMap<u128, u32> = rustc_hash::FxHashMap::default();
        for out in outputs {
            // Taken BEFORE the meshes are moved out of `out` below.
            let fingerprint = out.fingerprint();
            for (i, mesh_data) in out.meshes.into_iter().enumerate() {
                let finish = finish_at(&out.finishes, i);
                if is_instancing_candidate(&mesh_data) {
                    // Count only instanceable metas — mirror collate_refs's match arm:
                    // a None meta or instanceable==false (void-cut walls, multi-item
                    // merges) can never instance, so it must not inflate a count.
                    if let Some(rep) = tallyable_rep(&mesh_data) {
                        *counts.entry(rep).or_insert(0) += 1;
                    }
                    candidates.push((mesh_data, finish));
                } else {
                    mesh_collection.add(mesh_js_with_finish(mesh_data, finish));
                }
            }
            // The element-level geometry-diff record is path-independent metadata;
            // keep it on the collection regardless of which path the meshes took.
            if let Some(fp) = fingerprint {
                mesh_collection.push_geometry_hash(fp);
            }
        }
        // #1623 Phase 3: fold the kept don't-bake occurrence counts into the per-rep
        // tally so a batch-local template (materialized ONCE, so count 1 among the
        // candidates) plus its N shard occurrences clears INSTANCE_MIN_OCCURRENCES
        // and routes to the instanced shard (the finalize already applied that gate,
        // so this only confirms it). The template's geometry rides the shard once;
        // the occurrences ride as pose-only instances against it.
        for occ in &shard_occurrences {
            *counts.entry(occ.rep_identity).or_insert(0) += 1;
        }
        let mut instanced: Vec<(ifc_lite_processing::MeshData, Finish)> = Vec::new();
        for (mesh_data, finish) in candidates {
            if meets_instance_threshold(&mesh_data, &counts) {
                instanced.push((mesh_data, finish));
            } else {
                mesh_collection.add(mesh_js_with_finish(mesh_data, finish));
            }
        }
        // Each materialized instanced mesh is one shard instance; each kept don't-bake
        // occurrence adds one more. Report the sum so the viewer's mesh total reflects
        // ALL rendered geometry (flat + instanced), not just the flat MeshCollection.
        let instanced_occurrences = instanced.len() + shard_occurrences.len();
        // #1623 Phase 3: back the kept don't-bake occurrences with InstanceMeta storage
        // that outlives `refs` — `collate_refs` reads each placeholder's PRE-RTC world
        // transform (local/canonical identity) to derive its `rel_k` against the
        // batch-local template, exactly as a materialized occurrence would. Building
        // these EMPTY-geometry refs is the whole Phase 3 win: the occurrence vertices
        // were never materialized.
        let occ_metas: Vec<ifc_lite_geometry::InstanceMeta> = shard_occurrences
            .iter()
            .map(|o| ifc_lite_geometry::InstanceMeta {
                transform: o.world_transform,
                local_transform: None,
                canonical_transform: None,
                rep_identity: o.rep_identity,
                instanceable: true,
            })
            .collect();
        let mut refs: Vec<ifc_lite_geometry::InstanceMeshRef> = instanced
            .iter()
            .map(|(m, _)| ifc_lite_geometry::InstanceMeshRef {
                positions: &m.positions,
                normals: &m.normals,
                indices: &m.indices,
                origin: m.origin,
                instance_meta: m.instance.as_ref(),
                entity_id: m.express_id,
                color: m.color,
                // #2985: the TEMPLATE's own representation item — it rides the
                // shard, not the flat MeshCollection, so this is its only route.
                item_id: m.geometry_item_id,
            })
            .collect();
        for (o, meta) in shard_occurrences.iter().zip(occ_metas.iter()) {
            refs.push(ifc_lite_geometry::InstanceMeshRef {
                positions: &[],
                normals: &[],
                indices: &[],
                origin: [0.0, 0.0, 0.0],
                instance_meta: Some(meta),
                entity_id: o.entity_id,
                color: o.color,
                // #2985: a don't-bake occurrence has no MeshData to read it from.
                item_id: o.geometry_item_id,
            });
        }
        let rtc = if needs_shift { [rtc_x, rtc_y, rtc_z] } else { [0.0, 0.0, 0.0] };
        // #5984: the finish rides the shard's per-instance field 2, index-parallel to `refs`.
        let wires: Vec<[f32; 2]> = instanced.iter().map(|(_, f)| *f).chain(shard_occurrences.iter().map(|o| o.finish)).map(finish_to_wire).collect();
        let (shard, rejected, dropped) =
            encode_shard_routing_refusals_back(&refs, &wires, instanced.len(), rtc);
        drop(refs);
        // Handed back = drawn flat; DROPPED = drawn nowhere. Both leave the count.
        let taken = take_back_rejected(instanced, &rejected, &mut mesh_collection);
        let instanced_occurrences = instanced_occurrences - dropped - taken;
        mesh_collection.set_diagnostics(csg_diag);
        PartitionedBatch {
            meshes: Some(mesh_collection),
            shard,
            instanced_occurrences,
        }
    }
}

#[cfg(test)]
#[path = "batch_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "batch_parity_tests.rs"]
mod parity;

#[cfg(test)]
#[path = "c4_10a_tests.rs"]
mod c4_10a_tests;
