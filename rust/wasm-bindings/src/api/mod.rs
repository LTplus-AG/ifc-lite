// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! JavaScript API for IFC-Lite
//!
//! Modern async/await API for parsing IFC files.

mod debug;
mod extract_profiles;
mod georef;
mod gpu_meshes;
mod parsing;
pub(crate) mod styling;
mod symbolic;
mod zero_copy_api;

use crate::zero_copy::{MeshCollection, MeshDataJs};
use ifc_lite_core::{EntityIndex, GeoReference, RtcOffset};
use wasm_bindgen::prelude::*;

/// Georeferencing information exposed to JavaScript
#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct GeoReferenceJs {
    /// CRS name (e.g., "EPSG:32632")
    #[wasm_bindgen(skip)]
    pub crs_name: Option<String>,
    /// Eastings (X offset)
    pub eastings: f64,
    /// Northings (Y offset)
    pub northings: f64,
    /// Orthogonal height (Z offset)
    pub orthogonal_height: f64,
    /// X-axis abscissa (cos of rotation)
    pub x_axis_abscissa: f64,
    /// X-axis ordinate (sin of rotation)
    pub x_axis_ordinate: f64,
    /// Scale factor
    pub scale: f64,
}

#[wasm_bindgen]
impl GeoReferenceJs {
    /// Get CRS name
    #[wasm_bindgen(getter, js_name = crsName)]
    pub fn crs_name(&self) -> Option<String> {
        self.crs_name.clone()
    }

    /// Get rotation angle in radians
    #[wasm_bindgen(getter)]
    pub fn rotation(&self) -> f64 {
        self.x_axis_ordinate.atan2(self.x_axis_abscissa)
    }

    /// Transform local coordinates to map coordinates
    #[wasm_bindgen(js_name = localToMap)]
    pub fn local_to_map(&self, x: f64, y: f64, z: f64) -> Vec<f64> {
        let cos_r = self.x_axis_abscissa;
        let sin_r = self.x_axis_ordinate;
        let s = self.scale;

        let e = s * (cos_r * x - sin_r * y) + self.eastings;
        let n = s * (sin_r * x + cos_r * y) + self.northings;
        let h = z + self.orthogonal_height;

        vec![e, n, h]
    }

    /// Transform map coordinates to local coordinates
    #[wasm_bindgen(js_name = mapToLocal)]
    pub fn map_to_local(&self, e: f64, n: f64, h: f64) -> Vec<f64> {
        let cos_r = self.x_axis_abscissa;
        let sin_r = self.x_axis_ordinate;
        let inv_scale = if self.scale.abs() < f64::EPSILON {
            1.0
        } else {
            1.0 / self.scale
        };

        let dx = e - self.eastings;
        let dy = n - self.northings;

        let x = inv_scale * (cos_r * dx + sin_r * dy);
        let y = inv_scale * (-sin_r * dx + cos_r * dy);
        let z = h - self.orthogonal_height;

        vec![x, y, z]
    }

    /// Get 4x4 transformation matrix (column-major for WebGL)
    #[wasm_bindgen(js_name = toMatrix)]
    pub fn to_matrix(&self) -> Vec<f64> {
        let cos_r = self.x_axis_abscissa;
        let sin_r = self.x_axis_ordinate;
        let s = self.scale;

        vec![
            s * cos_r,
            s * sin_r,
            0.0,
            0.0,
            -s * sin_r,
            s * cos_r,
            0.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            self.eastings,
            self.northings,
            self.orthogonal_height,
            1.0,
        ]
    }
}

impl From<GeoReference> for GeoReferenceJs {
    fn from(geo: GeoReference) -> Self {
        Self {
            crs_name: geo.crs_name,
            eastings: geo.eastings,
            northings: geo.northings,
            orthogonal_height: geo.orthogonal_height,
            x_axis_abscissa: geo.x_axis_abscissa,
            x_axis_ordinate: geo.x_axis_ordinate,
            scale: geo.scale,
        }
    }
}

/// RTC offset information exposed to JavaScript
#[wasm_bindgen]
#[derive(Debug, Clone, Default)]
pub struct RtcOffsetJs {
    /// X offset (subtracted from positions)
    pub x: f64,
    /// Y offset
    pub y: f64,
    /// Z offset
    pub z: f64,
}

#[wasm_bindgen]
impl RtcOffsetJs {
    /// Check if offset is significant (>10km)
    #[wasm_bindgen(js_name = isSignificant)]
    pub fn is_significant(&self) -> bool {
        const THRESHOLD: f64 = 10000.0;
        self.x.abs() > THRESHOLD || self.y.abs() > THRESHOLD || self.z.abs() > THRESHOLD
    }

    /// Convert local coordinates to world coordinates
    #[wasm_bindgen(js_name = toWorld)]
    pub fn to_world(&self, x: f64, y: f64, z: f64) -> Vec<f64> {
        vec![x + self.x, y + self.y, z + self.z]
    }
}

impl From<RtcOffset> for RtcOffsetJs {
    fn from(offset: RtcOffset) -> Self {
        Self {
            x: offset.x,
            y: offset.y,
            z: offset.z,
        }
    }
}

/// Statistics tracking for geometry parsing
#[derive(Default)]
struct GeometryStats {
    total: u32,
    success: u32,
    decode_failed: u32,
    no_representation: u32,
    process_failed: u32,
    empty_mesh: u32,
    outlier_filtered: u32,
}

/// Mesh collection with RTC offset for large coordinates
#[wasm_bindgen]
pub struct MeshCollectionWithRtc {
    meshes: MeshCollection,
    rtc_offset: RtcOffsetJs,
}

#[wasm_bindgen]
impl MeshCollectionWithRtc {
    /// Get the mesh collection
    #[wasm_bindgen(getter)]
    pub fn meshes(&self) -> MeshCollection {
        self.meshes.clone()
    }

    /// Get the RTC offset
    #[wasm_bindgen(getter, js_name = rtcOffset)]
    pub fn rtc_offset(&self) -> RtcOffsetJs {
        self.rtc_offset.clone()
    }

    /// Get number of meshes
    #[wasm_bindgen(getter)]
    pub fn length(&self) -> usize {
        self.meshes.len()
    }

    /// Get mesh at index
    pub fn get(&self, index: usize) -> Option<MeshDataJs> {
        self.meshes.get(index)
    }
}

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

    /// When `true`, the `parseMeshes*` family suppresses geometry emission for
    /// every `IfcBuildingElementPart` whose `IfcRelAggregates` parent (a) has
    /// its own `Representation` and (b) is marked `Sliceable` in
    /// `MaterialLayerIndex`. The parent wall's single solid then carries the
    /// per-layer colour slices instead of N separate part meshes. Defaults to
    /// `false` (existing behaviour). See issue #540.
    ///
    /// Stored as an atomic so it can be toggled from JS between parse calls
    /// without locking — all parse paths read it once at the top.
    merge_layers: std::sync::atomic::AtomicBool,

    /// Lazily-built skip set used by `processGeometryBatch` and
    /// `processGeometryBatchParallel` when `merge_layers` is on. The set
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
            merge_layers: std::sync::atomic::AtomicBool::new(false),
            cached_parts_to_skip: std::sync::Mutex::new(None),
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
        let mut index =
            ifc_lite_core::EntityIndex::with_capacity_and_hasher(n, Default::default());
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
    /// When `enabled` is `true`, every subsequent `parseMeshes*` call will
    /// suppress geometry emission for `IfcBuildingElementPart` entities whose
    /// `IfcRelAggregates` parent wall is sliceable (has an
    /// `IfcMaterialLayerSetUsage`) AND has its own `Representation`. The
    /// parent wall keeps its per-layer sub-mesh colouring, so the visual
    /// result is the same as the layered render but with one mesh per wall
    /// instead of one per layer part — much cheaper for both CPU and GPU.
    ///
    /// Default is `false`. Pass `true` before calling `parseMeshes`,
    /// `parseMeshesSubset`, `parseMeshesAsync`, `parseMeshesInstanced`, or
    /// `parseMeshesInstancedAsync`.
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
}

impl IfcAPI {
    /// Internal accessor used by the parse pipelines to decide whether to
    /// skip `IfcBuildingElementPart` emission. Not exposed to JS — JS
    /// callers control the flag via [`Self::set_merge_layers`].
    pub(crate) fn merge_layers(&self) -> bool {
        self.merge_layers
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Get or lazily build the cached parts-to-skip set used by
    /// `processGeometryBatch` and `processGeometryBatchParallel` when the
    /// merge-layers toggle is on. Two full-file scans (`MaterialLayerIndex`
    /// + `propagate_voids_to_parts`) are amortised across every batch on
    /// the same content; first-call cost ~one IFC re-scan, subsequent
    /// calls are an `Arc::clone`.
    ///
    /// Returns an empty set when no eligible parts exist — callers can
    /// still cheaply test `parts.contains(&id)` without a branch.
    pub(crate) fn get_or_build_parts_to_skip(
        &self,
        content: &str,
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

        let material_layer_index =
            ifc_lite_geometry::MaterialLayerIndex::from_content(content, decoder);
        let mut void_index_scratch: rustc_hash::FxHashMap<u32, Vec<u32>> =
            rustc_hash::FxHashMap::default();
        let part_to_parent = ifc_lite_geometry::propagate_voids_to_parts(
            &mut void_index_scratch,
            content,
            decoder,
        );
        let skip_set: rustc_hash::FxHashSet<u32> = part_to_parent
            .into_iter()
            .filter(|(_, parent_id)| material_layer_index.is_sliceable(*parent_id))
            .map(|(part_id, _)| part_id)
            .collect();

        let arc = std::sync::Arc::new(skip_set);
        let mut slot = self
            .cached_parts_to_skip
            .lock()
            .expect("ifc-lite cached_parts_to_skip Mutex poisoned");
        *slot = Some(std::sync::Arc::clone(&arc));
        arc
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
) -> JsValue {
    let cls = router.take_classification_stats();
    let csg_failures = router.take_csg_failures();
    let host_diags = router.take_host_opening_diagnostics();

    let cls_total = cls.rectangular + cls.diagonal + cls.non_rectangular;
    let total_failures: usize = csg_failures.values().map(|v| v.len()).sum();

    // Unconditional one-line "I ran" tag at WARN level. Catches the
    // "did the diagnostic helper even fire?" question without any
    // DevTools log-level filtering — `console.warn` is always visible
    // in the default view, and `info` from inside WASM has been
    // observed to silently disappear in the streaming-worker path on
    // some browser/build combos. If you don't see this line, the WASM
    // bundle is stale or a different parse path is in use.
    web_sys::console::warn_1(
        &format!(
            "[IFC-LITE] CSG diagnostics: {cls_total} openings classified, \
             {total_failures} failures, {} hosts tracked",
            host_diags.len()
        )
        .into(),
    );

    let cls_obj = js_sys::Object::new();
    set_js_prop(&cls_obj, "rectangular", &(cls.rectangular as f64).into());
    set_js_prop(&cls_obj, "diagonal", &(cls.diagonal as f64).into());
    set_js_prop(&cls_obj, "nonRectangular", &(cls.non_rectangular as f64).into());
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
                let key: &'static str = match &f.reason {
                    ifc_lite_geometry::BoolFailureReason::OperandTooLarge { .. } => {
                        "OperandTooLarge"
                    }
                    ifc_lite_geometry::BoolFailureReason::EmptyOperand => "EmptyOperand",
                    ifc_lite_geometry::BoolFailureReason::DegenerateOperand => "DegenerateOperand",
                    ifc_lite_geometry::BoolFailureReason::NoBoundsOverlap => "NoBoundsOverlap",
                    ifc_lite_geometry::BoolFailureReason::KernelOutputInvalid => {
                        "KernelOutputInvalid"
                    }
                    ifc_lite_geometry::BoolFailureReason::SolidSolidDifferenceSkipped => {
                        "SolidSolidDifferenceSkipped"
                    }
                    ifc_lite_geometry::BoolFailureReason::PolygonalBoundedHalfSpaceFallback => {
                        "PolygonalBoundedHalfSpaceFallback"
                    }
                    ifc_lite_geometry::BoolFailureReason::UnknownBooleanOperator(_) => {
                        "UnknownBooleanOperator"
                    }
                    ifc_lite_geometry::BoolFailureReason::KernelError(_) => "KernelError",
                };
                *by_reason.entry(key).or_insert(0) += 1;
            }
        }
        let mut breakdown: Vec<(&'static str, usize)> = by_reason.into_iter().collect();
        breakdown.sort_by(|a, b| b.1.cmp(&a.1));

        // Per-host-type aggregate: how many of each host type had openings,
        // how many had failures, and which kinds dominated.
        let mut by_host_type: std::collections::HashMap<String, (usize, usize, usize, usize, usize)> =
            std::collections::HashMap::new();
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
