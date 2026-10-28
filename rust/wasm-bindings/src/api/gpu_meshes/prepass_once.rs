// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `buildPrePassOnce`, split at its host boundary: [`IfcAPI::build_prepass_once_data`]
//! is everything the pre-pass computes, [`PrepassOnceData::into_js`] is the JS
//! object it hands the workers. The split exists so the C4-0 parity gate
//! (#7782, `batch_parity_tests.rs`) can feed `produce_batch` the exact wire the
//! browser receives without a JS runtime. The jobs are written straight into
//! the typed array, so the shipping path allocates nothing it did not before.

use crate::api::IfcAPI;
use ifc_lite_core::IfcType;
use ifc_lite_processing::stream_meta::StreamMeta;
use wasm_bindgen::JsValue;

type Job = (u32, usize, usize, IfcType);

pub(super) struct PrepassOnceData {
    /// Simple jobs first, then complex: the wire order `write_jobs` emits.
    pub simple_jobs: Vec<Job>,
    pub complex_jobs: Vec<Job>,
    pub meta: StreamMeta,
    pub void_keys: Vec<u32>,
    pub void_counts: Vec<u32>,
    pub void_values: Vec<u32>,
    pub style_ids: Vec<u32>,
    pub style_colors: Vec<u8>,
    pub style_finishes: Vec<f32>,
    pub material_element_ids: Vec<u32>,
    pub material_color_counts: Vec<u32>,
    pub material_colors: Vec<u8>,
}

impl IfcAPI {
    pub(super) fn build_prepass_once_data(&self, data: &[u8]) -> PrepassOnceData {
        use crate::api::styling::combined_pre_pass;
        use ifc_lite_core::EntityDecoder;
        use ifc_lite_processing::stream_meta::{resolve_stream_meta, MetaMode};

        // Load START on the serial/main-thread path: the previous load's
        // pipeline diagnostics must not accumulate into this one. (The worker
        // path resets via setEntityIndex; every load-start entry point resets.)
        self.reset_pipeline_diagnostics();

        let content = data;

        // Build entity index — a compact columnar index (sorted u32 columns +
        // binary search, #1682) wrapped in Arc for cheap reuse.
        let entity_index = std::sync::Arc::new(super::scan_columnar_index(content));
        // Cache for reuse by processGeometryBatch.
        // Mutex held only briefly to install the Arc; rayon helpers
        // pick up clones below without re-locking. Panic on poison —
        // an earlier panic with the lock held would mean the cached
        // index is in an inconsistent state.
        let mut slot = self
            .cached_entity_index
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *slot = Some(entity_index.clone());
        drop(slot);
        let mut decoder =
            EntityDecoder::with_arc_columnar_index(content, entity_index).with_strict_reals(); // #7678

        // Run combined pre-pass
        let pre_pass = combined_pre_pass(content, &mut decoder);

        // Resolve the load-time meta (unit scales + RTC offset + needs-shift +
        // building rotation) via the shared resolver. This decoder already sees
        // the FULL entity index, so the single-stage `SmallFileSingle` ladder is
        // correct. It also seeds the decoder so nothing downstream re-pays the
        // IFCPROJECT hunt.
        //
        // No job list: this used to hand the detector 25 simple + 25 complex
        // jobs, a window nothing else in the codebase shared, and the frame
        // came out different from the one the overlays and the native pipeline
        // picked for the same file (#4611).
        let meta = resolve_stream_meta(
            MetaMode::SmallFileSingle,
            content,
            pre_pass.project_id,
            pre_pass.site_position,
            &mut decoder,
        );

        // Flat wire encodings from the shared resolver: styles (layered
        // precedence), voids, and the #407 material colour lists.
        let (style_ids, style_colors, style_finishes) =
            ifc_lite_processing::prepass::flat_styles_with_finishes(
                &pre_pass.resolved,
                &pre_pass.geometry_finishes,
                &mut decoder,
            );
        let (void_keys, void_counts, void_values) =
            ifc_lite_processing::prepass::flat_voids(&pre_pass.resolved.void_index);
        let (material_element_ids, material_color_counts, material_colors) =
            ifc_lite_processing::prepass::flat_material_colors(
                &pre_pass.resolved.element_material_colors,
            );

        PrepassOnceData {
            simple_jobs: pre_pass.simple_jobs,
            complex_jobs: pre_pass.complex_jobs,
            meta,
            void_keys,
            void_counts,
            void_values,
            style_ids,
            style_colors,
            style_finishes,
            material_element_ids,
            material_color_counts,
            material_colors,
        }
    }
}

impl PrepassOnceData {
    pub(super) fn total_jobs(&self) -> usize {
        self.simple_jobs.len() + self.complex_jobs.len()
    }

    /// The one jobs-wire encoder, `[id, start, end, ...]` with the u32 casts,
    /// for the JS typed array and for the native parity gate alike.
    pub(super) fn write_jobs(&self, mut write: impl FnMut(u32, u32)) {
        let mut idx = 0u32;
        for &(id, start, end, _) in self.simple_jobs.iter().chain(self.complex_jobs.iter()) {
            write(idx, id);
            write(idx + 1, start as u32);
            write(idx + 2, end as u32);
            idx += 3;
        }
    }

    pub(super) fn into_js(self) -> JsValue {
        let total_jobs = self.total_jobs();
        // Serialize jobs as flat Uint32Array: [id, start, end, id, start, end, ...]
        let jobs_flat = js_sys::Uint32Array::new_with_length((total_jobs * 3) as u32);
        self.write_jobs(|idx, value| jobs_flat.set_index(idx, value));

        let void_keys = js_sys::Uint32Array::from(self.void_keys.as_slice());
        let void_counts = js_sys::Uint32Array::from(self.void_counts.as_slice());
        let void_values = js_sys::Uint32Array::from(self.void_values.as_slice());
        let style_ids = js_sys::Uint32Array::from(self.style_ids.as_slice());
        let style_colors = js_sys::Uint8Array::from(self.style_colors.as_slice());
        let material_element_ids = js_sys::Uint32Array::from(self.material_element_ids.as_slice());
        let material_color_counts =
            js_sys::Uint32Array::from(self.material_color_counts.as_slice());
        let material_colors = js_sys::Uint8Array::from(self.material_colors.as_slice());

        // Build result object
        let result = js_sys::Object::new();
        crate::api::set_js_prop(&result, "jobs", &jobs_flat);
        crate::api::set_js_prop(&result, "totalJobs", &(total_jobs as f64).into());
        // unitScale / planeAngleToRadians / rtcOffset / needsShift / buildingRotation
        // from the shared resolver.
        super::prepass_sharded::set_stream_meta_props(&result, &self.meta);

        crate::api::set_js_prop(&result, "voidKeys", &void_keys);
        crate::api::set_js_prop(&result, "voidCounts", &void_counts);
        crate::api::set_js_prop(&result, "voidValues", &void_values);
        crate::api::set_js_prop(&result, "styleIds", &style_ids);
        crate::api::set_js_prop(&result, "styleColors", &style_colors);
        // #5582: `[metallic, roughness]` per style id, NaN when unauthored.
        crate::api::set_js_prop(
            &result,
            "styleFinishes",
            &js_sys::Float32Array::from(self.style_finishes.as_slice()),
        );
        // #407/#913 §2.3: per-element material colour lists so the batch path
        // can run the transparent/opaque sub-mesh alternation.
        crate::api::set_js_prop(&result, "materialElementIds", &material_element_ids);
        crate::api::set_js_prop(&result, "materialColorCounts", &material_color_counts);
        crate::api::set_js_prop(&result, "materialColors", &material_colors);

        result.into()
    }
}
