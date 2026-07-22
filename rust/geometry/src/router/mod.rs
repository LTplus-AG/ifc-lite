// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Geometry Router - Dynamic dispatch to geometry processors
//!
//! Routes IFC representation entities to appropriate processors based on type.

mod caching;
mod rep_filter;
mod content_hash;
mod diagnostics;
mod instancing;
mod layers;
mod processing;
mod rtc_offset;
mod textured;
mod transforms;
mod voids;

pub use transforms::local_frame_set_enabled_override;
pub use voids::{take_bool2d_stats, take_prism_defers, take_prism_stats, RectParam};
pub use diagnostics::{
    GEOMETRY_DIAGNOSTICS_SCHEMA_VERSION,
    aggregate_diagnostics, ClassificationStats, ClassificationSummary, GeometryDiagnostics,
    HostOpeningDiagnostic, OpeningDiagnostic, OpeningKindDiag, ReasonCount, RectFastSummary,
    WorstHost,
};
pub(crate) use diagnostics::ClassificationKind;
pub(super) use rep_filter::{effective_rep_type, is_body_representation, is_direct_body_representation};

#[cfg(test)]
mod tests;

use crate::material_layer_index::MaterialLayerIndex;
use crate::processors::{
    AdvancedBrepProcessor, BSplineSurfaceProcessor, BlockProcessor, BooleanClippingProcessor,
    CsgSolidProcessor, ExtrudedAreaSolidProcessor, ExtrudedAreaSolidTaperedProcessor,
    FaceBasedSurfaceModelProcessor, FacetedBrepProcessor, IfcAlignmentProcessor,
    PolygonalFaceSetProcessor, RevolvedAreaSolidProcessor,
    SectionedSolidHorizontalProcessor, ShellBasedSurfaceModelProcessor, SphereProcessor,
    SurfaceCurveSweptAreaSolidProcessor, SweptDiskSolidProcessor, TriangulatedFaceSetProcessor,
};
use crate::tessellation::TessellationQuality;
use crate::{BoolFailure, Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use nalgebra::Matrix4;
use rustc_hash::{FxHashMap, FxHashSet};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Geometry processor trait
/// Each processor handles one type of IFC representation
pub trait GeometryProcessor {
    /// Process entity into mesh.
    ///
    /// `quality` selects tessellation detail; processors that approximate
    /// curves derive their segment counts from it via
    /// [`crate::tessellation::scale_segments`]. Processors with no curved
    /// geometry ignore it. [`TessellationQuality::Medium`] reproduces the
    /// engine's historical hardcoded behavior.
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh>;

    /// Get supported IFC types
    fn supported_types(&self) -> Vec<IfcType>;
}

/// Shared content-dedup cache: maps a 128-bit structural item hash to the
/// LOCAL (pre-placement, void-free, colour-free) item mesh PLUS its precomputed
/// instancing `rep_identity` (`Some` when instancing tagged it, else `None`).
/// Storing the rep beside the mesh lets a cache hit stamp it without re-running
/// the O(verts) `compute_mesh_hash_full` per occurrence. Build ONE per loaded
/// model with [`GeometryRouter::new_dedup_cache`] and inject it into every
/// per-element / per-batch router via
/// [`GeometryRouter::enable_content_dedup_shared`] so byte-identical geometry is
/// meshed once regardless of how the work is partitioned across threads/batches.
pub type ItemDedupCache = Arc<Mutex<FxHashMap<u128, Arc<(Mesh, Option<u128>)>>>>;

/// Test/env override for [`GeometryRouter::build_dedup_extra_enabled`]:
/// -1 = env default, 0 = forced off, 1 = forced on.
static DEDUP_EXTRA_OVERRIDE: std::sync::atomic::AtomicI8 = std::sync::atomic::AtomicI8::new(-1);

/// Shared `IfcMappedItem` source cache: maps an `IfcRepresentationMap` express id
/// to its SOURCE-coordinate (pre-`MappingTarget`, pre-placement, colour-free) item
/// mesh. Build ONE per loaded model with
/// [`GeometryRouter::new_mapped_item_cache`] and inject it into every per-element /
/// per-batch router via [`GeometryRouter::enable_shared_mapped_item_cache`], so a
/// source shared by many owning elements is meshed ONCE model-wide instead of once
/// per element (a fresh router is built per element, so the per-router RefCell
/// `mapped_item_cache` only dedups WITHIN one element — #1623). The value is the
/// same source-coords mesh the RefCell would store; the per-occurrence
/// `MappingTarget` transform + `instance_meta` are applied by the caller AFTER the
/// lookup, so a cross-router cache hit is byte-identical to a fresh build.
///
/// `Arc<Mutex<_>>` so ONE cache outlives any single router (mirrors
/// [`ItemDedupCache`]). The key is the source express id, stable per model; all
/// routers in one pass share the same `unit_scale` / `tessellation_quality` / RTC
/// (baked into the source mesh), so keying by id alone is sufficient within a pass
/// — the wasm session drops this cache on a content swap AND on a
/// `setTessellationQuality` change (which invalidates source-coord tessellation),
/// exactly as the router's own `set_tessellation_quality` clears the RefCell.
pub type SharedMappedItemCache = Arc<Mutex<FxHashMap<u32, Arc<Mesh>>>>;

/// #1623 Phase 2 "don't-bake" instancing plan: `IfcRepresentationMap` express id ⇒
/// `(occurrence_count, template_item_id)`, where `template_item_id` is the SMALLEST
/// `IfcMappedItem` express id referencing that source (a deterministic, race-free
/// choice of which occurrence materializes its geometry as the shared template).
/// Only sources with `occurrence_count >= 2` appear. Built ONCE from the file scan
/// and injected into every per-element / per-batch router via
/// [`GeometryRouter::enable_output_instancing`]. When a mapped item's source is in
/// this plan AND the occurrence is a single-solid ordinary product, the
/// NON-template occurrences skip the per-occurrence vertex bake and emit an
/// instance-only placeholder (empty geometry carrying [`crate::mesh::InstanceMeta`])
/// instead of a full materialized mesh — the ~29s / 43M-vertex materialize this
/// phase kills. `None` ⇒ every occurrence materializes (historical flat output,
/// byte-identical); exporters and the determinism harness never arm it.
pub type MappedInstancePlan = Arc<FxHashMap<u32, (u32, u32)>>;

/// Geometry router - routes entities to processors
pub struct GeometryRouter {
    schema: IfcSchema,
    processors: HashMap<IfcType, Arc<dyn GeometryProcessor>>,
    /// Cache for IfcRepresentationMap source geometry (MappedItem instancing)
    /// Key: RepresentationMap entity ID, Value: Processed mesh.
    ///
    /// Per-router FALLBACK used when no [`SharedMappedItemCache`] is injected
    /// (native single-shot / non-streaming callers, tests). A fresh router is
    /// built per element, so this only dedups mapped sources WITHIN one element;
    /// the shared cache below promotes reuse to model-wide (#1623).
    mapped_item_cache: RefCell<FxHashMap<u32, Arc<Mesh>>>,
    /// SHARED `IfcMappedItem` source cache (#1623). When present, takes precedence
    /// over the per-router `mapped_item_cache` so a source shared by many owning
    /// elements is meshed ONCE model-wide (the per-router RefCell above resets per
    /// element). Keyed by `IfcRepresentationMap` id ⇒ SOURCE-coords mesh; the
    /// per-occurrence `MappingTarget` transform + `instance_meta` are applied AFTER
    /// the lookup, so a cross-router hit is byte-identical to a fresh build. The
    /// lock is held only for a map get/clone (hit) or insert (miss) — the source
    /// meshing (which nests faceted-brep's rayon `par_iter`) runs OUTSIDE the lock,
    /// so a lock is never held across a nested join (the #1587 deadlock class).
    /// `None` ⇒ use the RefCell fallback.
    shared_mapped_item_cache: Option<SharedMappedItemCache>,
    /// Cache for geometry deduplication by content hash
    /// Buildings with repeated floors have 99% identical geometry
    /// Key: Hash of mesh content, Value: Processed mesh
    geometry_hash_cache: RefCell<FxHashMap<u64, Arc<Mesh>>>,
    /// SHARED content-dedup of LOCAL (pre-placement, void-free) representation-ITEM
    /// meshes, keyed by a 128-bit structural hash of the item subtree
    /// (`content_hash::item_signature`). Skips the meshing + CSG for byte-identical
    /// geometry the exporter failed to share via `IfcMappedItem` (Tekla connection
    /// plates/bolts). The cached mesh is COLOUR-FREE; the per-instance
    /// `geometry_id` (colour/palette/texture), voids and placement are applied by
    /// the caller, so reuse never changes an instance's appearance.
    ///
    /// `Arc<Mutex<_>>` so ONE cache outlives any single router and is shared across
    /// the native rayon pool's per-element routers AND a wasm worker's per-batch
    /// routers (re-injected each batch). A hit skips the expensive build entirely,
    /// so the lock is held only for a map get/clone (hit) or insert (miss); the
    /// build runs outside it. `None` ⇒ dedup disabled (e.g. `new()` in tests).
    item_dedup_cache: Option<ItemDedupCache>,
    /// Per-router memo for the per-item structural hash (shared sub-entities hashed
    /// once). Keyed by entity id ⇒ valid for one loaded model. Kept LOCAL (not
    /// shared) so the recursive DAG walk never contends the shared cache's lock;
    /// recomputing it per router is cheap next to meshing.
    content_sig_memo: RefCell<FxHashMap<u32, u128>>,
    /// Unit scale factor (e.g., 0.001 for millimeters -> meters)
    /// Applied to all mesh positions after processing
    unit_scale: f64,
    /// RTC (Relative-to-Center) offset for handling large coordinates
    /// Subtracted from all world positions in f64 before converting to f32
    /// This preserves precision for georeferenced models (e.g., Swiss UTM)
    rtc_offset: (f64, f64, f64),
    /// Material-layer buildup index. When set, `process_element_with_submeshes`
    /// and `process_element_with_submeshes_and_voids` first attempt to slice
    /// single-solid elements by their `IfcMaterialLayerSetUsage` buildup.
    material_layer_index: Option<Arc<MaterialLayerIndex>>,
    /// Boolean / CSG failures attributed by IFC product express ID. Populated
    /// by the void-subtraction path (`apply_void_context`) when the BSP
    /// kernel falls back to the un-cut host. Drainable via
    /// [`Self::take_csg_failures`].
    csg_failures: RefCell<FxHashMap<u32, Vec<BoolFailure>>>,
    /// Cumulative counters for opening classification (T1.1 / classifier fix
    /// diagnostic). Tracks how many openings went through each branch of
    /// `classify_openings` so a maintainer can verify the fix is firing on
    /// real models. Drainable via [`Self::take_classification_stats`].
    classification_stats: RefCell<ClassificationStats>,
    /// Per-host opening diagnostic, keyed by host product express ID.
    /// Captures everything the geometry pipeline knows about each host's
    /// openings so a maintainer can answer "why didn't this wall's window
    /// get cut?" from a console log alone. Drainable via
    /// [`Self::take_host_opening_diagnostics`].
    host_opening_diagnostics: RefCell<FxHashMap<u32, HostOpeningDiagnostic>>,
    /// REQUEST-LOCAL rect_fast fast-path engagement counters. Accumulated per-cut
    /// by [`Self::record_rect_fast`] into THIS router (not a process-global), so a
    /// native server running concurrent geometry passes — each with its own router
    /// — gets isolated per-load `rectFast` diagnostics. Drainable via
    /// [`Self::take_rect_fast_stats`]; the wasm batch path drains its one router,
    /// the native path drains each per-element router and sums.
    rect_fast_stats: RefCell<crate::rect_fast::RectFastStats>,
    /// Diagnostic (#563): per-element outcome of layered-wall slicing — why a
    /// sliceable wall did or didn't split into per-layer sub-meshes. Drained by
    /// the wasm layer per batch and logged to the browser console (the geometry
    /// crate can't `web_sys`). Drainable via [`Self::take_layer_slice_diag`].
    layer_slice_diag: RefCell<Vec<(u32, &'static str)>>,
    /// Host product express IDs that a void subtraction fully CONSUMED — an
    /// opening whose real solid contains the whole host, so the correct result
    /// is an empty mesh. Without this flag the empty mesh reads as a failed cut
    /// and the element pipeline falls back to the un-cut host, re-rendering a
    /// spurious solid. Queried via [`Self::host_consumed_by_void`].
    voids_consumed_hosts: RefCell<FxHashSet<u32>>,
    /// Tessellation detail level. Immutable per router instance and passed to
    /// every processor's `process`. Defaults to [`TessellationQuality::Medium`]
    /// (historical hardcoded behavior).
    tessellation_quality: TessellationQuality,
    /// Per-build small-cut skip (#1286). Injected into the boolean / CSG /
    /// mapped processors at construction so a solid-solid DIFFERENCE with a tiny
    /// cutter can be dropped without forcing a preview tessellation tier. Scoped
    /// to this router (one per loaded build) so concurrent native builds never
    /// bleed the flag into one another — it used to be a process-wide static.
    /// `false` (default) ⇒ every cut runs, byte-identical to before.
    skip_small_cuts: bool,
    /// #1623 Phase 2 don't-bake plan (see [`MappedInstancePlan`]). `None` (default)
    /// ⇒ every mapped-item occurrence materializes a full mesh, byte-identical to
    /// the historical flat path. When armed, single-solid ordinary occurrences of a
    /// repeated `IfcRepresentationMap` skip the per-occurrence vertex bake and emit
    /// an instance-only placeholder instead. Scoped to this router (one per loaded
    /// build), like `skip_small_cuts`.
    output_instancing_plan: Option<MappedInstancePlan>,
    /// #858 don't-bake exclusion: geometry-item ids of mapped SOURCES whose single
    /// solid carries an `IfcIndexedColourMap` (per-triangle palette). Such a source
    /// must NOT don't-bake — the flat path splits it into one mesh per palette group
    /// (`split_mesh_by_indexed_colour`), but an instance placeholder resolves ONE
    /// colour, collapsing the palette. Armed alongside the plan; when a candidate's
    /// single-solid id is in this set the router routes it to the normal flat
    /// materialize (byte-identical to instancing-off). `None`/empty ⇒ no exclusion.
    indexed_colour_split_ids: Option<Arc<FxHashSet<u32>>>,
    /// #1623 Phase 3 template-selection mode for the don't-bake path. `false`
    /// (default, NATIVE): the deterministic global template is the plan's min-id
    /// occurrence (`item.id == template_item_id`), so every occurrence resolves
    /// against ONE model-wide template across the rayon pool. `true` (the WASM
    /// per-BATCH path): this router meshes ONE batch onto ONE thread serially, so
    /// the FIRST occurrence of each source THIS router sees is the template (tracked
    /// in [`Self::instanced_sources_materialized`]) and the rest don't-bake — each
    /// per-batch shard is then self-contained (its occurrences' template is in the
    /// same shard), so a batch never depends on a template materialized in another
    /// batch. Both modes emit geometrically identical world triangles.
    instancing_batch_local: bool,
    /// #1623 Phase 3 (batch-local mode only): the `IfcRepresentationMap` source ids
    /// this router has already materialized as a batch-local template. The first
    /// occurrence of a source inserts its id (materializes); later occurrences see
    /// the id present and don't-bake. Reset implicitly per batch — a fresh router is
    /// built per `produce_batch`. Unused (stays empty) in the native global mode.
    instanced_sources_materialized: RefCell<FxHashSet<u32>>,
}

impl GeometryRouter {
    /// Create new router with default processors
    pub fn new() -> Self {
        let schema = IfcSchema::new();
        let schema_clone = schema.clone();
        let mut router = Self {
            schema,
            processors: HashMap::new(),
            mapped_item_cache: RefCell::new(FxHashMap::default()),
            shared_mapped_item_cache: None, // armed by `enable_shared_mapped_item_cache`
            geometry_hash_cache: RefCell::new(FxHashMap::default()),
            item_dedup_cache: None, // armed by `with_units` / `enable_content_dedup_shared`
            content_sig_memo: RefCell::new(FxHashMap::default()),
            unit_scale: 1.0,             // Default to base meters
            rtc_offset: (0.0, 0.0, 0.0), // Default to no offset
            material_layer_index: None,
            csg_failures: RefCell::new(FxHashMap::default()),
            classification_stats: RefCell::new(ClassificationStats::default()),
            host_opening_diagnostics: RefCell::new(FxHashMap::default()),
            rect_fast_stats: RefCell::new(crate::rect_fast::RectFastStats::default()),
            layer_slice_diag: RefCell::new(Vec::new()),
            voids_consumed_hosts: RefCell::new(FxHashSet::default()),
            tessellation_quality: TessellationQuality::Medium,
            skip_small_cuts: false,
            output_instancing_plan: None, // armed by `enable_output_instancing`
            indexed_colour_split_ids: None, // armed by `enable_indexed_colour_split_guard`
            instancing_batch_local: false, // native global-template mode by default
            instanced_sources_materialized: RefCell::new(FxHashSet::default()),
        };

        // Register default P0 processors
        router.register(Box::new(ExtrudedAreaSolidProcessor::new(
            schema_clone.clone(),
        )));
        router.register(Box::new(ExtrudedAreaSolidTaperedProcessor::new(
            schema_clone.clone(),
        )));
        router.register(Box::new(TriangulatedFaceSetProcessor::new()));
        router.register(Box::new(PolygonalFaceSetProcessor::new()));
        router.register(Box::new(FacetedBrepProcessor::new()));
        router.register(Box::new(BooleanClippingProcessor::new()));
        router.register(Box::new(SweptDiskSolidProcessor::new(schema_clone.clone())));
        router.register(Box::new(RevolvedAreaSolidProcessor::new(
            schema_clone.clone(),
        )));
        router.register(Box::new(SurfaceCurveSweptAreaSolidProcessor::new(
            schema_clone.clone(),
        )));
        router.register(Box::new(SectionedSolidHorizontalProcessor::new(
            schema_clone.clone(),
        )));
        router.register(Box::new(AdvancedBrepProcessor::new()));
        router.register(Box::new(BSplineSurfaceProcessor::new()));
        router.register(Box::new(ShellBasedSurfaceModelProcessor::new()));
        router.register(Box::new(FaceBasedSurfaceModelProcessor::new()));
        router.register(Box::new(BlockProcessor::new()));
        router.register(Box::new(SphereProcessor::new()));
        router.register(Box::new(CsgSolidProcessor::new()));
        router.register(Box::new(IfcAlignmentProcessor::new()));

        router
    }

    /// Create router and extract unit scale from IFC file
    /// Automatically finds IFCPROJECT and extracts length unit conversion
    pub fn with_units<T>(content: &T, decoder: &mut EntityDecoder) -> Self
    where
        T: AsRef<[u8]> + ?Sized,
    {
        let scale = Self::scan_unit_scale(content.as_ref(), decoder);
        let mut router = Self::with_scale(scale);
        router.arm_content_dedup();
        router
    }

    /// Scan to the first `IFCPROJECT` and extract its length-unit scale (e.g.
    /// `0.001` for millimetres → metres); `1.0` if none is found.
    fn scan_unit_scale(content: &[u8], decoder: &mut EntityDecoder) -> f64 {
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        while let Some((id, type_name, _, _)) = scanner.next_entity() {
            if type_name == "IFCPROJECT" {
                if let Ok(s) = ifc_lite_core::extract_length_unit_scale(decoder, id) {
                    return s;
                }
                break;
            }
        }
        1.0
    }

    /// Create router with unit scale extracted from IFC file AND RTC offset for large coordinates
    /// This is the recommended method for georeferenced models (Swiss UTM, etc.)
    ///
    /// # Arguments
    /// * `content` - IFC file content
    /// * `decoder` - Entity decoder
    /// * `rtc_offset` - RTC offset to subtract from world coordinates (typically model centroid)
    pub fn with_units_and_rtc<T>(
        content: &T,
        decoder: &mut ifc_lite_core::EntityDecoder,
        rtc_offset: (f64, f64, f64),
    ) -> Self
    where
        T: AsRef<[u8]> + ?Sized,
    {
        let scale = Self::scan_unit_scale(content.as_ref(), decoder);
        let mut router = Self::with_scale_and_rtc(scale, rtc_offset);
        router.arm_content_dedup();
        router
    }

    /// Create router with pre-calculated unit scale
    pub fn with_scale(unit_scale: f64) -> Self {
        let mut router = Self::new();
        router.unit_scale = unit_scale;
        router
    }

    /// Arm content-dedup with a NEW empty cache. Used by the model constructors
    /// (`with_units*`) where this router owns the only reference; multi-router
    /// callers (native pool, wasm batches) should build ONE shared cache via
    /// [`Self::new_dedup_cache`] and inject it into every router with
    /// [`Self::enable_content_dedup_shared`] so the cache persists across them.
    fn arm_content_dedup(&mut self) {
        self.item_dedup_cache = Some(Self::new_dedup_cache());
    }

    /// A fresh empty shared item-dedup cache, to be cloned into every per-element /
    /// per-batch router of ONE loaded model so they all dedup against it. Keep one
    /// per model: the key is a per-model entity-structure hash, and the cached
    /// meshes bake in this model's unit scale / tessellation quality.
    pub fn new_dedup_cache() -> ItemDedupCache {
        Arc::new(Mutex::new(FxHashMap::default()))
    }

    /// Whether content-dedup covers EXTRA item types beyond the proven default
    /// set (faceset / surface-model families). `item_signature`'s generic byte
    /// walk is already complete for them, so this is pure additive build savings
    /// on models that repeat tessellated geometry — but it pays a hash on every
    /// such item, so it stays OFF by default until corpus-validated (low-reuse
    /// models would pay the hash for no payback, the #1177 trap). Opt in with
    /// `IFC_LITE_DEDUP_EXTRA=1` or [`Self::set_build_dedup_extra_override`].
    /// Default OFF keeps native==wasm identical.
    pub fn build_dedup_extra_enabled() -> bool {
        match DEDUP_EXTRA_OVERRIDE.load(std::sync::atomic::Ordering::Relaxed) {
            0 => return false,
            1 => return true,
            _ => {}
        }
        static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        *ON.get_or_init(|| std::env::var("IFC_LITE_DEDUP_EXTRA").as_deref() == Ok("1"))
    }

    /// Test-only: force [`Self::build_dedup_extra_enabled`] on/off (`None` = env).
    pub fn set_build_dedup_extra_override(v: Option<bool>) {
        DEDUP_EXTRA_OVERRIDE.store(
            match v {
                None => -1,
                Some(false) => 0,
                Some(true) => 1,
            },
            std::sync::atomic::Ordering::Relaxed,
        );
    }

    /// Inject a shared item-dedup cache (see [`Self::new_dedup_cache`]) into this
    /// router. All routers given the SAME `Arc` dedup against one cache, so
    /// byte-identical geometry is meshed once across the whole model regardless of
    /// how elements are partitioned across threads or batches.
    pub fn enable_content_dedup_shared(&mut self, cache: ItemDedupCache) {
        self.item_dedup_cache = Some(cache);
    }

    /// A fresh empty shared `IfcMappedItem` source cache, to be cloned into every
    /// per-element / per-batch router of ONE loaded model so a mapped source shared
    /// across owning elements is meshed once model-wide (#1623). Mirrors
    /// [`Self::new_dedup_cache`]. Keep one per model/pass: the cached meshes bake in
    /// this pass's unit scale / tessellation quality.
    pub fn new_mapped_item_cache() -> SharedMappedItemCache {
        Arc::new(Mutex::new(FxHashMap::default()))
    }

    /// Inject a shared `IfcMappedItem` source cache (see
    /// [`Self::new_mapped_item_cache`]) into this router. All routers given the
    /// SAME `Arc` mesh each unique `IfcRepresentationMap` source once across the
    /// whole model, instead of once per owning element (a fresh router is built per
    /// element). Takes precedence over the per-router RefCell `mapped_item_cache`;
    /// leaving it unset keeps the per-router fallback for single-shot callers.
    pub fn enable_shared_mapped_item_cache(&mut self, cache: SharedMappedItemCache) {
        self.shared_mapped_item_cache = Some(cache);
    }

    /// Arm the #1623 Phase 2 don't-bake instancing plan (see [`MappedInstancePlan`])
    /// on this router. Requires a shared mapped-item cache to be enabled too — the
    /// don't-bake instance placeholders rely on the source being meshed once into it
    /// (the orphan-recovery template at finalize reads it). Leaving it unset keeps
    /// every occurrence materializing (byte-identical flat output).
    pub fn enable_output_instancing(&mut self, plan: MappedInstancePlan) {
        self.output_instancing_plan = Some(plan);
    }

    /// The armed don't-bake plan, if any (see [`Self::enable_output_instancing`]).
    pub(super) fn output_instancing_plan(&self) -> Option<&MappedInstancePlan> {
        self.output_instancing_plan.as_ref()
    }

    /// Arm the #858 don't-bake exclusion set: geometry-item ids of mapped sources
    /// whose single solid carries an `IfcIndexedColourMap`. Such a source is routed
    /// to the flat materialize (per-palette split) instead of don't-bake, so its
    /// occurrences keep the per-triangle palette (an instance placeholder would
    /// collapse it to one colour). Armed alongside [`Self::enable_output_instancing`]
    /// when the model has any indexed-colour maps; unset ⇒ no exclusion.
    pub fn enable_indexed_colour_split_guard(&mut self, ids: Arc<FxHashSet<u32>>) {
        self.indexed_colour_split_ids = Some(ids);
    }

    /// Whether `geometry_id` is a mapped-source solid carrying an `IfcIndexedColourMap`
    /// (see [`Self::enable_indexed_colour_split_guard`]) — such a source must not
    /// don't-bake, so its per-triangle palette survives the flat split.
    pub(super) fn is_indexed_colour_split_source(&self, geometry_id: u32) -> bool {
        self.indexed_colour_split_ids
            .as_ref()
            .is_some_and(|ids| ids.contains(&geometry_id))
    }

    /// Select the #1623 Phase 3 batch-local template mode (see
    /// [`Self::instancing_batch_local`]). The WASM per-batch path sets this so each
    /// batch materializes its OWN first-seen template per source and stays a
    /// self-contained shard; the native path leaves it off (global min-id template).
    pub fn set_instancing_batch_local(&mut self, on: bool) {
        self.instancing_batch_local = on;
    }

    /// Whether batch-local template selection is active (see the field doc).
    #[inline]
    pub(super) fn instancing_batch_local(&self) -> bool {
        self.instancing_batch_local
    }

    /// Batch-local don't-bake template decision: returns `true` (materialize as the
    /// batch-local template) the FIRST time this router sees `source_id`, `false`
    /// (don't-bake) every time after. Idempotent per source within one router/batch.
    pub(super) fn mark_source_materialized_if_first(&self, source_id: u32) -> bool {
        self.instanced_sources_materialized
            .borrow_mut()
            .insert(source_id)
    }

    /// Disable content-dedup (drops the cache reference so `item_dedup_key`
    /// returns `None` and meshing is never skipped). Test/bench helper for an A/B
    /// against the deduped path.
    pub fn disable_content_dedup(&mut self) {
        self.item_dedup_cache = None;
    }

    /// Number of unique item meshes cached by content-dedup so far — the reuse the
    /// pipeline recovered (vs. the meshed-item count). Diagnostics.
    pub fn dedup_unique_count(&self) -> usize {
        self.item_dedup_cache
            .as_ref()
            .map(|c| c.lock().unwrap_or_else(|e| e.into_inner()).len())
            .unwrap_or(0)
    }

    /// Number of unique `IfcRepresentationMap` sources meshed into the SHARED
    /// mapped-item cache so far (0 when no shared cache is injected — the RefCell
    /// fallback isn't counted). Diagnostics, mirroring [`Self::dedup_unique_count`];
    /// used by the #1623 A/B test to confirm the shared cache actually captured
    /// sources (so a cross-router hit is genuinely exercised, not a no-op).
    pub fn mapped_shared_unique_count(&self) -> usize {
        self.shared_mapped_item_cache
            .as_ref()
            .map(|c| c.lock().unwrap_or_else(|e| e.into_inner()).len())
            .unwrap_or(0)
    }

    /// Content-routing key for an element: a 128-bit structural hash of its WHOLE
    /// representation subtree (the `Representation` attribute, e.g. an
    /// `IfcProductDefinitionShape`), or `None` if it has no geometry. Two elements
    /// with byte-identical geometry — even renumbered — share a key, so a host can
    /// route them to the same worker; combined with the per-worker dedup cache the
    /// geometry is then meshed once per worker. Meshing-free (decode + fold) and
    /// reuses the per-router signature memo so shared sub-entities are hashed once.
    ///
    /// (A per-instance shape-representation wrapper can make this finer than the
    /// per-ITEM dedup unit, but a true 4-router simulation showed that costs
    /// essentially no extra meshing — 1.01× — because the shared items still land
    /// on one worker, so the simpler whole-representation hash is used.)
    pub fn geometry_routing_key(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<u128> {
        let rep = element.get(6)?.as_entity_ref()?;
        let mut memo = self.content_sig_memo.borrow_mut();
        Some(content_hash::item_signature(decoder, rep, &mut memo))
    }

    /// Create router with RTC offset for large coordinate handling
    /// Use this for georeferenced models (e.g., Swiss UTM coordinates)
    pub fn with_rtc(rtc_offset: (f64, f64, f64)) -> Self {
        let mut router = Self::new();
        router.rtc_offset = rtc_offset;
        router
    }

    /// Create router with both unit scale and RTC offset
    pub fn with_scale_and_rtc(unit_scale: f64, rtc_offset: (f64, f64, f64)) -> Self {
        let mut router = Self::new();
        router.unit_scale = unit_scale;
        router.rtc_offset = rtc_offset;
        router
    }

    /// Create router with a specific tessellation quality level
    pub fn with_quality(quality: TessellationQuality) -> Self {
        let mut router = Self::new();
        router.tessellation_quality = quality;
        router
    }

    /// Create router with both unit scale and tessellation quality
    pub fn with_scale_and_quality(unit_scale: f64, quality: TessellationQuality) -> Self {
        let mut router = Self::new();
        router.unit_scale = unit_scale;
        router.tessellation_quality = quality;
        router
    }

    /// Set the tessellation quality level.
    ///
    /// Reusing one router across a quality change invalidates `mapped_item_cache`
    /// (keyed by RepresentationMap id, not by quality), so it is cleared here to
    /// avoid serving meshes tessellated at the previous level. The other caches
    /// are content-hash keyed (`geometry_hash_cache`), so they stay correct.
    pub fn set_tessellation_quality(&mut self, quality: TessellationQuality) {
        if self.tessellation_quality == quality {
            return;
        }
        self.tessellation_quality = quality;
        self.mapped_item_cache.get_mut().clear();
    }

    /// Get the current tessellation quality level
    #[inline]
    pub fn tessellation_quality(&self) -> TessellationQuality {
        self.tessellation_quality
    }

    /// Set the per-build small-cut skip (#1286) and re-register the boolean /
    /// CSG / mapped processors so they carry it. Tier-independent: the viewer
    /// turns this on to skip tiny steel copes/notches for fast first paint while
    /// the tessellation tier stays at `Medium` (curves keep full density).
    ///
    /// Scoped to this router instance, so a concurrent native build with the
    /// skip off is unaffected (this replaced a process-wide static that bled
    /// across builds). `false` (default) keeps every cut, byte-identical to
    /// before the optimization.
    pub fn set_skip_small_cuts(&mut self, on: bool) {
        if self.skip_small_cuts == on {
            return;
        }
        self.skip_small_cuts = on;
        self.register_skip_dependent_processors();
    }

    /// Get the current per-build small-cut skip flag.
    #[inline]
    pub fn skip_small_cuts(&self) -> bool {
        self.skip_small_cuts
    }

    /// (Re)register the processors whose behavior depends on `skip_small_cuts`
    /// so they pick up the current value. Called at construction and whenever
    /// [`Self::set_skip_small_cuts`] flips the flag; `register` overwrites the
    /// existing map entries keyed by IFC type.
    fn register_skip_dependent_processors(&mut self) {
        self.register(Box::new(BooleanClippingProcessor::with_skip_small_cuts(
            self.skip_small_cuts,
        )));
        self.register(Box::new(CsgSolidProcessor::with_skip_small_cuts(
            self.skip_small_cuts,
        )));
    }

    /// Set the RTC offset for large coordinate handling
    pub fn set_rtc_offset(&mut self, offset: (f64, f64, f64)) {
        self.rtc_offset = offset;
    }

    /// Get the current RTC offset
    pub fn rtc_offset(&self) -> (f64, f64, f64) {
        self.rtc_offset
    }

    /// Check if RTC offset is active (non-zero)
    #[inline]
    pub fn has_rtc_offset(&self) -> bool {
        self.rtc_offset.0 != 0.0 || self.rtc_offset.1 != 0.0 || self.rtc_offset.2 != 0.0
    }

    /// Get the current unit scale factor
    pub fn unit_scale(&self) -> f64 {
        self.unit_scale
    }

    /// Attach a material-layer buildup index. After this, sub-mesh processing
    /// automatically slices single-solid elements whose buildup is sliceable
    /// (walls with `IfcMaterialLayerSetUsage`, etc.) into per-layer slabs.
    pub fn set_material_layer_index(&mut self, index: Arc<MaterialLayerIndex>) {
        self.material_layer_index = Some(index);
    }

    #[inline]
    pub(crate) fn material_layer_index(&self) -> Option<&MaterialLayerIndex> {
        self.material_layer_index.as_deref()
    }

    /// True when `element_id` carries a sliceable `IfcMaterialLayerSetUsage`, i.e.
    /// `process_element_with_submeshes` would split it into per-layer sub-meshes.
    /// Lets the mesh producer render the wall as ONE solid in 3D while still
    /// emitting the per-layer slices (tagged section-only) for the 2D cut.
    #[inline]
    pub fn is_material_layer_sliceable(&self, element_id: u32) -> bool {
        self.material_layer_index()
            .is_some_and(|idx| idx.is_sliceable(element_id))
    }

    /// Scale mesh positions from file units to meters
    /// Only applies scaling if unit_scale != 1.0
    #[inline]
    fn scale_mesh(&self, mesh: &mut Mesh) {
        if self.unit_scale != 1.0 {
            let scale = self.unit_scale as f32;
            for pos in mesh.positions.iter_mut() {
                *pos *= scale;
            }
        }
    }

    /// Scale the translation component of a transform matrix from file units to meters
    /// The rotation/scale part stays unchanged, only translation (column 3) is scaled
    #[inline]
    fn scale_transform(&self, transform: &mut Matrix4<f64>) {
        if self.unit_scale != 1.0 {
            transform[(0, 3)] *= self.unit_scale;
            transform[(1, 3)] *= self.unit_scale;
            transform[(2, 3)] *= self.unit_scale;
        }
    }

    /// Register a geometry processor
    pub fn register(&mut self, processor: Box<dyn GeometryProcessor>) {
        let processor_arc: Arc<dyn GeometryProcessor> = Arc::from(processor);
        for ifc_type in processor_arc.supported_types() {
            self.processors.insert(ifc_type, Arc::clone(&processor_arc));
        }
    }

    /// Resolve an element's ObjectPlacement to a scaled world-space transform matrix.
    /// Returns the 4x4 matrix as a flat column-major array of 16 f64 values.
    /// The translation component is scaled from file units to meters.
    ///
    /// Contributed by Mathias Søndergaard (Sonderwoods/Linkajou).
    pub fn resolve_scaled_placement(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<[f64; 16]> {
        let mut transform = self.get_placement_transform_from_element(entity, decoder)?;
        self.scale_transform(&mut transform);
        let mut result = [0.0f64; 16];
        result.copy_from_slice(transform.as_slice());
        Ok(result)
    }

    /// Get schema reference
    pub fn schema(&self) -> &IfcSchema {
        &self.schema
    }
}

impl Default for GeometryRouter {
    fn default() -> Self {
        Self::new()
    }
}
