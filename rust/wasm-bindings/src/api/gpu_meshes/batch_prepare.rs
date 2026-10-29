// SPDX-License-Identifier: MPL-2.0
//! Browser batch preparation. Warm indexes and decoder caches are scheduler
//! state; immutable production maps are captured once for the owned producer.
use crate::api::IfcAPI;
use super::batch_wire::BatchWire;
use super::void_index::reconstruct_void_index;
use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{GeometryRouter, SharedMappedItemCache};
use ifc_lite_processing::element::{GeometryHashConfig, MeshProductionOptions, OwnedMeshProductionContext, OwnedMeshProductionData};
use ifc_lite_processing::style::GeometryStyleInfo;
use std::sync::Arc;

/// Session-constant style lookups shared across batches: colour map plus
/// per-style `GeometryStyleInfo` index (see the #1097 cache note below).
pub(super) type StyleMaps = std::sync::Arc<(
    rustc_hash::FxHashMap<u32, [f32; 4]>,
    std::sync::Arc<rustc_hash::FxHashMap<u32, ifc_lite_processing::style::GeometryStyleInfo>>,
)>;

pub(super) struct BatchSetup<'a> {
    pub decoder: EntityDecoder<'a>,
    pub router: GeometryRouter,
    pub ctx: Arc<OwnedMeshProductionContext>,
    pub opts: MeshProductionOptions,
    pub style_maps: StyleMaps,
    pub parts_to_skip: Arc<rustc_hash::FxHashSet<u32>>,
    pub mapped_item_cache: SharedMappedItemCache,
}

impl IfcAPI {
    pub(super) fn prepare_batch<'a>(&self, content: &'a [u8], wire: &BatchWire<'_>, arm_instancing: bool) -> BatchSetup<'a> {
        let BatchWire { jobs_flat, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, void_keys, void_counts, void_values, style_ids, style_colors, plane_angle_to_radians, .. } = *wire;
        let material_element_ids = &wire.material_element_ids;
        let material_color_counts = &wire.material_color_counts;
        let material_colors_rgba = &wire.material_colors_rgba;
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

        let mut decoder = self.batch_decoder(content, unit_scale, plane_angle_to_radians);

        let caches = self.batch_caches();
        let mapped_item_cache = caches.mapped_items.clone();

        // Only partitioned output can recover sub-threshold don't-bake meshes.
        // Shifted models and geometry hashing keep the materialized path.
        let instancing_armed = arm_instancing && !needs_shift && hash_tolerance.is_none();
        let instance_plan = if instancing_armed {
            self.mapped_instance_plan()
        } else {
            None
        };
        let layers = if !self.merge_layers() {
            Some(self.get_or_build_material_layer_index(content, &mut decoder))
        } else { None };

        // Reconstruct void_index from the flat wire arrays. Length-guarded so
        // upstream drift drops the index instead of trapping the whole wasm
        // instance under panic=abort (see reconstruct_void_index).
        let void_index = reconstruct_void_index(void_keys, void_counts, void_values);

        // #1097: the wire styles are session-constant, so build the colour map
        // AND the GeometryStyleInfo index the producer consumes ONCE per worker
        // and reuse across batches (was ~18 M HashMap inserts each on a 140 K-
        // styled model). Keyed by a cheap (len, first_id, last_id) signature.
        let style_maps = self.batch_styles(style_ids, style_colors);
        decoder.reserve_cache(jobs_flat.len() / 3 * 2);

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
        let indexed_colour = self.get_or_build_indexed_colour_maps(content, &mut decoder);
        // #858 / EDGE-WASM-5 (#7691): with the don't-bake plan armed, keep
        // multi-colour indexed-colour sources flat so their palette split
        // survives; an instance placeholder carries ONE colour. The same id set
        // the native orchestrator arms (`style::indexed_colour_split_guard_ids`),
        // derived once per content alongside the maps.
        let router = ifc_lite_processing::execution::build_router(
            ifc_lite_geometry::RouterConfig {
                unit_scale,
                tessellation_quality: self.tessellation_quality(),
                skip_small_cuts: self.skip_small_cuts(),
                rtc_offset: if needs_shift { (rtc_x, rtc_y, rtc_z) } else { (0.0, 0.0, 0.0) },
                ..Default::default()
            },
            ifc_lite_processing::execution::ExecutionPolicy::PerBatch,
            &caches, layers, instance_plan.as_ref(), indexed_colour.split_guard_ids.as_ref(),
        );

        // The canonical styled-item index the shared producer consumes — built
        // once per worker alongside `geometry_styles` above (#1097).
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

        // One snapshot per batch: session caches shared, the batch's wire maps moved in.
        let ctx = self.production_model.snapshot(OwnedMeshProductionData {
            void_index: std::sync::Arc::new(void_index),
            geometry_style_index: std::sync::Arc::clone(&style_maps.1),
            indexed_colour_full: std::sync::Arc::clone(&indexed_colour.maps),
            element_material_colors: std::sync::Arc::new(element_material_colors),
            texture_index: std::sync::Arc::clone(&texture_index),
            // The browser's axis change (IFC Z-up → WebGL Y-up) happens at the
            // FFI boundary in `MeshDataJs::from_mesh_data`, not here.
            site_local_rotation: None,
        });
        let opts = MeshProductionOptions {
            geometry_hash: hash_tolerance.map(|tolerance| GeometryHashConfig { tolerance, world_rtc: hash_world_rtc }),
            ..Default::default()
        };

        BatchSetup { decoder, router, ctx, opts, style_maps, parts_to_skip, mapped_item_cache }
    }

    fn batch_decoder<'a>(&self, content: &'a [u8], unit_scale: f64, plane_angle_to_radians: Option<f64>) -> EntityDecoder<'a> {
        let entity_index_arc: std::sync::Arc<ifc_lite_core::ColumnarEntityIndex> = {
            // Mutex briefly held: peek at cache, build-if-empty, clone Arc.
            // The clone is what gets handed to rayon — no lock contention
            // on the per-job hot path that follows. Poison panics here
            // (an earlier panic-with-lock-held has corrupted the cache).
            let mut slot = self
                .cached_entity_index
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(existing) = slot.as_ref() {
                std::sync::Arc::clone(existing)
            } else {
                // No setEntityIndex was delivered (non-streaming path): scan the
                // file straight into sorted columns, skipping the FxHashMap.
                let built = std::sync::Arc::new(super::scan_columnar_index(content));
                *slot = Some(std::sync::Arc::clone(&built));
                built
            }
        };
        let mut decoder = EntityDecoder::with_arc_columnar_index(content, entity_index_arc).with_strict_reals(); // #7678
        // Seed the unit-scale caches so curve/arc tessellation never re-pays the
        // O(file) IFCPROJECT scan: this decoder is fresh on every batch call,
        // and `plane_angle_to_radians()` would otherwise walk the whole DATA
        // section per batch on files whose IFCPROJECT sits near the end
        // (IfcOpenShell exports) — the geometry-stream stall on large models.
        let plane_angle_to_radians = plane_angle_to_radians
            .unwrap_or_else(|| self.get_or_resolve_plane_angle(&mut decoder));
        decoder.seed_unit_scales(unit_scale, plane_angle_to_radians);

        decoder
    }

    fn batch_styles(&self, style_ids: &[u32], style_colors: &[u8]) -> StyleMaps {
        {
            let sig_len = style_ids.len();
            let sig_first = style_ids.first().copied().unwrap_or(0);
            let sig_last = style_ids.last().copied().unwrap_or(0);
            let mut slot = self
                .cached_geometry_styles
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match slot.as_ref() {
                Some((l, f, la, arc)) if *l == sig_len && *f == sig_first && *la == sig_last => {
                    std::sync::Arc::clone(arc)
                }
                _ => {
                    let colors = super::batch_partition::style_colors_from_wire(
                        style_ids,
                        style_colors,
                    );
                    let index: rustc_hash::FxHashMap<u32, GeometryStyleInfo> = colors
                        .iter()
                        .map(|(&id, &c)| (id, GeometryStyleInfo::from_color(c)))
                        .collect();
                    let arc = std::sync::Arc::new((colors, std::sync::Arc::new(index)));
                    *slot = Some((sig_len, sig_first, sig_last, std::sync::Arc::clone(&arc)));
                    arc
                }
            }
        }
    }
}
