// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::api::IfcAPI;
use crate::zero_copy::{MeshCollection, MeshDataJs};
use wasm_bindgen::prelude::*;

/// Per-element output of [`IfcAPI::produce_batch`] — the canonical producer's
/// meshes (with `instance` metadata intact, BEFORE the MeshDataJs Z-up→Y-up
/// swap) plus the element's geometry hash. The flat path converts each to
/// MeshDataJs; the instanced path collates them into an IFNS shard.
struct ElementMeshOutput {
    id: u32,
    meshes: Vec<ifc_lite_processing::MeshData>,
    geometry_hash: Option<u64>,
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
    ) -> Vec<ElementMeshOutput> {
        use crate::api::styling::resolve_element_color;
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
        let mut outputs: Vec<ElementMeshOutput> = Vec::with_capacity(num_jobs);

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

            for (product_id, fails) in produced.csg_failures {
                batch_csg_failures.entry(product_id).or_default().extend(fails);
            }
            outputs.push(ElementMeshOutput {
                id,
                meshes: produced.meshes,
                geometry_hash: produced.geometry_hash,
            });
        }

        // Surface the opening / CSG diagnostics. The viewer's large-file path
        // goes processAdaptive -> processParallel -> Web Workers ->
        // `processGeometryBatch`, so the log has to fire here or the
        // diagnostic helper never runs for real-world files.
        let _ = crate::api::drain_and_log_csg_diagnostics(&router, batch_csg_failures);

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

        outputs
    }
}

#[wasm_bindgen]
impl IfcAPI {
    /// Process geometry for a subset of pre-scanned entities → flat
    /// MeshCollection. Takes raw bytes + pre-pass data from buildPrePassOnce.
    /// Thin wrapper over [`IfcAPI::produce_batch`]; converts each produced mesh
    /// to MeshDataJs (the IFC Z-up→WebGL Y-up swap + winding reversal happen
    /// there). Output is byte-for-byte what the pre-refactor method produced.
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
        let outputs = self.produce_batch(
            data, jobs_flat, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, void_keys,
            void_counts, void_values, style_ids, style_colors, plane_angle_to_radians,
            material_element_ids, material_color_counts, material_colors_rgba,
        );
        let mut mesh_collection = MeshCollection::with_capacity(num_jobs);
        if needs_shift {
            mesh_collection.set_rtc_offset(rtc_x, rtc_y, rtc_z);
        }
        for out in outputs {
            for mesh_data in out.meshes {
                mesh_collection.add(MeshDataJs::from_mesh_data(mesh_data));
            }
            if let Some(hash) = out.geometry_hash {
                mesh_collection.push_geometry_hash(out.id, hash);
            }
        }
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
        let outputs = self.produce_batch(
            data, jobs_flat, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, void_keys,
            void_counts, void_values, style_ids, style_colors, plane_angle_to_radians,
            material_element_ids, material_color_counts, material_colors_rgba,
        );
        let meshes: Vec<ifc_lite_processing::MeshData> =
            outputs.into_iter().flat_map(|o| o.meshes).collect();
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
            .filter(|m| m.geometry_class == 0)
            .map(|m| ifc_lite_geometry::InstanceMeshRef {
                positions: &m.positions,
                normals: &m.normals,
                indices: &m.indices,
                origin: m.origin,
                instance_meta: m.instance.as_ref(),
                entity_id: m.express_id,
                color: m.color,
            })
            .collect();
        // min_group = 2: instance any repeat; singletons + non-instanceable flat.
        ifc_lite_geometry::collate_and_encode(&refs, 2)
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
        let outputs = self.produce_batch(
            data, jobs_flat, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, void_keys,
            void_counts, void_values, style_ids, style_colors, plane_angle_to_radians,
            material_element_ids, material_color_counts, material_colors_rgba,
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
        // and type-product (class 1/2) geometry are never instancing candidates — they
        // must stay on the flat pipelines for correct blending / texturing / view-mode
        // gating.
        let mut candidates: Vec<ifc_lite_processing::MeshData> = Vec::new();
        let mut counts: rustc_hash::FxHashMap<u128, u32> = rustc_hash::FxHashMap::default();
        for out in outputs {
            for mesh_data in out.meshes {
                let opaque = mesh_data.color[3] >= INSTANCED_ALPHA_CUTOFF;
                let untextured = mesh_data.texture.is_none();
                if opaque && untextured && mesh_data.geometry_class == 0 {
                    // Count only instanceable metas — mirror collate_refs's match arm:
                    // a None meta or instanceable==false (void-cut walls, multi-item
                    // merges) can never instance, so it must not inflate a count.
                    if let Some(im) = mesh_data.instance.as_ref() {
                        if im.instanceable {
                            *counts.entry(im.rep_identity).or_insert(0) += 1;
                        }
                    }
                    candidates.push(mesh_data);
                } else {
                    mesh_collection.add(MeshDataJs::from_mesh_data(mesh_data));
                }
            }
            // The element-level geometry-diff hash is path-independent metadata;
            // keep it on the collection regardless of which path the meshes took.
            if let Some(hash) = out.geometry_hash {
                mesh_collection.push_geometry_hash(out.id, hash);
            }
        }
        let mut instanced: Vec<ifc_lite_processing::MeshData> = Vec::new();
        for mesh_data in candidates {
            let instance_it = mesh_data.instance.as_ref().is_some_and(|im| {
                im.instanceable
                    && counts.get(&im.rep_identity).copied().unwrap_or(0)
                        >= INSTANCE_MIN_OCCURRENCES
            });
            if instance_it {
                instanced.push(mesh_data);
            } else {
                mesh_collection.add(MeshDataJs::from_mesh_data(mesh_data));
            }
        }
        let instanced_occurrences = instanced.len();
        let refs: Vec<ifc_lite_geometry::InstanceMeshRef> = instanced
            .iter()
            .map(|m| ifc_lite_geometry::InstanceMeshRef {
                positions: &m.positions,
                normals: &m.normals,
                indices: &m.indices,
                origin: m.origin,
                instance_meta: m.instance.as_ref(),
                entity_id: m.express_id,
                color: m.color,
            })
            .collect();
        // min_group == the routing threshold so collate_refs never re-flattens a group
        // that already passed the count gate; only its own try_inverse / shape-mismatch
        // safety net can still drop a (rare, degenerate) group to a singleton template.
        let shard =
            ifc_lite_geometry::collate_and_encode(&refs, INSTANCE_MIN_OCCURRENCES as usize);
        PartitionedBatch {
            meshes: Some(mesh_collection),
            shard,
            instanced_occurrences,
        }
    }
}

/// Opaque-alpha cutoff for the instanced-only partition. Mirrors the renderer's
/// `OPAQUE_ALPHA_CUTOFF` (overlay-routing.ts) so the wasm partition and the
/// renderer's flat opaque/transparent split agree: alpha >= this is opaque.
const INSTANCED_ALPHA_CUTOFF: f32 = 0.99;

/// Minimum per-batch occurrence count for a rep_identity group to be GPU-instanced.
/// Below this, geometry rides the flat (consolidated, frustum-culled) path instead —
/// one drawIndexed per template only pays off when amortized over many instances, and
/// the saved upload/memory is negligible at low counts. Tuned for the draw-vs-memory
/// tradeoff: 8 kills the singleton/low-count tail that defeated flat consolidation
/// (the orbit-FPS regression) while leaving genuinely-repeated families (mullions,
/// fasteners, identical steel parts — co-located by affinity routing, so dozens-to-
/// hundreds per batch) instanced. Counting is PER-BATCH; a globally-repeated geometry
/// thinly split across batches may fall below the gate and render flat — a benign
/// missed optimization, never a correctness/FPS regression (flat IS the fast path for
/// low counts). Lower to 4 if a large model's memory regresses; raise to 16 if orbit
/// still drags.
const INSTANCE_MIN_OCCURRENCES: u32 = 8;

/// Result of [`IfcAPI::process_geometry_batch_partitioned`]: the flat
/// MeshCollection (transparent + type geometry) and the instanced IFNS shard
/// (opaque ordinary occurrences) from ONE produce_batch. Take-once accessors so
/// the JS side moves each out without a clone.
#[wasm_bindgen]
pub struct PartitionedBatch {
    meshes: Option<MeshCollection>,
    shard: Vec<u8>,
    instanced_occurrences: usize,
}

#[wasm_bindgen]
impl PartitionedBatch {
    /// The flat MeshCollection (transparent glass + type-product geometry).
    /// Moves out — call once.
    #[wasm_bindgen(js_name = takeMeshes)]
    pub fn take_meshes(&mut self) -> Option<MeshCollection> {
        self.meshes.take()
    }

    /// The instanced IFNS shard bytes (opaque ordinary occurrences). Moves out.
    #[wasm_bindgen(js_name = takeShard)]
    pub fn take_shard(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.shard)
    }

    /// Number of occurrences routed into the instanced shard this batch. The viewer
    /// folds this into its total mesh count so the count reflects ALL rendered
    /// geometry (flat + instanced), not just the flat MeshCollection.
    #[wasm_bindgen(getter, js_name = instancedOccurrences)]
    pub fn instanced_occurrences(&self) -> usize {
        self.instanced_occurrences
    }
}
