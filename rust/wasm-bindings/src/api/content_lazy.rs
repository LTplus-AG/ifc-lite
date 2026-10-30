// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{gpu_meshes, IfcAPI, IndexedColourCache};

impl IfcAPI {
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
        self.content.cached_parts_to_skip.get_or_init(|| {
            // The layer/void driver now lives in the geometry crate next to its
            // kernels (#913 Phase 4 / §2.6); this method just caches its result
            // per content so it isn't recomputed on every batch.
            let skip_set = ifc_lite_geometry::compute_parts_to_skip(content, decoder);

            std::sync::Arc::new(skip_set)
        })
    }

    /// Get or lazily build the per-content [`MaterialLayerIndex`] (#563) used to
    /// slice single-solid walls/slabs with an `IfcMaterialLayerSetUsage` into one
    /// sub-mesh per layer. Built once per load (one IFCRELASSOCIATESMATERIAL
    /// decode scan, with a cheap substring bail-out on files that carry no layer
    /// set) and `Arc`-shared with every batch router so the layer control
    /// fires. Subsequent batches are an `Arc::clone`.
    pub(crate) fn get_or_build_material_layer_index(
        &self,
        content: &[u8],
        decoder: &mut ifc_lite_core::EntityDecoder,
    ) -> std::sync::Arc<ifc_lite_geometry::MaterialLayerIndex> {
        self.content.cached_material_layer_index.get_or_init(|| {

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
        let has_layer_set = ifc_lite_core::find_keyword(content, LAYER_SET_KW).is_some();
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
            gpu_meshes::batch_host::info(&format!(
                "[ifc-lite layers] {sliceable} sliceable buildup(s) of {} association(s)",
                index.len()
            ));
        } else if has_layer_set {
            gpu_meshes::batch_host::warn(
                "[ifc-lite layers] IfcMaterialLayerSet present but no sliceable buildup (LayerSetUsage missing?)",
            );
        }
        std::sync::Arc::new(index)
        })
    }

    /// The installed #1623 Phase 3 don't-bake plan (see [`Self::set_mapped_instance_plan`]),
    /// or `None` when the pre-pass shipped no repeated mapped sources. UNLIKE the
    /// referenced-repmap set there is NO lazy full-file fallback: the plan is a pure
    /// optimization, so absence just means "materialize every occurrence" (the
    /// byte-identical default), never a correctness gap.
    pub(crate) fn mapped_instance_plan(&self) -> Option<ifc_lite_geometry::MappedInstancePlan> {
        self.content
            .cached_mapped_instance_plan
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .map(std::sync::Arc::clone)
    }

    /// The streaming prepass injects both sets; direct callers scan for missing sets.
    /// The plan is cached per content and cleared between loads.
    pub(crate) fn get_or_build_type_geometry_plan(
        &self,
        content: &[u8],
        decoder: &mut ifc_lite_core::EntityDecoder,
    ) -> std::sync::Arc<ifc_lite_processing::discovery::TypeGeometryPlan> {
        self.content.cached_type_geometry_plan.get_or_init(|| {
            let referenced = self
                .content
                .cached_referenced_repmaps
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            let instantiated = self
                .content
                .cached_instantiated_type_ids
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            let mode = ifc_lite_processing::element::TypeGeometryMode::EmitTagged;
            let mut plan = if referenced.is_some() && instantiated.is_some() {
                ifc_lite_processing::discovery::TypeGeometryPlan::from_sets(
                    rustc_hash::FxHashSet::default(),
                    rustc_hash::FxHashSet::default(),
                    mode,
                )
            } else {
                ifc_lite_processing::discovery::TypeGeometryPlan::from_file_missing(
                    content,
                    decoder,
                    referenced.is_none(),
                    instantiated.is_none(),
                    mode,
                )
            };
            if let Some(referenced) = referenced {
                plan.referenced_representation_maps = (*referenced).clone();
            }
            if let Some(instantiated) = instantiated {
                plan.instantiated_type_ids = (*instantiated).clone();
            }
            std::sync::Arc::new(plan)
        })
    }

    /// Get or lazily build the surface-texture index keyed by face-set id
    /// (issue #961): decoded RGBA images + per-triangle UV maps. Cached per
    /// worker; `build_texture_index` bails out cheaply on untextured files.
    pub(crate) fn get_or_build_texture_index(
        &self,
        content: &[u8],
        decoder: &mut ifc_lite_core::EntityDecoder,
    ) -> std::sync::Arc<rustc_hash::FxHashMap<u32, ifc_lite_geometry::ResolvedTextureMap>> {
        self.content.cached_texture_index.get_or_init(|| {
            let index = ifc_lite_geometry::build_texture_index(content, decoder);

            std::sync::Arc::new(index)
        })
    }

    /// Get or lazily build the `IfcIndexedColourMap` index (geometry id →
    /// full per-triangle palette) used by `processGeometryBatch` to split a
    /// tessellated face set into one sub-mesh per palette group (issue #858).
    ///
    /// The collection is the shared
    /// [`ifc_lite_processing::style::collect_full_indexed_colour_maps`]; only
    /// the per-worker caching is the binding's. Cached so the scan is paid
    /// once per content, not per batch, including the empty result most files
    /// produce, so later batches skip even the substring search.
    pub(crate) fn get_or_build_indexed_colour_maps(
        &self,
        content: &[u8],
        decoder: &mut ifc_lite_core::EntityDecoder,
    ) -> std::sync::Arc<IndexedColourCache> {
        self.content.cached_indexed_colour_maps.get_or_init(|| {
            let map = ifc_lite_processing::style::collect_full_indexed_colour_maps(content, decoder);
            std::sync::Arc::new(IndexedColourCache {
                split_guard_ids: ifc_lite_processing::style::indexed_colour_split_guard_ids(&map),
                maps: std::sync::Arc::new(map),
            })
        })
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
        self.content
            .cached_plane_angle_to_radians
            .get_or_init(|| decoder.plane_angle_to_radians())
    }
}
