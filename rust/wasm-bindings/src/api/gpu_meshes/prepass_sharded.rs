// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Sharded pre-pass wasm APIs (split from `prepass.rs`): the per-worker
//! entity-index shard scan, the per-worker styled-item slice resolver, and
//! the canonical styles finalize that merges the shard results. The main
//! sharded pre-pass entry (`buildPrePassStreamingSharded`) stays in
//! `prepass.rs` beside its serial twin.

use crate::api::IfcAPI;
use js_sys::Function;
use wasm_bindgen::prelude::*;

/// Serialize the shared [`StreamMeta`] onto a JS object as the wire fields the
/// host reads: `unitScale`, `planeAngleToRadians`, `rtcOffset` (`[x,y,z]`),
/// `needsShift`, `buildingRotation` (`null` when absent). Used by both the
/// `buildPrePassOnce` result object and the streaming `meta` events so all
/// three emission points serialize identically.
pub(super) fn set_stream_meta_props(
    obj: &js_sys::Object,
    meta: &ifc_lite_processing::stream_meta::StreamMeta,
) {
    crate::api::set_js_prop(obj, "unitScale", &meta.length_unit_scale.into());
    crate::api::set_js_prop(obj, "planeAngleToRadians", &meta.plane_angle_to_radians.into());
    let rtc_arr = js_sys::Float64Array::new_with_length(3);
    rtc_arr.set_index(0, meta.rtc_offset.0);
    rtc_arr.set_index(1, meta.rtc_offset.1);
    rtc_arr.set_index(2, meta.rtc_offset.2);
    crate::api::set_js_prop(obj, "rtcOffset", &rtc_arr);
    crate::api::set_js_prop(obj, "needsShift", &meta.needs_shift.into());
    match meta.building_rotation {
        Some(rot) => crate::api::set_js_prop(obj, "buildingRotation", &rot.into()),
        None => crate::api::set_js_prop(obj, "buildingRotation", &JsValue::NULL),
    };
}

#[wasm_bindgen]
impl IfcAPI {
    /// Sharded pre-pass variant: same scan/discovery/jobs/columns pipeline as
    /// `buildPrePassStreaming`, but
    ///  1. the entity index is PREBUILT from the host's stitched shard columns
    ///     (file order; see `scanEntityIndexShard`) — the scan skips its inline
    ///     index build, the meta RTC ladder resolves against the FULL index
    ///     (no partial-ladder full-rescan detour), and the post-scan
    ///     `entity-index` event is skipped (the host already delivered it), and
    ///  2. styles resolution is EXTERNAL: the styled-item spans are resolved as
    ///     shard slices on the geometry workers (`resolveStyledItemsShard`);
    ///     this call stashes the SUPPORT spans + plane-angle scale, and the
    ///     follow-up `finalizePrepassStyles` merges + flattens into the exact
    ///     styles payload the serial path emits. NO `styles` event is emitted
    ///     here.
    #[wasm_bindgen(js_name = buildPrePassStreamingSharded)]
    #[allow(clippy::too_many_arguments)]
    pub fn build_pre_pass_streaming_sharded(
        &self,
        data: &[u8],
        on_event: &Function,
        chunk_size: u32,
        disabled_type_names: Option<Vec<String>>,
        skip_type_geometry: bool,
        index_ids: &[u32],
        index_starts: &[u32],
        index_lengths: &[u32],
        index_classes: &[u8],
    ) -> Result<JsValue, JsValue> {
        let prebuilt = ifc_lite_core::ColumnarEntityIndex::from_columns(
            index_ids,
            index_starts,
            index_lengths,
        );
        self.pre_pass_streaming_impl(
            data,
            on_event,
            chunk_size,
            disabled_type_names,
            skip_type_geometry,
            Some(prebuilt),
            true,
            Some((index_ids, index_starts, index_lengths, index_classes)),
        )
    }

    /// SPIKE (sharded pre-pass): scan the entity index over a single byte range.
    ///
    /// Each idle browser geometry worker calls this on its `[range_start,
    /// range_end)` shard; the main thread stitches the returned columns into the
    /// full entity index (byte-identical to the single-threaded
    /// `build_entity_index`) by binary-searching each shard for the previous
    /// shard's `handoff`. Delegates to `ifc_lite_processing::scan_shard`, the
    /// exact per-chunk primitive the native `build_entity_index_parallel` fans
    /// across cores — so the sharded merge cannot drift from the serial builder.
    ///
    /// Byte offsets returned are GLOBAL (relative to file start), so shards
    /// concatenate without rewriting. Returns a plain object:
    ///   `{ ids: Uint32Array, starts: Uint32Array, lengths: Uint32Array,
    ///      handoff: number }`
    /// where `handoff` is the global start of the first entity at/after
    /// `range_end` (the next shard's first real entity), or `-1` at EOF.
    #[wasm_bindgen(js_name = scanEntityIndexShard)]
    pub fn scan_entity_index_shard(
        &self,
        data: &[u8],
        range_start: u32,
        range_end: u32,
    ) -> JsValue {
        let total = data.len();
        let start = (range_start as usize).min(total);
        let end = (range_end as usize).min(total);
        let (records, classes, handoff) =
            ifc_lite_processing::scan_shard_classified(data, start, end);

        let n = records.len() as u32;
        let ids = js_sys::Uint32Array::new_with_length(n);
        let starts = js_sys::Uint32Array::new_with_length(n);
        let lengths = js_sys::Uint32Array::new_with_length(n);
        for (i, &(id, s, e)) in records.iter().enumerate() {
            let i = i as u32;
            ids.set_index(i, id);
            starts.set_index(i, s as u32);
            lengths.set_index(i, (e - s) as u32);
        }

        let result = js_sys::Object::new();
        crate::api::set_js_prop(&result, "ids", &ids);
        crate::api::set_js_prop(&result, "starts", &starts);
        crate::api::set_js_prop(&result, "lengths", &lengths);
        // Per-record prepass class (PREPASS_CLASS_*): styled items plus the
        // colour-map/material/void/fills/aggregate support classes are tagged,
        // letting the host extract every span list resolveStyledItemsShard +
        // finalizePrepassStyles need from the stitched columns without waiting
        // for the serial pre-pass scan.
        crate::api::set_js_prop(&result, "classes", &js_sys::Uint8Array::from(classes.as_slice()));
        let handoff_val: f64 = match handoff {
            Some(h) => h as f64,
            None => -1.0,
        };
        crate::api::set_js_prop(&result, "handoff", &handoff_val.into());
        result.into()
    }

    /// Sharded pre-pass: resolve ONE contiguous (file-ordered) slice of the
    /// styled-item span list on this worker, against the entity index installed
    /// by `setEntityIndex`. Returns raw resolved maps as flat columns:
    /// `{ orphanIds, orphanColors (f32 rgba per id), geomIds, geomColors }`.
    /// The host merges shard results IN SHARD ORDER with first-wins per
    /// geometry id, reproducing the serial resolver's file-order precedence,
    /// then hands the merged columns to `finalizePrepassStyles`.
    /// `spans` is `[id, start, len]` triples.
    #[wasm_bindgen(js_name = resolveStyledItemsShard)]
    pub fn resolve_styled_items_shard(&self, data: &[u8], spans: &[u32]) -> Result<JsValue, JsValue> {
        use ifc_lite_core::EntityDecoder;
        let index = {
            let slot = self
                .cached_entity_index
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            slot.clone()
        };
        let Some(index) = index else {
            return Err(JsValue::from_str(
                "resolveStyledItemsShard: no entity index installed (setEntityIndex must run first)",
            ));
        };
        let mut decoder = EntityDecoder::with_arc_columnar_index(data, index);
        let styled: Vec<(u32, usize, usize)> = spans
            .chunks_exact(3)
            .map(|c| (c[0], c[1] as usize, c[1] as usize + c[2] as usize))
            .collect();
        let mut orphan = rustc_hash::FxHashMap::default();
        let mut geom = rustc_hash::FxHashMap::default();
        let mut deferred = Vec::new();
        ifc_lite_processing::prepass::resolve_styled_items_into(
            &styled,
            &mut decoder,
            false,
            &mut orphan,
            &mut geom,
            &mut deferred,
        );

        let orphan_ids = js_sys::Uint32Array::new_with_length(orphan.len() as u32);
        let orphan_colors = js_sys::Float32Array::new_with_length((orphan.len() * 4) as u32);
        for (i, (&id, color)) in orphan.iter().enumerate() {
            orphan_ids.set_index(i as u32, id);
            for (j, &c) in color.iter().enumerate() {
                orphan_colors.set_index((i * 4 + j) as u32, c);
            }
        }
        let geom_ids = js_sys::Uint32Array::new_with_length(geom.len() as u32);
        let geom_colors = js_sys::Float32Array::new_with_length((geom.len() * 4) as u32);
        for (i, (&id, info)) in geom.iter().enumerate() {
            geom_ids.set_index(i as u32, id);
            for (j, &c) in info.color.iter().enumerate() {
                geom_colors.set_index((i * 4 + j) as u32, c);
            }
        }
        let result = js_sys::Object::new();
        crate::api::set_js_prop(&result, "orphanIds", &orphan_ids);
        crate::api::set_js_prop(&result, "orphanColors", &orphan_colors);
        crate::api::set_js_prop(&result, "geomIds", &geom_ids);
        crate::api::set_js_prop(&result, "geomColors", &geom_colors);
        Ok(result.into())
    }

    /// Sharded pre-pass: merge the shard-resolved styled-item columns with the
    /// SUPPORT spans (extracted host-side from the shard classes) and run the
    /// CANONICAL styles flatten. Returns the exact `styles` event payload the
    /// serial path emits. Runs on any worker with `setEntityIndex` installed.
    /// Span arguments are `[id, start, len]` triples; `plane_angle_to_radians`
    /// comes from the meta event.
    #[wasm_bindgen(js_name = finalizePrepassStyles)]
    #[allow(clippy::too_many_arguments)]
    pub fn finalize_prepass_styles(
        &self,
        data: &[u8],
        orphan_ids: &[u32],
        orphan_colors: &[f32],
        geom_ids: &[u32],
        geom_colors: &[f32],
        colour_map_spans: &[u32],
        material_def_spans: &[u32],
        rel_material_spans: &[u32],
        void_spans: &[u32],
        fills_spans: &[u32],
        aggregate_spans: &[u32],
        plane_angle_to_radians: f64,
    ) -> Result<JsValue, JsValue> {
        use ifc_lite_core::EntityDecoder;
        fn triples(v: &[u32]) -> Vec<(u32, usize, usize)> {
            v.chunks_exact(3)
                .map(|c| (c[0], c[1] as usize, c[1] as usize + c[2] as usize))
                .collect()
        }
        let stashed_support = ifc_lite_processing::prepass::PrepassSpans {
            styled_items: Vec::new(),
            indexed_colour_maps: triples(colour_map_spans),
            material_def_reprs: triples(material_def_spans),
            rel_associates_material: triples(rel_material_spans),
            void_rels: triples(void_spans),
            fills_rels: triples(fills_spans),
            aggregate_rels: triples(aggregate_spans),
        };
        let index = {
            let slot = self
                .cached_entity_index
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            slot.clone()
        };
        let Some(index) = index else {
            return Err(JsValue::from_str("finalizePrepassStyles: no entity index"));
        };
        let mut decoder = EntityDecoder::with_arc_columnar_index(data, index);
        decoder.seed_unit_scales(1.0, plane_angle_to_radians);

        // Rebuild the shard-merged styled maps and SEED them into the resolver
        // BEFORE the support-span loops: the material chain consults
        // orphan_styled_items, so injecting after resolve_prepass loses
        // material-dependent styles.
        let mut orphan_seed = rustc_hash::FxHashMap::default();
        for (i, &id) in orphan_ids.iter().enumerate() {
            orphan_seed.insert(id, [
                orphan_colors[i * 4],
                orphan_colors[i * 4 + 1],
                orphan_colors[i * 4 + 2],
                orphan_colors[i * 4 + 3],
            ]);
        }
        // Geometry styles stay as COLUMNS (stage 2): the support resolution
        // only consults the ORPHAN map (material chain), and the column-based
        // flatten below never builds the 4M-entry geometry hashmap.
        let resolved = ifc_lite_processing::prepass::resolve_prepass_with_style_seeds(
            &stashed_support,
            &mut decoder,
            ifc_lite_processing::prepass::ResolveOptions {
                collect_indexed_colour_full: false,
                defer_attached_styles: false,
            },
            Some((orphan_seed, rustc_hash::FxHashMap::default())),
        );
        let flat = ifc_lite_processing::flat_styles_rgba8_from_geometry_columns(
            geom_ids,
            geom_colors,
            &resolved,
            &mut decoder,
        );

        Ok(styles_payload_with_flat(flat, &resolved).into())
    }
}

/// Serialize a [`ResolvedPrepass`] into the flat `styles` wire payload
/// (styleIds/styleColors/voidKeys/voidCounts/voidValues/materialElementIds/
/// materialColorCounts/materialColors). Shared by the serial pre-pass's
/// styles event and the sharded finalize so the two cannot drift.
pub(super) fn styles_payload(
    resolved: &ifc_lite_processing::prepass::ResolvedPrepass,
    decoder: &mut ifc_lite_core::EntityDecoder,
) -> js_sys::Object {
    let flat = ifc_lite_processing::prepass::flat_styles_rgba8(resolved, decoder);
    styles_payload_with_flat(flat, resolved)
}

/// [`styles_payload`] with the style columns precomputed (the sharded
/// finalize computes them via the column-based flatten).
pub(super) fn styles_payload_with_flat(
    (style_ids_vec, style_colors_vec): (Vec<u32>, Vec<u8>),
    resolved: &ifc_lite_processing::prepass::ResolvedPrepass,
) -> js_sys::Object {
    let (void_keys_vec, void_counts_vec, void_values_vec) =
        ifc_lite_processing::prepass::flat_voids(&resolved.void_index);
    let (mat_ids_vec, mat_counts_vec, mat_colors_vec) =
        ifc_lite_processing::prepass::flat_material_colors(&resolved.element_material_colors);
    let result = js_sys::Object::new();
    crate::api::set_js_prop(&result, "styleIds", &js_sys::Uint32Array::from(style_ids_vec.as_slice()));
    crate::api::set_js_prop(&result, "styleColors", &js_sys::Uint8Array::from(style_colors_vec.as_slice()));
    crate::api::set_js_prop(&result, "voidKeys", &js_sys::Uint32Array::from(void_keys_vec.as_slice()));
    crate::api::set_js_prop(&result, "voidCounts", &js_sys::Uint32Array::from(void_counts_vec.as_slice()));
    crate::api::set_js_prop(&result, "voidValues", &js_sys::Uint32Array::from(void_values_vec.as_slice()));
    crate::api::set_js_prop(&result, "materialElementIds", &js_sys::Uint32Array::from(mat_ids_vec.as_slice()));
    crate::api::set_js_prop(&result, "materialColorCounts", &js_sys::Uint32Array::from(mat_counts_vec.as_slice()));
    crate::api::set_js_prop(&result, "materialColors", &js_sys::Uint8Array::from(mat_colors_vec.as_slice()));
    result
}
