// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! JavaScript API for IFC-Lite
//!
//! Modern async/await API for parsing IFC files.

mod alignment_lines;
mod clash;
mod csg_diagnostics;
mod diagnose;
mod export_data;
mod export_glb;
mod export_hbjson;
mod export_obj;
mod export_step;
mod extract_profiles;
mod gpu_meshes;
mod grid_lines;
mod mesh_outline;
mod parsing;
mod pipeline_diagnostics;
mod simplify;
mod space_plate;
pub(crate) mod styling;
mod symbolic;

use csg_diagnostics::drain_and_log_csg_diagnostics;

use ifc_lite_core::ColumnarEntityIndex;
use wasm_bindgen::prelude::*;

/// `TessellationQuality::Medium` as the atomic discriminant stored on
/// [`IfcAPI::tessellation_quality`] (0 = Lowest … 4 = Highest).
const TESSELLATION_QUALITY_MEDIUM: u8 = 2;

/// Main IFC-Lite API
#[wasm_bindgen]
pub struct IfcAPI {
    initialized: bool,
    /// Cached entity index from buildPrePassOnce, reused by processGeometryBatch.
    ///
    /// A compact [`ColumnarEntityIndex`] (three sorted `u32` columns +
    /// binary-search lookup) not an `FxHashMap`: a 19.1 M-entity hashmap rounds
    /// up to `2^25` buckets ≈ 436 MB per worker realm; the columns are ~229 MB
    /// (#1682). Wrapped in `Arc` so successive `processGeometryBatch` calls
    /// reuse it without cloning the columns on every call.
    ///
    /// Phase 1.1 of the single-controller refactor: switched from
    /// `RefCell` to `Mutex` so the API is `Sync`. Rayon helpers (added
    /// in Phase 2) need to be able to call processGeometryBatch via
    /// `&self` from multiple threads without UB. The lock is held only
    /// at batch entry (lock → clone Arc → unlock → use cloned Arc) so
    /// hot-path contention is negligible — each call locks once and
    /// rayon helpers operate on the cloned Arc lock-free thereafter.
    /// `RefCell` was unsafe here even on single-threaded WASM workers
    /// because wasm-bindgen's `WasmRefCell` borrow counter underflows
    /// under concurrent `&self` access.
    cached_entity_index: std::sync::Mutex<Option<std::sync::Arc<ColumnarEntityIndex>>>,

    /// Session source bytes (the whole IFC file) held ONCE per load, so the
    /// streaming batch path stops re-copying the file into the wasm heap on
    /// EVERY `processGeometryBatch*` call. `passArray8ToWasm0` mallocs + memcpys
    /// the full `data` slice every call (~4 ms/call on 169 MB); a huge CSG-dense
    /// model adapts down to 64-job batches and makes 600+ calls/worker, so the
    /// per-call copy alone is 15-25 s/worker of pure memcpy. The bytes are
    /// IDENTICAL across a worker's calls (one model per `IfcAPI`), so one copy
    /// suffices: `setSourceBytes` stores it here and the `*FromSource` batch
    /// variants read it instead of taking `data`. Set once per load (mirrors
    /// `cached_entity_index`); dropped by `clearPrePassCache`. NOT dropped by
    /// `setEntityIndex` — it is REPLACED wholesale by the next `setSourceBytes`,
    /// and the JS worker always calls `setSourceBytes` for the current session
    /// before any `*FromSource` batch, so the held bytes always match the index.
    cached_source_bytes: std::sync::Mutex<Option<std::sync::Arc<Vec<u8>>>>,

    /// Per-worker shared content-dedup cache (#1109 follow-up). The
    /// `GeometryRouter` is rebuilt every `processGeometryBatch`, so its item-mesh
    /// dedup cache would reset each batch. Holding ONE cache here and injecting it
    /// into every batch router lets byte-identical geometry mesh once across the
    /// whole worker's workload — e.g. Tekla connection plates/bolts the exporter
    /// emitted as thousands of separate items instead of one `IfcMappedItem`.
    /// Built lazily on first batch; one model per `IfcApi` instance, exactly like
    /// `cached_entity_index`.
    cached_item_dedup: std::sync::Mutex<Option<ifc_lite_geometry::ItemDedupCache>>,

    /// Per-worker shared `IfcMappedItem` source cache (#1623). The `GeometryRouter`
    /// is rebuilt every `processGeometryBatch`, so its per-router `mapped_item_cache`
    /// would reset each batch and only dedup within a batch. Holding ONE cache here
    /// and injecting it into every batch router meshes each RepresentationMap source
    /// once across the whole worker's workload. Built lazily on first batch; one
    /// model per `IfcApi` instance, exactly like `cached_item_dedup`. Dropped on a
    /// content swap AND on `setTessellationQuality` (a quality change invalidates
    /// the source-coord tessellation — the key is the source id, not the quality).
    cached_mapped_item: std::sync::Mutex<Option<ifc_lite_geometry::SharedMappedItemCache>>,

    /// When `true`, `processGeometryBatch` suppresses geometry emission for
    /// every `IfcBuildingElementPart` whose `IfcRelAggregates` parent (a) has
    /// its own `Representation` and (b) is marked `Sliceable` in
    /// `MaterialLayerIndex`. The parent wall's single solid then carries the
    /// per-layer colour slices instead of N separate part meshes. Defaults to
    /// `false` (existing behaviour). See issue #540.
    ///
    /// Stored as an atomic so it can be toggled from JS between parse calls
    /// without locking — all parse paths read it once at the top.
    merge_layers: std::sync::atomic::AtomicBool,

    /// Lazily-built skip set used by `processGeometryBatch` when `merge_layers` is on. The set
    /// holds every `IfcBuildingElementPart` express ID whose parent wall
    /// (a) has its own `Representation` and (b) is sliceable in
    /// `MaterialLayerIndex` — i.e. the parts that should be suppressed
    /// because the parent's single solid covers their geometry.
    ///
    /// Built on first batch call and shared with all subsequent calls on
    /// the same content. Cleared by `clearPrePassCache` (between loads)
    /// and by `setMergeLayers` (so toggling rebuilds against the latest
    /// flag value).
    cached_parts_to_skip: std::sync::Mutex<Option<std::sync::Arc<rustc_hash::FxHashSet<u32>>>>,

    /// Lazily-built per-content `MaterialLayerIndex` (#563). Single-solid walls
    /// and slabs carrying an `IfcMaterialLayerSetUsage` are sliced into one
    /// sub-mesh per layer (geometry_id = the layer's `IfcMaterial`) so the
    /// build-up is visible in 3D. Built once per load and attached to EVERY
    /// batch router via `set_material_layer_index` so `try_layered_sub_meshes`
    /// can fire — #874 dropped that wiring and silently disabled slicing for
    /// the whole browser stream. Cleared by `clearPrePassCache` between loads.
    cached_material_layer_index:
        std::sync::Mutex<Option<std::sync::Arc<ifc_lite_geometry::MaterialLayerIndex>>>,

    /// Lazily-built set of `IfcRepresentationMap` ids that an `IfcMappedItem`
    /// instantiates (issue #957). `processGeometryBatch` uses it to decide which
    /// of a type's RepresentationMaps are orphan and should be rendered directly
    /// (the rest are drawn through their occurrence). Built once per worker on
    /// the first type-product job and cleared by `clearPrePassCache`.
    cached_referenced_repmaps: std::sync::Mutex<Option<std::sync::Arc<rustc_hash::FxHashSet<u32>>>>,

    /// Lazily-built set of type ids that an `IfcRelDefinesByType` instantiates
    /// (the type has an occurrence). `processGeometryBatch` uses it to suppress
    /// type-only geometry for instanced types — their geometry already draws
    /// through their occurrences, so rendering the type's RepresentationMap too
    /// would double-render it at the MappingOrigin. Built once per worker and
    /// cleared by `clearPrePassCache`.
    cached_instantiated_type_ids:
        std::sync::Mutex<Option<std::sync::Arc<rustc_hash::FxHashSet<u32>>>>,

    /// #1623 Phase 3 don't-bake plan: `IfcRepresentationMap` id ⇒ `(count, min-id)`
    /// for every source an `IfcMappedItem` instantiates >= 2 times (the streaming
    /// pre-pass tallies it in the same scan that builds `cached_referenced_repmaps`).
    /// When present AND the instanced/partitioned batch path runs, the batch router
    /// is armed with it in BATCH-LOCAL mode so a repeated single-solid mapped source
    /// meshes ONCE per batch (the first-seen occurrence) and the rest ride as
    /// per-occurrence instances in the IFNS shard — killing the per-occurrence
    /// vertex materialize. `None` (never installed) ⇒ the batch path materializes
    /// every occurrence exactly as before (byte-identical). Cleared on content swap
    /// (`setEntityIndex`) and `clearPrePassCache`, like the other pre-pass columns.
    cached_mapped_instance_plan:
        std::sync::Mutex<Option<ifc_lite_geometry::MappedInstancePlan>>,

    /// Lazily-built surface-texture index keyed by face-set id (issue #961):
    /// decoded RGBA images + per-triangle UV maps from
    /// `IfcIndexedTriangleTextureMap`. Built once per worker (cheap substring
    /// bail-out for untextured files) and cleared by `clearPrePassCache`.
    cached_texture_index: std::sync::Mutex<
        Option<std::sync::Arc<rustc_hash::FxHashMap<u32, ifc_lite_geometry::ResolvedTextureMap>>>,
    >,

    /// Lazily-built `IfcIndexedColourMap` index keyed by target geometry id,
    /// used by `processGeometryBatch` to split a tessellated face set into one
    /// sub-mesh per palette group (issue #858). The browser geometry path lost
    /// this split in the #874 mesh-pipeline unification — it kept only the
    /// dominant colour per geometry. Built once per worker on first batch call
    /// (a single extra entity scan, cached) and cleared by `clearPrePassCache`.
    cached_indexed_colour_maps: std::sync::Mutex<
        Option<
            std::sync::Arc<
                rustc_hash::FxHashMap<u32, ifc_lite_processing::style::FullIndexedColourMap>,
            >,
        >,
    >,

    /// When `true`, `processGeometryBatch` computes a per-entity geometry
    /// fingerprint (see `ifc_lite_geometry::geom_hash`) and returns it on the
    /// `MeshCollection`. Powers the viewer's "compare two revisions" diff: an
    /// unchanged element hashes identically across files, a moved/reshaped one
    /// differs. Default `false` so normal rendering pays nothing.
    ///
    /// Atomic so it can be toggled from JS between parse calls without locking;
    /// the batch path reads it once at the top.
    compute_geometry_hashes: std::sync::atomic::AtomicBool,

    /// Quantization grid (metres) used when `compute_geometry_hashes` is on.
    /// Stored as `f64::to_bits` in a `u64` atomic so the `(enabled, tolerance)`
    /// pair stays lock-free. Only read when `compute_geometry_hashes` is true.
    geometry_hash_tolerance_bits: std::sync::atomic::AtomicU64,

    /// Tessellation detail level applied by `processGeometryBatch` (issue #976,
    /// step 4). Stored as the `TessellationQuality` discriminant (0 = Lowest …
    /// 4 = Highest) in an atomic so JS can toggle it between parse calls
    /// without locking — same contract as `merge_layers`. Default is Medium,
    /// which reproduces the historical hardcoded densities byte-for-byte.
    tessellation_quality: std::sync::atomic::AtomicU8,

    /// Tier-independent small-cut skip switch (#1286). When set, `processGeometryBatch`
    /// drops `IfcBooleanResult` differences whose cutter is tiny relative to its host
    /// (steel copes/notches) WITHOUT lowering the tessellation tier, so curves keep
    /// full density. Default off ⇒ every cut runs (byte-identical to before). Applied
    /// to the per-batch `GeometryRouter` via `GeometryRouter::set_skip_small_cuts`.
    skip_small_cuts: std::sync::atomic::AtomicBool,

    /// Lazily-resolved plane-angle → radians scale for the current content,
    /// seeded into every batch decoder via `EntityDecoder::seed_unit_scales`.
    /// `EntityDecoder::plane_angle_to_radians()` walks the whole DATA section
    /// to find the singleton `IFCPROJECT` — which IfcOpenShell emits near the
    /// *end* of the file — and its cache is per-decoder, so without this
    /// per-worker cache every `processGeometryBatch` call re-pays an O(file)
    /// scan the moment any arc-bearing profile is tessellated (≈ the geometry
    /// stream stall on large models with late IFCPROJECT). Content-scoped:
    /// cleared by `clearPrePassCache` and on entity-index swap.
    cached_plane_angle_to_radians: std::sync::Mutex<Option<f64>>,
    /// #1097 perf: the geometry-style maps (style-entity-id → RGBA, and the
    /// derived `GeometryStyleInfo` index the canonical producer consumes) are
    /// rebuilt from the flat wire arrays on EVERY `processGeometryBatch` call,
    /// but those arrays are session-constant (set once via the streaming
    /// `styles` event). On a model with ~140 K styled entities that's two
    /// 140 K-entry HashMaps built ~30×/worker (~18 M inserts each). Cache both,
    /// keyed by a cheap (len, first_id, last_id) signature of the wire arrays —
    /// rebuilt only when the signature changes.
    #[allow(clippy::type_complexity)]
    cached_geometry_styles: std::sync::Mutex<
        Option<(
            usize,
            u32,
            u32,
            std::sync::Arc<(
                rustc_hash::FxHashMap<u32, [f32; 4]>,
                rustc_hash::FxHashMap<u32, ifc_lite_processing::style::GeometryStyleInfo>,
            )>,
        )>,
    >,

    /// Per-load structured pipeline diagnostics (`PipelineDiagnostics`
    /// contract, see `api::pipeline_diagnostics`): every
    /// `processGeometryBatch*` call folds one batch record in — cheap
    /// counters plus per-batch JS wall time, so it is always on. Read by JS
    /// via `getPipelineDiagnostics`; reset at load START by every entry point
    /// that begins a new file on a reused IfcAPI (`buildPrePassOnce`,
    /// `buildPrePassStreaming`, `setEntityIndex`) - deliberately NOT by
    /// `clearPrePassCache`, which runs at end-of-load before a host reads the
    /// diagnostics.
    pipeline_diagnostics: std::sync::Mutex<ifc_lite_processing::PipelineDiagnostics>,
}

#[wasm_bindgen]
impl IfcAPI {
    /// Create and initialize the IFC API
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        #[cfg(feature = "console_error_panic_hook")]
        console_error_panic_hook::set_once();

        Self {
            initialized: true,
            cached_entity_index: std::sync::Mutex::new(None),
            cached_source_bytes: std::sync::Mutex::new(None),
            cached_item_dedup: std::sync::Mutex::new(None),
            cached_mapped_item: std::sync::Mutex::new(None),
            merge_layers: std::sync::atomic::AtomicBool::new(false),
            cached_parts_to_skip: std::sync::Mutex::new(None),
            cached_material_layer_index: std::sync::Mutex::new(None),
            cached_referenced_repmaps: std::sync::Mutex::new(None),
            cached_instantiated_type_ids: std::sync::Mutex::new(None),
            cached_mapped_instance_plan: std::sync::Mutex::new(None),
            cached_texture_index: std::sync::Mutex::new(None),
            cached_indexed_colour_maps: std::sync::Mutex::new(None),
            compute_geometry_hashes: std::sync::atomic::AtomicBool::new(false),
            geometry_hash_tolerance_bits: std::sync::atomic::AtomicU64::new(
                ifc_lite_geometry::DEFAULT_GEOM_HASH_TOLERANCE.to_bits(),
            ),
            tessellation_quality: std::sync::atomic::AtomicU8::new(TESSELLATION_QUALITY_MEDIUM),
            skip_small_cuts: std::sync::atomic::AtomicBool::new(false),
            cached_plane_angle_to_radians: std::sync::Mutex::new(None),
            cached_geometry_styles: std::sync::Mutex::new(None),
            pipeline_diagnostics: std::sync::Mutex::new(
                ifc_lite_processing::PipelineDiagnostics::default(),
            ),
        }
    }

    /// Check if API is initialized
    #[wasm_bindgen(getter)]
    pub fn is_ready(&self) -> bool {
        self.initialized
    }

    /// Clear the cached entity index (call between loads when reusing
    /// the same `IfcAPI` instance — e.g. the parser worker keeps one
    /// `IfcAPI` alive across multiple `parse` requests).
    ///
    /// Recovers a poisoned cache Mutex instead of panicking; see `mod_tests.rs`.
    #[wasm_bindgen(js_name = clearPrePassCache)]
    pub fn clear_pre_pass_cache(&self) {
        let mut slot = self
            .cached_entity_index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        slot.take();
        // The parts-to-skip set is keyed off the content scanned during
        // the previous load; drop it together with the entity index so the
        // next file's first batch call rebuilds against fresh content.
        let mut parts_slot = self
            .cached_parts_to_skip
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        parts_slot.take();
        // The material-layer index is keyed off the previous load's content.
        self.cached_material_layer_index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        // The referenced-RepresentationMap set is keyed off the previous load's
        // content; drop it so the next file rebuilds against fresh content.
        let mut repmap_slot = self
            .cached_referenced_repmaps
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        repmap_slot.take();
        // The instantiated-type-ids set is keyed off the previous load's content.
        let mut inst_slot = self
            .cached_instantiated_type_ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        inst_slot.take();
        // The don't-bake mapped-instance plan is keyed off the previous load's
        // IfcMappedItem scan (#1623 Phase 3); drop it so the next file rebuilds it.
        self.cached_mapped_instance_plan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        // The texture index is keyed off the previous load's content; drop it.
        let mut texture_slot = self
            .cached_texture_index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        texture_slot.take();
        // The indexed-colour-map index is also keyed off the previous load's
        // content; drop it so the next file rebuilds against fresh content.
        let mut icm_slot = self
            .cached_indexed_colour_maps
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        icm_slot.take();
        // The plane-angle scale belongs to the previous load's content.
        self.cached_plane_angle_to_radians
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        // The geometry-style maps belong to the previous load's wire styles.
        self.cached_geometry_styles
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        // The content-dedup cache holds the previous model's item meshes, keyed by
        // a content hash of that model's entities. Drop it so a new file on the
        // same reused IfcAPI starts with an empty cache (bounds memory across
        // loads; defensive even though the key is content- not id-based).
        self.cached_item_dedup
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        // The session source bytes are the previous load's whole file; drop them
        // at end-of-load cleanup so a reused IfcAPI doesn't retain a ~100s-of-MB
        // copy between loads (the next load's setSourceBytes re-installs its own).
        self.cached_source_bytes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        // The mapped-item source cache holds the previous model's source meshes,
        // keyed by RepresentationMap id (baking in that load's unit scale /
        // tessellation quality). Drop it so a new file on the same reused IfcAPI
        // starts empty (#1623).
        self.cached_mapped_item
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        // NB: do NOT reset pipeline_diagnostics here. clearPrePassCache runs in
        // the JS load wrapper's `finally` AFTER the last processGeometryBatch
        // (packages/geometry/src/index.ts), i.e. end-of-load cleanup; resetting
        // here would erase the just-completed load's diagnostics before a host
        // can read getPipelineDiagnostics(). Diagnostics are an accumulator, not
        // a cache, so they reset only at load START (set_entity_index), unlike
        // cached_item_dedup which is safe to drop on every clear.
    }

    /// Populate `cached_entity_index` from pre-extracted column arrays.
    ///
    /// Used by the streaming pre-pass to share its already-built entity
    /// index across worker realms via SAB-backed Uint32Arrays — every
    /// process worker would otherwise re-scan the entire file in
    /// `processGeometryBatch`'s lazy build path (~5 s on a 1 GB IFC),
    /// even though the pre-pass worker built the same index minutes
    /// earlier.
    ///
    /// Builds a compact [`ColumnarEntityIndex`] from the three input slices
    /// (sorted `u32` columns + binary search) instead of a per-worker
    /// `FxHashMap` — ~229 MB vs ~436 MB on a 19.1 M-entity model (#1682).
    /// [`ColumnarEntityIndex::from_columns`] verifies the id ordering once
    /// (O(n)) and only argsorts if the producer did not emit sorted columns.
    ///
    /// `lengths[i]` is the byte length of entity `ids[i]`, so lookup returns
    /// `(start, start + length)` to match the existing `(start, end)` layout.
    ///
    /// Idempotent in the sense that repeated calls REPLACE the cache —
    /// supports the parser-worker pattern of reusing one IfcAPI across
    /// multiple loads with different files.
    #[wasm_bindgen(js_name = setEntityIndex)]
    pub fn set_entity_index(&self, ids: &[u32], starts: &[u32], lengths: &[u32]) {
        let n = ids.len();
        if n == 0 || starts.len() != n || lengths.len() != n {
            return;
        }
        let index = ColumnarEntityIndex::from_columns(ids, starts, lengths);
        let mut slot = self
            .cached_entity_index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = Some(std::sync::Arc::new(index));
        drop(slot);

        // Swapping the entity index means a different file. The other caches are
        // content-scoped (keyed off the previous load) — carrying them into the
        // next file would wrongly suppress/keep orphan type geometry, reuse a
        // stale texture index, or skip the wrong parts. Drop them so they
        // rebuild against the new content (#962 review). Mirrors clearPrePassCache.
        self.cached_parts_to_skip
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.cached_material_layer_index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.cached_referenced_repmaps
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.cached_instantiated_type_ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.cached_mapped_instance_plan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.cached_texture_index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.cached_indexed_colour_maps
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        self.cached_plane_angle_to_radians
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        // The geometry-style maps belong to the previous load's wire styles —
        // drop them on content swap so a reused IfcAPI can't reuse a stale map
        // (the (len,first,last) signature would otherwise collide rarely).
        self.cached_geometry_styles
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        // The content-dedup cache holds the previous model's item meshes — drop it
        // on content swap so a reused IfcAPI starts the new file with an empty
        // cache (bounds memory across loads).
        self.cached_item_dedup
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        // The mapped-item source cache holds the previous model's source meshes —
        // drop it on content swap so a reused IfcAPI starts the new file empty
        // (bounds memory across loads; #1623).
        self.cached_mapped_item
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        // A new entity index means a new file — the pipeline diagnostics
        // describe the previous load, so start fresh.
        self.reset_pipeline_diagnostics();
    }

    /// Install the pre-computed set of `IfcRepresentationMap` ids referenced by
    /// an `IfcMappedItem` (issue #957), so the worker's first type-product batch
    /// SKIPS the per-worker [`Self::get_or_build_referenced_repmaps`] full-file
    /// walk. The streaming pre-pass built the same set once from the
    /// `IfcMappedItem` spans it already scanned (see
    /// `styling::build_referenced_representation_maps_from_spans`) and ships the
    /// id list here — bit-identical to what each worker would compute, since a
    /// set's membership is order-invariant and consumers only call `.contains`.
    ///
    /// Installed AFTER `setEntityIndex` (which clears this cache on content
    /// swap), so the injected value survives. When this setter is never called
    /// (native path, non-streaming callers), the lazy build path is unchanged.
    #[wasm_bindgen(js_name = setReferencedRepmaps)]
    pub fn set_referenced_repmaps(&self, ids: &[u32]) {
        let set: rustc_hash::FxHashSet<u32> = ids.iter().copied().collect();
        let mut slot = self
            .cached_referenced_repmaps
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = Some(std::sync::Arc::new(set));
    }

    /// Install the pre-computed set of type ids that an `IfcRelDefinesByType`
    /// instantiates (#957 follow-up), so the worker's first type-product batch
    /// skips the per-worker [`Self::get_or_build_instantiated_type_ids`]
    /// full-file walk. Same injection contract as [`Self::set_referenced_repmaps`].
    #[wasm_bindgen(js_name = setInstantiatedTypeIds)]
    pub fn set_instantiated_type_ids(&self, ids: &[u32]) {
        let set: rustc_hash::FxHashSet<u32> = ids.iter().copied().collect();
        let mut slot = self
            .cached_instantiated_type_ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = Some(std::sync::Arc::new(set));
    }

    /// Install the pre-computed #1623 Phase 3 don't-bake plan: the flat list of
    /// `IfcRepresentationMap` ids that an `IfcMappedItem` instantiates >= 2 times.
    /// The streaming pre-pass tallies it in the SAME scan that builds the referenced-
    /// repmap set (`styling::build_mapped_instance_plan_from_spans`) and ships the id
    /// list here. The batch path arms its router with it (batch-local template mode),
    /// so a repeated single-solid mapped source materializes ONCE per batch and the
    /// rest ride as instances in the IFNS shard.
    ///
    /// Same injection contract as [`Self::set_referenced_repmaps`]: installed after
    /// `setEntityIndex` (which clears it on content swap), and a no-op absence leaves
    /// the batch path materializing every occurrence (byte-identical). Each id is
    /// stored as `(2, id)` — the batch-local router only needs the eligibility set
    /// (count >= 2); the min-id template slot is unused in batch-local mode.
    #[wasm_bindgen(js_name = setMappedInstancePlan)]
    pub fn set_mapped_instance_plan(&self, source_ids: &[u32]) {
        if source_ids.is_empty() {
            // Nothing repeated ⇒ leave the plan unset so the router never arms.
            return;
        }
        let plan: rustc_hash::FxHashMap<u32, (u32, u32)> =
            source_ids.iter().map(|&id| (id, (2u32, id))).collect();
        let mut slot = self
            .cached_mapped_instance_plan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = Some(std::sync::Arc::new(plan));
    }

    /// Install the pre-computed [`ifc_lite_geometry::MaterialLayerIndex`] (#563)
    /// from its flat SoA encoding, so the worker's first batch skips the
    /// per-worker [`Self::get_or_build_material_layer_index`] full-file decode
    /// scan (the dominant first-batch cost on layered architectural models,
    /// which run this on the DEFAULT view). The streaming pre-pass built the
    /// index once from the `IfcRelAssociatesMaterial` spans it already scanned
    /// (`MaterialLayerIndex::from_spans`) and flat-encoded it here; the flat
    /// encoding round-trips bit-for-bit (proven in `material_layer_index` tests),
    /// so the injected index equals each worker's `from_content` result.
    ///
    /// Same injection contract as [`Self::set_referenced_repmaps`]: installed
    /// after `setEntityIndex`, and a no-op absence leaves the lazy build intact.
    #[allow(clippy::too_many_arguments)]
    #[wasm_bindgen(js_name = setMaterialLayerIndex)]
    pub fn set_material_layer_index(
        &self,
        element_ids: &[u32],
        axis: &[u32],
        layer_counts: &[u32],
        direction_sense: &[f64],
        offset: &[f64],
        layer_material_ids: &[u32],
        layer_thicknesses: &[f64],
    ) {
        let index = ifc_lite_geometry::MaterialLayerIndex::from_flat(
            element_ids,
            axis,
            layer_counts,
            direction_sense,
            offset,
            layer_material_ids,
            layer_thicknesses,
        );
        let mut slot = self
            .cached_material_layer_index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = Some(std::sync::Arc::new(index));
    }

    /// Get WASM memory for zero-copy access
    #[wasm_bindgen(js_name = getMemory)]
    pub fn get_memory(&self) -> JsValue {
        crate::zero_copy::get_memory()
    }

    /// Get version string
    #[wasm_bindgen(getter)]
    pub fn version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }

    /// Toggle the "render multilayer walls as a single solid" mode (issue #540).
    ///
    /// When `enabled` is `true`, every subsequent `processGeometryBatch` call
    /// will suppress geometry emission for `IfcBuildingElementPart` entities
    /// whose `IfcRelAggregates` parent wall is sliceable (has an
    /// `IfcMaterialLayerSetUsage`) AND has its own `Representation`. The
    /// parent wall keeps its per-layer sub-mesh colouring, so the visual
    /// result is the same as the layered render but with one mesh per wall
    /// instead of one per layer part — much cheaper for both CPU and GPU.
    ///
    /// Default is `false`. Pass `true` before calling `processGeometryBatch`.
    #[wasm_bindgen(js_name = setMergeLayers)]
    pub fn set_merge_layers(&self, enabled: bool) {
        self.merge_layers
            .store(enabled, std::sync::atomic::Ordering::Relaxed);
        // Drop any cached skip set so the next batch rebuilds against the
        // current flag value — toggling off must immediately stop skipping.
        let mut parts_slot = self
            .cached_parts_to_skip
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        parts_slot.take();
    }

    /// Enable or disable the PARAMETRIC rectangular-opening fast path (the
    /// placement-frame, ground-truth-exact analytic cut) for `processGeometryBatch`.
    ///
    /// DEFAULT ON (corpus-validated; native defaults ON too, and wasm has no env to
    /// read `IFC_LITE_RECT_PARAM`, so both targets default in LOCKSTEP -- the
    /// byte-identical native==wasm contract requires both take the same path). This
    /// toggle is the wasm-side escape hatch mirroring `IFC_LITE_RECT_PARAM=0`.
    /// The path subtracts rectangular openings as exact parametric boxes in the host's
    /// own placement frame (rotated walls included), deferring any non-clean case to
    /// the exact kernel. Pass `false` before `processGeometryBatch` to opt out.
    #[wasm_bindgen(js_name = setRectParamFastPath)]
    pub fn set_rect_param_fast_path(&self, enabled: bool) {
        ifc_lite_geometry::rect_fast::param_set_enabled_override(Some(enabled));
    }

    /// Enable or disable per-entity geometry fingerprinting in
    /// `processGeometryBatch`, used by the viewer's revision-diff feature.
    ///
    /// Pass a positive `tolerance` (metres) to enable — it is the quantization
    /// grid the hash snaps positions to (larger = more tolerant of float noise,
    /// smaller = catches finer edits; the `f32` precision floor of model-local
    /// coordinates means values below ~1 mm mostly hash noise). Pass `null`/
    /// `undefined` (or a non-positive value) to disable. Default: disabled.
    #[wasm_bindgen(js_name = setComputeGeometryHashes)]
    pub fn set_compute_geometry_hashes(&self, tolerance: Option<f64>) {
        use std::sync::atomic::Ordering::Relaxed;
        match tolerance {
            Some(t) if t > 0.0 => {
                self.geometry_hash_tolerance_bits
                    .store(t.to_bits(), Relaxed);
                self.compute_geometry_hashes.store(true, Relaxed);
            }
            _ => self.compute_geometry_hashes.store(false, Relaxed),
        }
    }

    /// Select the tessellation detail level applied by every subsequent
    /// `processGeometryBatch` call (issue #976, step 4).
    ///
    /// `level` is one of `"lowest" | "low" | "medium" | "high" | "highest"`
    /// (case-insensitive). `"medium"` is the default and reproduces the
    /// engine's historical hardcoded densities byte-for-byte; lower levels
    /// trade curved-surface smoothness for throughput, higher levels reduce
    /// faceting on pipes / cylinders / NURBS at a triangle-count cost.
    /// Pass `null`/`undefined` to reset to the default.
    ///
    /// Set BEFORE processing — meshes already emitted are not regenerated.
    /// Throws on an unrecognized level so typos fail loudly instead of
    /// silently rendering at the wrong density.
    #[wasm_bindgen(js_name = setTessellationQuality)]
    pub fn set_tessellation_quality(&self, level: Option<String>) -> Result<(), JsValue> {
        let discriminant = match level.as_deref() {
            None => TESSELLATION_QUALITY_MEDIUM,
            Some(s) => match ifc_lite_geometry::TessellationQuality::parse_label(s) {
                Some(q) => q.to_index(),
                None => {
                    return Err(JsValue::from_str(&format!(
                        "Unknown tessellation quality '{s}' — expected \
                         lowest | low | medium | high | highest"
                    )))
                }
            },
        };
        self.tessellation_quality
            .store(discriminant, std::sync::atomic::Ordering::Relaxed);
        // The mapped-item source cache is keyed by RepresentationMap id, not by
        // quality, and bakes in the tessellation density of its curved sub-items.
        // A quality change would otherwise serve stale-density source meshes across
        // subsequent batches, so drop it here — mirroring the router's own
        // `set_tessellation_quality`, which clears its per-router `mapped_item_cache`
        // for the same reason. (The content-dedup cache folds quality INTO its key,
        // so it needs no such clear.)
        self.cached_mapped_item
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        Ok(())
    }

    /// Toggle the tier-independent small-cut skip (#1286). When `true`,
    /// `processGeometryBatch` drops `IfcBooleanResult` differences whose cutter is
    /// tiny relative to its host (steel copes/notches) while keeping the
    /// tessellation tier — so curves stay full-density. The viewer enables this for
    /// the on-screen load; exports/drawings leave it off so their geometry keeps
    /// every cut. Default off ⇒ byte-identical to before.
    ///
    /// Set BEFORE processing — meshes already emitted are not regenerated.
    #[wasm_bindgen(js_name = setSkipSmallCuts)]
    pub fn set_skip_small_cuts(&self, on: bool) {
        self.skip_small_cuts
            .store(on, std::sync::atomic::Ordering::Relaxed);
        // `skip_small_cuts` swaps the boolean/CSG processors, so a mapped source
        // containing IfcBooleanResult/IfcCsgSolid meshes differently under it. The
        // source cache is keyed by RepresentationMap id, not by this flag, so a
        // toggle would otherwise serve stale-fidelity source meshes (e.g. a worker
        // reused by a full-fidelity export after a `fast` load). Drop it here,
        // mirroring `set_tessellation_quality`.
        self.cached_mapped_item
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
    }
}

impl IfcAPI {
    /// Internal accessor used by the parse pipelines to decide whether to
    /// skip `IfcBuildingElementPart` emission. Not exposed to JS — JS
    /// callers control the flag via [`Self::set_merge_layers`].
    pub(crate) fn merge_layers(&self) -> bool {
        self.merge_layers.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Active tessellation quality, read once at the top of
    /// `processGeometryBatch`. JS controls it via
    /// [`Self::set_tessellation_quality`].
    pub(crate) fn tessellation_quality(&self) -> ifc_lite_geometry::TessellationQuality {
        use ifc_lite_geometry::TessellationQuality;
        TessellationQuality::from_index(
            self.tessellation_quality
                .load(std::sync::atomic::Ordering::Relaxed),
        )
    }

    /// Active small-cut skip flag, applied to the per-batch `GeometryRouter` at
    /// the top of `processGeometryBatch`. JS controls it via [`Self::set_skip_small_cuts`].
    pub(crate) fn skip_small_cuts(&self) -> bool {
        self.skip_small_cuts
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Active geometry-hash tolerance (metres), or `None` when fingerprinting
    /// is disabled. Read once at the top of `processGeometryBatch`. JS controls
    /// it via [`Self::set_compute_geometry_hashes`].
    pub(crate) fn geometry_hash_tolerance(&self) -> Option<f64> {
        use std::sync::atomic::Ordering::Relaxed;
        if self.compute_geometry_hashes.load(Relaxed) {
            Some(f64::from_bits(
                self.geometry_hash_tolerance_bits.load(Relaxed),
            ))
        } else {
            None
        }
    }

    /// Get or lazily build the cached parts-to-skip set used by
    /// `processGeometryBatch` when the merge-layers toggle is on. Two
    /// full-file scans (`MaterialLayerIndex` plus `propagate_voids_to_parts`)
    /// are amortised across every batch on the same content; first-call cost
    /// ~one IFC re-scan, subsequent calls are an `Arc::clone`.
    ///
    /// Returns an empty set when no eligible parts exist — callers can
    /// still cheaply test `parts.contains(&id)` without a branch.
    pub(crate) fn get_or_build_parts_to_skip(
        &self,
        content: &[u8],
        decoder: &mut ifc_lite_core::EntityDecoder,
    ) -> std::sync::Arc<rustc_hash::FxHashSet<u32>> {
        {
            let slot = self
                .cached_parts_to_skip
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(existing) = slot.as_ref() {
                return std::sync::Arc::clone(existing);
            }
        }

        // The layer/void driver now lives in the geometry crate next to its
        // kernels (#913 Phase 4 / §2.6); this method just caches its result
        // per content so it isn't recomputed on every batch.
        let skip_set = ifc_lite_geometry::compute_parts_to_skip(content, decoder);

        let arc = std::sync::Arc::new(skip_set);
        let mut slot = self
            .cached_parts_to_skip
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = Some(std::sync::Arc::clone(&arc));
        arc
    }

    /// Get or lazily build the per-content [`MaterialLayerIndex`] (#563) used to
    /// slice single-solid walls/slabs with an `IfcMaterialLayerSetUsage` into one
    /// sub-mesh per layer. Built once per load (one IFCRELASSOCIATESMATERIAL
    /// decode scan, with a cheap substring bail-out on files that carry no layer
    /// set) and `Arc`-shared with every batch router so `try_layered_sub_meshes`
    /// fires. Subsequent batches are an `Arc::clone`.
    pub(crate) fn get_or_build_material_layer_index(
        &self,
        content: &[u8],
        decoder: &mut ifc_lite_core::EntityDecoder,
    ) -> std::sync::Arc<ifc_lite_geometry::MaterialLayerIndex> {
        {
            let slot = self
                .cached_material_layer_index
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(existing) = slot.as_ref() {
                return std::sync::Arc::clone(existing);
            }
        }

        // Most models carry no IfcMaterialLayerSet. A cheap raw-byte substring
        // probe (no entity decode) lets us cache an EMPTY index without the
        // per-`IfcRelAssociatesMaterial` decode scan `from_content` runs — the
        // cost the streaming pre-pass deliberately avoided. Only layered files
        // pay the full build; non-layered files behave identically (an absent
        // entry and a `NotSliceable` entry both mean "don't slice").
        const LAYER_SET_KW: &[u8] = b"IFCMATERIALLAYERSET";
        // memmem (SIMD O(n)) not the naive O(n*k) `windows().any()`: this runs on
        // the whole file on each worker's first batch call, so on a 200-340MB model
        // the naive scan cost ~100-400ms per worker. Byte-identical boolean.
        let has_layer_set = memchr::memmem::find(content, LAYER_SET_KW).is_some();
        let index = if has_layer_set {
            ifc_lite_geometry::MaterialLayerIndex::from_content(content, decoder)
        } else {
            ifc_lite_geometry::MaterialLayerIndex::new()
        };
        // Diagnostic (#563/#874): stay silent for the ~99% of models with no
        // sliceable buildup (every load otherwise logged a line). Only speak up
        // when there's something to slice — or when the layer-set keyword is
        // present but NOTHING resolved as sliceable (e.g. an IfcMaterialLayerSet
        // associated without a LayerSetUsage), which is the case worth flagging.
        // The per-batch "sliced N wall(s)" line already reports success.
        let sliceable = index.sliceable_count();
        if sliceable > 0 {
            web_sys::console::info_1(
                &format!("[ifc-lite layers] {sliceable} sliceable buildup(s) of {} association(s)", index.len()).into(),
            );
        } else if has_layer_set {
            web_sys::console::warn_1(
                &"[ifc-lite layers] IfcMaterialLayerSet present but no sliceable buildup (LayerSetUsage missing?)".into(),
            );
        }
        let arc = std::sync::Arc::new(index);
        let mut slot = self
            .cached_material_layer_index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = Some(std::sync::Arc::clone(&arc));
        arc
    }

    /// The installed #1623 Phase 3 don't-bake plan (see [`Self::set_mapped_instance_plan`]),
    /// or `None` when the pre-pass shipped no repeated mapped sources. UNLIKE the
    /// referenced-repmap set there is NO lazy full-file fallback: the plan is a pure
    /// optimization, so absence just means "materialize every occurrence" (the
    /// byte-identical default), never a correctness gap.
    pub(crate) fn mapped_instance_plan(&self) -> Option<ifc_lite_geometry::MappedInstancePlan> {
        self.cached_mapped_instance_plan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .map(std::sync::Arc::clone)
    }

    /// Get or lazily build the set of `IfcRepresentationMap` ids instantiated by
    /// an `IfcMappedItem` (issue #957). `processGeometryBatch` uses it to render
    /// only the ORPHAN RepresentationMaps of a type-product (the rest are drawn
    /// through their occurrence). Cached per worker so the scan is paid once.
    pub(crate) fn get_or_build_referenced_repmaps(
        &self,
        content: &[u8],
        decoder: &mut ifc_lite_core::EntityDecoder,
    ) -> std::sync::Arc<rustc_hash::FxHashSet<u32>> {
        {
            let slot = self
                .cached_referenced_repmaps
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(existing) = slot.as_ref() {
                return std::sync::Arc::clone(existing);
            }
        }

        let referenced = styling::build_referenced_representation_maps(content, decoder);

        let arc = std::sync::Arc::new(referenced);
        let mut slot = self
            .cached_referenced_repmaps
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = Some(std::sync::Arc::clone(&arc));
        arc
    }

    /// Get or lazily build the set of type ids that an `IfcRelDefinesByType`
    /// instantiates (#957 follow-up). `processGeometryBatch` uses it to suppress
    /// type-only geometry for instanced types (the geometry already draws through
    /// their occurrences). Cached per worker so the scan is paid once.
    pub(crate) fn get_or_build_instantiated_type_ids(
        &self,
        content: &[u8],
        decoder: &mut ifc_lite_core::EntityDecoder,
    ) -> std::sync::Arc<rustc_hash::FxHashSet<u32>> {
        {
            let slot = self
                .cached_instantiated_type_ids
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(existing) = slot.as_ref() {
                return std::sync::Arc::clone(existing);
            }
        }

        let instantiated = styling::build_instantiated_type_ids(content, decoder);

        let arc = std::sync::Arc::new(instantiated);
        let mut slot = self
            .cached_instantiated_type_ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = Some(std::sync::Arc::clone(&arc));
        arc
    }

    /// Get or lazily build the surface-texture index keyed by face-set id
    /// (issue #961): decoded RGBA images + per-triangle UV maps. Cached per
    /// worker; `build_texture_index` bails out cheaply on untextured files.
    pub(crate) fn get_or_build_texture_index(
        &self,
        content: &[u8],
        decoder: &mut ifc_lite_core::EntityDecoder,
    ) -> std::sync::Arc<rustc_hash::FxHashMap<u32, ifc_lite_geometry::ResolvedTextureMap>> {
        {
            let slot = self
                .cached_texture_index
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(existing) = slot.as_ref() {
                return std::sync::Arc::clone(existing);
            }
        }

        let index = ifc_lite_geometry::build_texture_index(content, decoder);

        let arc = std::sync::Arc::new(index);
        let mut slot = self
            .cached_texture_index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = Some(std::sync::Arc::clone(&arc));
        arc
    }

    /// Get or lazily build the `IfcIndexedColourMap` index (geometry id →
    /// full per-triangle palette) used by `processGeometryBatch` to split a
    /// tessellated face set into one sub-mesh per palette group (issue #858).
    ///
    /// Mirrors the native processor's collection pass (processor.rs ~905):
    /// one entity scan that decodes every `IFCINDEXEDCOLOURMAP` and resolves
    /// it to a [`FullIndexedColourMap`]. Cached per worker so the scan is paid
    /// once, not per batch. Returns an empty map when the file authors none
    /// (the common case), so callers can cheaply `.get(&geometry_id)`.
    pub(crate) fn get_or_build_indexed_colour_maps(
        &self,
        content: &[u8],
        decoder: &mut ifc_lite_core::EntityDecoder,
    ) -> std::sync::Arc<rustc_hash::FxHashMap<u32, ifc_lite_processing::style::FullIndexedColourMap>>
    {
        {
            let slot = self
                .cached_indexed_colour_maps
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(existing) = slot.as_ref() {
                return std::sync::Arc::clone(existing);
            }
        }

        let mut map: rustc_hash::FxHashMap<u32, ifc_lite_processing::style::FullIndexedColourMap> =
            rustc_hash::FxHashMap::default();
        // Fast bail-out for the overwhelming common case: files with no
        // IfcIndexedColourMap pay only a single substring search (SIMD memmem),
        // not a full entity scan + decode, on the first batch of every worker.
        // The empty result is still cached so later batches skip even that.
        if memchr::memmem::find(content, b"IFCINDEXEDCOLOURMAP").is_none() {
            let arc = std::sync::Arc::new(map);
            let mut slot = self
                .cached_indexed_colour_maps
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            *slot = Some(std::sync::Arc::clone(&arc));
            return arc;
        }
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        while let Some((_id, type_name, start, end)) = scanner.next_entity() {
            if type_name == "IFCINDEXEDCOLOURMAP" {
                if let Ok(icm) = decoder.decode_at(start, end) {
                    if let Some(full) =
                        ifc_lite_processing::style::resolve_indexed_colour_map_full(&icm, decoder)
                    {
                        map.entry(full.geometry_id).or_insert(full);
                    }
                }
            }
        }

        let arc = std::sync::Arc::new(map);
        let mut slot = self
            .cached_indexed_colour_maps
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = Some(std::sync::Arc::clone(&arc));
        arc
    }

    /// Resolve the file's plane-angle → radians scale once per worker and cache
    /// it. The underlying `EntityDecoder::plane_angle_to_radians()` walks the
    /// whole DATA section for `IFCPROJECT` (which IfcOpenShell emits near the
    /// end of the file) and caches only per-decoder — but `processGeometryBatch`
    /// builds a fresh decoder per call, so every batch would re-pay that
    /// O(file) scan. Callers seed the batch decoder with the cached value via
    /// `EntityDecoder::seed_unit_scales`.
    pub(crate) fn get_or_resolve_plane_angle(
        &self,
        decoder: &mut ifc_lite_core::EntityDecoder,
    ) -> f64 {
        {
            let slot = self
                .cached_plane_angle_to_radians
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(existing) = *slot {
                return existing;
            }
        }

        let scale = decoder.plane_angle_to_radians();

        let mut slot = self
            .cached_plane_angle_to_radians
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = Some(scale);
        scale
    }
}

impl Default for IfcAPI {
    fn default() -> Self {
        Self::new()
    }
}

/// Safely set a property on a JavaScript object.
/// Returns true if successful, false otherwise.
/// This avoids panicking on edge cases like non-extensible objects.
#[inline]
fn set_js_prop(obj: &JsValue, key: &str, value: &JsValue) -> bool {
    js_sys::Reflect::set(obj, &JsValue::from_str(key), value).unwrap_or(false)
}

#[cfg(test)] mod mod_tests;
