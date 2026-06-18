// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! JavaScript API for IFC-Lite
//!
//! Modern async/await API for parsing IFC files.

mod alignment_lines;
mod clash;
mod extract_profiles;
mod gpu_meshes;
mod grid_lines;
mod mesh_outline;
mod parsing;
mod space_plate;
pub(crate) mod styling;
mod symbolic;

pub use clash::{ClashRunResult, ClashSession};

use ifc_lite_core::EntityIndex;
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
    /// Wrapped in `Arc` so successive `processGeometryBatch` calls reuse it
    /// without cloning the (~14 M-entry, ~600 MB) FxHashMap on every call.
    /// The streaming pre-pass calls `processGeometryBatch` dozens of times
    /// per worker — the previous `RefCell<Option<EntityIndex>>::clone()`
    /// path made each call effectively a full HashMap copy.
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
    cached_entity_index: std::sync::Mutex<Option<std::sync::Arc<EntityIndex>>>,

    /// Per-worker shared content-dedup cache (#1109 follow-up). The
    /// `GeometryRouter` is rebuilt every `processGeometryBatch`, so its item-mesh
    /// dedup cache would reset each batch. Holding ONE cache here and injecting it
    /// into every batch router lets byte-identical geometry mesh once across the
    /// whole worker's workload — e.g. Tekla connection plates/bolts the exporter
    /// emitted as thousands of separate items instead of one `IfcMappedItem`.
    /// Built lazily on first batch; one model per `IfcApi` instance, exactly like
    /// `cached_entity_index`.
    cached_item_dedup: std::sync::Mutex<Option<ifc_lite_geometry::ItemDedupCache>>,

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
            cached_item_dedup: std::sync::Mutex::new(None),
            merge_layers: std::sync::atomic::AtomicBool::new(false),
            cached_parts_to_skip: std::sync::Mutex::new(None),
            cached_material_layer_index: std::sync::Mutex::new(None),
            cached_referenced_repmaps: std::sync::Mutex::new(None),
            cached_instantiated_type_ids: std::sync::Mutex::new(None),
            cached_texture_index: std::sync::Mutex::new(None),
            cached_indexed_colour_maps: std::sync::Mutex::new(None),
            compute_geometry_hashes: std::sync::atomic::AtomicBool::new(false),
            geometry_hash_tolerance_bits: std::sync::atomic::AtomicU64::new(
                ifc_lite_geometry::DEFAULT_GEOM_HASH_TOLERANCE.to_bits(),
            ),
            tessellation_quality: std::sync::atomic::AtomicU8::new(TESSELLATION_QUALITY_MEDIUM),
            cached_plane_angle_to_radians: std::sync::Mutex::new(None),
            cached_geometry_styles: std::sync::Mutex::new(None),
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
    /// Panics if the cache Mutex is poisoned. Poisoning means an
    /// earlier panic occurred while the lock was held — silently
    /// continuing would mean operating on an inconsistent cache, so
    /// fail fast.
    #[wasm_bindgen(js_name = clearPrePassCache)]
    pub fn clear_pre_pass_cache(&self) {
        let mut slot = self
            .cached_entity_index
            .lock()
            .expect("ifc-lite cached_entity_index Mutex poisoned");
        slot.take();
        // The parts-to-skip set is keyed off the content scanned during
        // the previous load; drop it together with the entity index so the
        // next file's first batch call rebuilds against fresh content.
        let mut parts_slot = self
            .cached_parts_to_skip
            .lock()
            .expect("ifc-lite cached_parts_to_skip Mutex poisoned");
        parts_slot.take();
        // The material-layer index is keyed off the previous load's content.
        self.cached_material_layer_index
            .lock()
            .expect("ifc-lite cached_material_layer_index Mutex poisoned")
            .take();
        // The referenced-RepresentationMap set is keyed off the previous load's
        // content; drop it so the next file rebuilds against fresh content.
        let mut repmap_slot = self
            .cached_referenced_repmaps
            .lock()
            .expect("ifc-lite cached_referenced_repmaps Mutex poisoned");
        repmap_slot.take();
        // The instantiated-type-ids set is keyed off the previous load's content.
        let mut inst_slot = self
            .cached_instantiated_type_ids
            .lock()
            .expect("ifc-lite cached_instantiated_type_ids Mutex poisoned");
        inst_slot.take();
        // The texture index is keyed off the previous load's content; drop it.
        let mut texture_slot = self
            .cached_texture_index
            .lock()
            .expect("ifc-lite cached_texture_index Mutex poisoned");
        texture_slot.take();
        // The indexed-colour-map index is also keyed off the previous load's
        // content; drop it so the next file rebuilds against fresh content.
        let mut icm_slot = self
            .cached_indexed_colour_maps
            .lock()
            .expect("ifc-lite cached_indexed_colour_maps Mutex poisoned");
        icm_slot.take();
        // The plane-angle scale belongs to the previous load's content.
        self.cached_plane_angle_to_radians
            .lock()
            .expect("ifc-lite cached_plane_angle_to_radians Mutex poisoned")
            .take();
        // The geometry-style maps belong to the previous load's wire styles.
        self.cached_geometry_styles
            .lock()
            .expect("ifc-lite cached_geometry_styles Mutex poisoned")
            .take();
        // The content-dedup cache holds the previous model's item meshes, keyed by
        // a content hash of that model's entities. Drop it so a new file on the
        // same reused IfcAPI starts with an empty cache (bounds memory across
        // loads; defensive even though the key is content- not id-based).
        self.cached_item_dedup
            .lock()
            .expect("ifc-lite cached_item_dedup Mutex poisoned")
            .take();
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
    /// Building an `FxHashMap` from the three input slices costs ~1 s on
    /// 14 M entries — about 4–5× faster than re-scanning the file. After
    /// this call, the next `processGeometryBatch` skips the lazy build
    /// branch and reuses the populated cache by `Arc::clone()`.
    ///
    /// `lengths[i]` is the byte length of entity `ids[i]`, so the cache
    /// stores `(start, start + length)` to match the existing tuple layout.
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
        let mut index = ifc_lite_core::EntityIndex::with_capacity_and_hasher(n, Default::default());
        for i in 0..n {
            let start = starts[i] as usize;
            let length = lengths[i] as usize;
            index.insert(ids[i], (start, start + length));
        }
        let mut slot = self
            .cached_entity_index
            .lock()
            .expect("ifc-lite cached_entity_index Mutex poisoned");
        *slot = Some(std::sync::Arc::new(index));
        drop(slot);

        // Swapping the entity index means a different file. The other caches are
        // content-scoped (keyed off the previous load) — carrying them into the
        // next file would wrongly suppress/keep orphan type geometry, reuse a
        // stale texture index, or skip the wrong parts. Drop them so they
        // rebuild against the new content (#962 review). Mirrors clearPrePassCache.
        self.cached_parts_to_skip
            .lock()
            .expect("ifc-lite cached_parts_to_skip Mutex poisoned")
            .take();
        self.cached_material_layer_index
            .lock()
            .expect("ifc-lite cached_material_layer_index Mutex poisoned")
            .take();
        self.cached_referenced_repmaps
            .lock()
            .expect("ifc-lite cached_referenced_repmaps Mutex poisoned")
            .take();
        self.cached_instantiated_type_ids
            .lock()
            .expect("ifc-lite cached_instantiated_type_ids Mutex poisoned")
            .take();
        self.cached_texture_index
            .lock()
            .expect("ifc-lite cached_texture_index Mutex poisoned")
            .take();
        self.cached_indexed_colour_maps
            .lock()
            .expect("ifc-lite cached_indexed_colour_maps Mutex poisoned")
            .take();
        self.cached_plane_angle_to_radians
            .lock()
            .expect("ifc-lite cached_plane_angle_to_radians Mutex poisoned")
            .take();
        // The geometry-style maps belong to the previous load's wire styles —
        // drop them on content swap so a reused IfcAPI can't reuse a stale map
        // (the (len,first,last) signature would otherwise collide rarely).
        self.cached_geometry_styles
            .lock()
            .expect("ifc-lite cached_geometry_styles Mutex poisoned")
            .take();
        // The content-dedup cache holds the previous model's item meshes — drop it
        // on content swap so a reused IfcAPI starts the new file with an empty
        // cache (bounds memory across loads).
        self.cached_item_dedup
            .lock()
            .expect("ifc-lite cached_item_dedup Mutex poisoned")
            .take();
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
            .expect("ifc-lite cached_parts_to_skip Mutex poisoned");
        parts_slot.take();
    }

    /// Enable or disable the PARAMETRIC rectangular-opening fast path (the
    /// placement-frame, ground-truth-exact analytic cut) for `processGeometryBatch`.
    ///
    /// DEFAULT OFF. This is the wasm-side toggle that lets native and wasm flip the
    /// flag in LOCKSTEP — the byte-identical native==wasm contract requires both
    /// targets take the same path, and wasm has no env to read `IFC_LITE_RECT_PARAM`.
    /// The path subtracts rectangular openings as exact parametric boxes in the host's
    /// own placement frame (rotated walls included), deferring any non-clean case to
    /// the exact kernel. Pass `true` before `processGeometryBatch`.
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
        Ok(())
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
        match self
            .tessellation_quality
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            idx => TessellationQuality::from_index(idx),
        }
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
    /// `processGeometryBatch` when the
    /// merge-layers toggle is on. Two full-file scans (`MaterialLayerIndex`
    /// + `propagate_voids_to_parts`) are amortised across every batch on
    /// the same content; first-call cost ~one IFC re-scan, subsequent
    /// calls are an `Arc::clone`.
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
                .expect("ifc-lite cached_parts_to_skip Mutex poisoned");
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
            .expect("ifc-lite cached_parts_to_skip Mutex poisoned");
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
                .expect("ifc-lite cached_material_layer_index Mutex poisoned");
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
        let has_layer_set = content.len() >= LAYER_SET_KW.len()
            && content.windows(LAYER_SET_KW.len()).any(|w| w == LAYER_SET_KW);
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
            .expect("ifc-lite cached_material_layer_index Mutex poisoned");
        *slot = Some(std::sync::Arc::clone(&arc));
        arc
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
                .expect("ifc-lite cached_referenced_repmaps Mutex poisoned");
            if let Some(existing) = slot.as_ref() {
                return std::sync::Arc::clone(existing);
            }
        }

        let referenced = styling::build_referenced_representation_maps(content, decoder);

        let arc = std::sync::Arc::new(referenced);
        let mut slot = self
            .cached_referenced_repmaps
            .lock()
            .expect("ifc-lite cached_referenced_repmaps Mutex poisoned");
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
                .expect("ifc-lite cached_instantiated_type_ids Mutex poisoned");
            if let Some(existing) = slot.as_ref() {
                return std::sync::Arc::clone(existing);
            }
        }

        let instantiated = styling::build_instantiated_type_ids(content, decoder);

        let arc = std::sync::Arc::new(instantiated);
        let mut slot = self
            .cached_instantiated_type_ids
            .lock()
            .expect("ifc-lite cached_instantiated_type_ids Mutex poisoned");
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
                .expect("ifc-lite cached_texture_index Mutex poisoned");
            if let Some(existing) = slot.as_ref() {
                return std::sync::Arc::clone(existing);
            }
        }

        let index = ifc_lite_geometry::build_texture_index(content, decoder);

        let arc = std::sync::Arc::new(index);
        let mut slot = self
            .cached_texture_index
            .lock()
            .expect("ifc-lite cached_texture_index Mutex poisoned");
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
                .expect("ifc-lite cached_indexed_colour_maps Mutex poisoned");
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
        if !content
            .windows(b"IFCINDEXEDCOLOURMAP".len())
            .any(|window| window == b"IFCINDEXEDCOLOURMAP")
        {
            let arc = std::sync::Arc::new(map);
            let mut slot = self
                .cached_indexed_colour_maps
                .lock()
                .expect("ifc-lite cached_indexed_colour_maps Mutex poisoned");
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
            .expect("ifc-lite cached_indexed_colour_maps Mutex poisoned");
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
                .expect("ifc-lite cached_plane_angle_to_radians Mutex poisoned");
            if let Some(existing) = *slot {
                return existing;
            }
        }

        let scale = decoder.plane_angle_to_radians();

        let mut slot = self
            .cached_plane_angle_to_radians
            .lock()
            .expect("ifc-lite cached_plane_angle_to_radians Mutex poisoned");
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

/// Safely set a property on a JavaScript object using JsValue key.
/// Returns true if successful, false otherwise.
#[inline]
fn set_js_prop_jv(obj: &JsValue, key: &JsValue, value: &JsValue) -> bool {
    js_sys::Reflect::set(obj, key, value).unwrap_or(false)
}

/// Drain CSG / opening-classification / per-host diagnostics from the
/// router and emit them to the browser console. Returns a JS object
/// summarising what was logged so callers can stash it on a completion
/// callback's stats payload.
///
/// Always emits the classifier summary at `console.debug`; emits the
/// failure summary at `console.warn` only when there's at least one
/// failure to report. Per-host detail is included for the worst-failing
/// products (capped to keep the log readable on large files).
pub(super) fn drain_and_log_csg_diagnostics(
    router: &ifc_lite_geometry::GeometryRouter,
    // Failures already drained per element by the canonical producer
    // (`ifc_lite_processing::element` empties the warm batch router after
    // every element so failures can't bleed between elements). Merged with
    // whatever still sits on the router (non-canonical paths).
    collected_failures: rustc_hash::FxHashMap<u32, Vec<ifc_lite_geometry::BoolFailure>>,
) -> JsValue {
    let cls = router.take_classification_stats();
    let mut csg_failures = router.take_csg_failures();
    for (product_id, fails) in collected_failures {
        csg_failures.entry(product_id).or_default().extend(fails);
    }
    let host_diags = router.take_host_opening_diagnostics();

    let cls_total = cls.rectangular + cls.diagonal + cls.non_rectangular;
    let total_failures: usize = csg_failures.values().map(|v| v.len()).sum();

    // Only emit the headline at WARN level when the kernel actually
    // dropped a cut. Zero-failure parses shouldn't spam every embedded
    // viewer. The full diagnostics summary is still returned to JS so
    // callers can opt into deeper inspection.
    if total_failures > 0 {
        web_sys::console::warn_1(
            &format!(
                "[IFC-LITE] CSG diagnostics: {cls_total} openings classified, \
                 {total_failures} failures, {} hosts tracked",
                host_diags.len()
            )
            .into(),
        );
    }

    let cls_obj = js_sys::Object::new();
    set_js_prop(&cls_obj, "rectangular", &(cls.rectangular as f64).into());
    set_js_prop(&cls_obj, "diagonal", &(cls.diagonal as f64).into());
    set_js_prop(
        &cls_obj,
        "nonRectangular",
        &(cls.non_rectangular as f64).into(),
    );
    set_js_prop(
        &cls_obj,
        "floorOpeningGuardSaved",
        &(cls.floor_opening_guard_saved as f64).into(),
    );
    set_js_prop(&cls_obj, "total", &(cls_total as f64).into());

    if cls_total > 0 {
        // info_1, not debug_1 — DevTools hides `debug` by default ("Verbose"
        // log level), so a debug-only summary effectively never reaches
        // users investigating a model. The classifier headline + per-host
        // roll-up are always emitted at `info` so they show up in the
        // default "All levels" view; the noisy detail (failure breakdown,
        // worst-failing list) stays at `warn` and only fires when there
        // is a failure to surface.
        web_sys::console::info_1(
            &format!(
                "[IFC-LITE] Opening classifier: rect={} diag={} non_rect={} \
                 floor_opening_guard_saved={} (total={cls_total})",
                cls.rectangular, cls.diagonal, cls.non_rectangular, cls.floor_opening_guard_saved
            )
            .into(),
        );
    }

    let products_with_failures = csg_failures.len();

    let summary = js_sys::Object::new();
    set_js_prop(&summary, "classification", &cls_obj);
    set_js_prop(&summary, "totalFailures", &(total_failures as f64).into());
    set_js_prop(
        &summary,
        "productsWithFailures",
        &(products_with_failures as f64).into(),
    );
    set_js_prop(
        &summary,
        "hostsWithOpenings",
        &(host_diags.len() as f64).into(),
    );

    if total_failures > 0 || !host_diags.is_empty() {
        // Per-reason breakdown for the warn line.
        let mut by_reason: std::collections::HashMap<&'static str, usize> =
            std::collections::HashMap::new();
        for fails in csg_failures.values() {
            for f in fails {
                *by_reason.entry(f.reason.label()).or_insert(0) += 1;
            }
        }
        let mut breakdown: Vec<(&'static str, usize)> = by_reason.into_iter().collect();
        breakdown.sort_by(|a, b| b.1.cmp(&a.1));

        // Per-host-type aggregate: how many of each host type had openings,
        // how many had failures, and which kinds dominated.
        let mut by_host_type: std::collections::HashMap<
            String,
            (usize, usize, usize, usize, usize),
        > = std::collections::HashMap::new();
        for hd in host_diags.values() {
            let entry = by_host_type
                .entry(hd.host_type.clone())
                .or_insert((0, 0, 0, 0, 0));
            entry.0 += 1; // hosts
            entry.1 += hd.openings.len(); // openings
            for op in &hd.openings {
                match op.kind {
                    ifc_lite_geometry::OpeningKindDiag::Rectangular => entry.2 += 1,
                    ifc_lite_geometry::OpeningKindDiag::Diagonal => entry.3 += 1,
                    ifc_lite_geometry::OpeningKindDiag::NonRectangular => entry.4 += 1,
                }
            }
        }
        let mut host_type_lines: Vec<String> = by_host_type
            .iter()
            .map(|(t, c)| {
                format!(
                    "{t}: hosts={} openings={} (rect={} diag={} non_rect={})",
                    c.0, c.1, c.2, c.3, c.4
                )
            })
            .collect();
        host_type_lines.sort();

        // Worst-failing hosts: top 10 by csg_failure_count.
        let mut worst: Vec<(u32, &ifc_lite_geometry::HostOpeningDiagnostic)> =
            host_diags.iter().map(|(k, v)| (*k, v)).collect();
        worst.sort_by(|a, b| b.1.csg_failure_count.cmp(&a.1.csg_failure_count));
        let worst_lines: Vec<String> = worst
            .iter()
            .take(10)
            .filter(|(_, hd)| hd.csg_failure_count > 0)
            .map(|(pid, hd)| {
                let kinds: Vec<&str> = hd.openings.iter().map(|o| o.kind.as_str()).collect();
                format!(
                    "  #{pid} {} — {} openings [{}], {} CSG failure(s) ({})",
                    hd.host_type,
                    hd.openings.len(),
                    kinds.join(","),
                    hd.csg_failure_count,
                    hd.first_failure_label.as_deref().unwrap_or("?"),
                )
            })
            .collect();

        // Silent-no-op detection: hosts where `apply_void_context` ran
        // but the triangle count came out unchanged despite having
        // rectangular boxes to cut. Strong signal that the box geometry
        // didn't intersect the host (placement bug, transform issue,
        // wrong opening shape) — the AABB clip path doesn't record a
        // BoolFailure because the kernel never engages.
        let mut silent_noops: Vec<(u32, &ifc_lite_geometry::HostOpeningDiagnostic)> = host_diags
            .iter()
            .filter_map(|(pid, hd)| {
                let before = hd.tris_before?;
                let after = hd.tris_after?;
                if before == after && hd.rect_boxes_processed > 0 {
                    Some((*pid, hd))
                } else {
                    None
                }
            })
            .collect();
        silent_noops.sort_by(|a, b| b.1.rect_boxes_processed.cmp(&a.1.rect_boxes_processed));
        let silent_noop_total = silent_noops.len();
        let silent_noop_lines: Vec<String> = silent_noops
            .iter()
            .take(8)
            .map(|(pid, hd)| {
                let bounds = hd
                    .host_bounds
                    .map(|((x0, y0, z0), (x1, y1, z1))| {
                        format!(
                            "host bounds=({:.2},{:.2},{:.2})..({:.2},{:.2},{:.2})",
                            x0, y0, z0, x1, y1, z1
                        )
                    })
                    .unwrap_or_else(|| "host bounds=?".into());
                format!(
                    "  #{pid} {} — {} rect boxes, tris={}→{} (NO CHANGE), {}",
                    hd.host_type,
                    hd.rect_boxes_processed,
                    hd.tris_before.unwrap_or(0),
                    hd.tris_after.unwrap_or(0),
                    bounds,
                )
            })
            .collect();

        // Surface silent-no-ops at warn level whenever any are detected,
        // independent of CSG failure count. This is the highest-signal
        // diagnostic for a "0 failures but visually un-cut" model like
        // Smiley-West — the cut pipeline ran clean but the geometry
        // came out unchanged.
        if silent_noop_total > 0 {
            web_sys::console::warn_1(
                &format!(
                    "[IFC-LITE] Rectangular cut SILENT NO-OP on {silent_noop_total} hosts \
                     (rect boxes processed but mesh unchanged — likely opening box \
                     doesn't intersect host). Top {} (by box count):\n{}",
                    silent_noop_lines.len(),
                    silent_noop_lines.join("\n"),
                )
                .into(),
            );
        }

        if total_failures > 0 {
            web_sys::console::warn_1(
                &format!(
                    "[IFC-LITE] CSG fallbacks: {total_failures} failures across \
                     {products_with_failures} products. \
                     Breakdown: {breakdown:?}.\n\
                     By host type:\n  {}\n\
                     Worst-failing hosts (top 10):\n{}",
                    host_type_lines.join("\n  "),
                    if worst_lines.is_empty() {
                        "  (none)".into()
                    } else {
                        worst_lines.join("\n")
                    },
                )
                .into(),
            );
        } else {
            // No failures but we still have host data. info_1 (not debug)
            // so devs can confirm at a glance that the void-subtraction
            // path engaged for this model and which host types had
            // openings.
            web_sys::console::info_1(
                &format!(
                    "[IFC-LITE] Opening pipeline: 0 CSG failures. \
                     {} hosts with openings.\n  {}",
                    host_diags.len(),
                    host_type_lines.join("\n  "),
                )
                .into(),
            );
        }
    }

    // rect_fast (analytic rectangular-opening fast path) engagement for this
    // batch: fire-rate + why it deferred, so the optimization is VISIBLE in the
    // console. Absence of this line on a build that has it means nothing fired
    // AND nothing deferred (no rect-opening hosts in the batch); presence with
    // fired=0 + high host_not_box means the walls aren't clean axis-aligned
    // boxes (multi-layer / non-box) and correctly fell back to the exact kernel.
    let rf = ifc_lite_geometry::rect_fast::take_global_stats();
    if rf.fired > 0
        || rf.defer_host_not_box > 0
        || rf.defer_not_through > 0
        || rf.defer_off_face > 0
        || rf.defer_near_edge > 0
    {
        web_sys::console::info_1(
            &format!(
                "[IFC-LITE] rect_fast: fired={} (cut {} openings) | deferred: \
                 host_not_box={} not_through={} off_face={} near_edge={}",
                rf.fired,
                rf.openings_cut,
                rf.defer_host_not_box,
                rf.defer_not_through,
                rf.defer_off_face,
                rf.defer_near_edge,
            )
            .into(),
        );
    }

    summary.into()
}

/// Convert entity counts map to JavaScript object
fn counts_to_js(counts: &rustc_hash::FxHashMap<String, usize>) -> JsValue {
    let obj = js_sys::Object::new();

    for (type_name, count) in counts {
        let key = JsValue::from_str(type_name.as_str());
        let value = JsValue::from_f64(*count as f64);
        set_js_prop_jv(&obj, &key, &value);
    }

    obj.into()
}
