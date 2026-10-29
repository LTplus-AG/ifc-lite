// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! JavaScript API for IFC-Lite; feature methods live in focused child modules.

mod alignment_lines;
mod analytic_serialization;
mod appearance;
mod appearance_page;
mod appearance_atlas;
mod appearance_transfer;
mod annotation_plane;
mod captured_mesh;
mod appearance_calibration;
mod scan_outline;
mod scan_registration;
mod scan_proposals;
mod scan_segmentation;
mod pdf_vector;
mod bool2d;
mod clash;
mod clash_solid;
mod csg_diagnostics;
mod diagnose;
mod entity_index;
mod content_lifetime;
mod content_caches;
mod content_lazy;
mod extrusion_definitions;
mod export_data;
mod export_dfjson;
mod export_glb;
mod export_hbjson;
mod export_landxml;
mod export_obj;
mod export_step;
mod extract_profiles;
mod gpu_meshes;
mod grid_lines;
mod landxml;
mod landxml_stream;
mod mesh_outline;
mod overlay_frame;
mod parsing;
// Opt-in retained-geometry host contract over the private module-Worker executor.
#[cfg(all(feature = "retained-browser", target_arch = "wasm32"))]
mod retained_browser;
mod pipeline_diagnostics;
mod simplify;
mod swept_disk_descriptions;
mod space_plate;
mod space_plate_input;
pub(crate) mod styling;
mod symbolic;
mod zone_split;

use csg_diagnostics::{drain_and_log_csg_diagnostics, warn_refused_products};

use wasm_bindgen::prelude::*;

/// `TessellationQuality::Medium` as the atomic discriminant stored on
/// [`IfcAPI::tessellation_quality`] (0 = Lowest … 4 = Highest).
const TESSELLATION_QUALITY_MEDIUM: u8 = 2;

/// One content's `IfcIndexedColourMap` index (#858) and the don't-bake split
/// guard ids derived from it once (`style::indexed_colour_split_guard_ids`,
/// EDGE-WASM-5, #7691). Held in [`IfcAPI`]'s per-content cache slot.
pub(crate) struct IndexedColourCache {
    /// Geometry id → full per-triangle palette.
    pub(crate) maps:
        std::sync::Arc<rustc_hash::FxHashMap<u32, ifc_lite_processing::style::FullIndexedColourMap>>,
    /// Multi-colour face-set ids; `None` when no map paints more than one colour.
    pub(crate) split_guard_ids: Option<std::sync::Arc<rustc_hash::FxHashSet<u32>>>,
}

/// Main IFC-Lite API
#[wasm_bindgen]
pub struct IfcAPI {
    initialized: bool,
    content: content_caches::ContentState,

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

    /// Distinct refused record identities for the current load; repeated reads
    /// and batches are unioned before publishing the diagnostics counter.
    pipeline_refusals: std::sync::Mutex<rustc_hash::FxHashSet<u32>>,

    /// Per-load structured pipeline diagnostics (`PipelineDiagnostics`
    /// contract, see `api::pipeline_diagnostics`): every
    /// `processGeometryBatch*` call folds one batch record in — cheap
    /// counters plus per-batch JS wall time, so it is always on. Read by JS
    /// via `getPipelineDiagnostics`; reset at load START by every entry point
    /// that begins a new file on a reused IfcAPI (`buildPrePassOnce`,
    /// `buildPrePassStreaming`, `setEntityIndex`, `setSourceBytes`) - deliberately NOT by
    /// `clearPrePassCache`, which runs at end-of-load before a host reads the
    /// diagnostics.
    pipeline_diagnostics: std::sync::Mutex<ifc_lite_processing::PipelineDiagnosticsReport>,

}

#[wasm_bindgen]
impl IfcAPI {
    /// Create and initialize the IFC API
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        // MUST be `set_panic_hook()`, never `console_error_panic_hook::set_once()`
        // directly — that would replace init()'s panic-location stash. Idempotent.
        crate::utils::set_panic_hook();

        Self {
            initialized: true,
            content: Default::default(),
            merge_layers: std::sync::atomic::AtomicBool::new(false),
            compute_geometry_hashes: std::sync::atomic::AtomicBool::new(false),
            geometry_hash_tolerance_bits: std::sync::atomic::AtomicU64::new(
                ifc_lite_geometry::DEFAULT_GEOM_HASH_TOLERANCE.to_bits(),
            ),
            tessellation_quality: std::sync::atomic::AtomicU8::new(TESSELLATION_QUALITY_MEDIUM),
            skip_small_cuts: std::sync::atomic::AtomicBool::new(false),
            pipeline_refusals: std::sync::Mutex::default(),
            pipeline_diagnostics: std::sync::Mutex::new(
                ifc_lite_processing::PipelineDiagnosticsReport::default(),
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
        self.clear_content_derived();
        self.content.cached_source_bytes.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        self.clear_style_finishes();
        // Keep diagnostics readable after the JS wrapper's finally cleanup.
    }

    /// Install the pre-computed set of `IfcRepresentationMap` ids referenced by
    /// an `IfcMappedItem` (issue #957), so the worker's first type-product batch
    /// skips the full-file walk once [`Self::set_instantiated_type_ids`] is also installed. The streaming pre-pass built
    /// the same set once from its `IfcMappedItem` spans and ships the
    /// id list here — bit-identical to what each worker would compute, since a
    /// set's membership is order-invariant and consumers only call `.contains`.
    ///
    /// Installed AFTER `setEntityIndex` (which clears this cache on content
    /// swap), so the injected value survives. When this setter is never called
    /// (native path, non-streaming callers), the lazy build path is unchanged.
    #[wasm_bindgen(js_name = setReferencedRepmaps)]
    pub fn set_referenced_repmaps(&self, ids: &[u32]) {
        self.content.cached_type_geometry_plan.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        let set: rustc_hash::FxHashSet<u32> = ids.iter().copied().collect();
        let mut slot = self.content.cached_referenced_repmaps
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = Some(std::sync::Arc::new(set));
    }

    /// Install the pre-computed set of type ids that an `IfcRelDefinesByType`
    /// instantiates (#957 follow-up), so the worker's first type-product batch
    /// skips the full-file walk once both precomputed sets are installed. Same injection contract as [`Self::set_referenced_repmaps`].
    #[wasm_bindgen(js_name = setInstantiatedTypeIds)]
    pub fn set_instantiated_type_ids(&self, ids: &[u32]) {
        self.content.cached_type_geometry_plan.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        let set: rustc_hash::FxHashSet<u32> = ids.iter().copied().collect();
        let mut slot = self.content.cached_instantiated_type_ids
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = Some(std::sync::Arc::new(set));
    }

    /// Install the pre-computed #1623 Phase 3 don't-bake plan: the flat list of
    /// `IfcRepresentationMap` ids that an `IfcMappedItem` instantiates >= 2 times.
    /// The streaming pre-pass tallies it in the SAME scan that builds the referenced-
    /// repmap set and ships the id
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
        let mut slot = self.content.cached_mapped_instance_plan
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
        // A malformed buffer is refused (#7675). Clearing the slot (never
        // keeping an earlier load's index) leaves the per-worker lazy build in
        // charge, which is correct, just slower.
        let index = ifc_lite_geometry::MaterialLayerIndex::from_flat(
            element_ids,
            axis,
            layer_counts,
            direction_sense,
            offset,
            layer_material_ids,
            layer_thicknesses,
        );
        let mut slot = self.content.cached_material_layer_index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = index.map(std::sync::Arc::new);
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
        let mut parts_slot = self.content.cached_parts_to_skip
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
    /// Pass a positive `tolerance` (metres) to enable — the quantization grid
    /// positions snap to (larger tolerates more float noise, smaller catches
    /// finer edits; below the `f32` precision floor of model-local coordinates,
    /// ~1 mm, mostly hashes noise). Finer than
    /// `ifc_lite_geometry::MIN_GEOM_HASH_TOLERANCE` (1e-6 m) is clamped up to it
    /// — see that constant's doc for why (an `i128` overflow surface, not a
    /// precision win). `null`/`undefined`/non-positive disables. Default: off.
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
        self.content.cached_mapped_item
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
        self.content.cached_mapped_item
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

#[cfg(all(feature = "retained-browser", target_arch = "wasm32"))]
mod retained_model;
#[cfg(all(feature = "retained-browser", target_arch = "wasm32"))]
mod retained_presentation;

#[cfg(all(feature = "retained-browser", target_arch = "wasm32"))]
mod retained_session;
