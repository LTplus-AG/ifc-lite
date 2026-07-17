// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Demesher wasm surface (`simplifyMeshes`).
//!
//! Simplifies already-produced element meshes (the `MeshData` the consumer
//! holds from the normal load) at a per-element demesher level and returns
//! BOTH render-ready replacement meshes (boundary Y-up convention, ready for
//! `Scene.addMeshes`) and the same triangles in each element's IFC
//! object-placement frame in file units (for the tessellated IFC re-export).
//! Mesh-domain on purpose: a button press must not re-parse the model, and
//! the #1474 placement capture needed for the inverse transform rides on the
//! meshes themselves (`localToWorld`).

use crate::api::IfcAPI;
use ifc_lite_processing::simplify_session::{simplify_element, SimplifyRecordInput, SimplifySkip};
use wasm_bindgen::prelude::*;

/// Flat result of `simplifyMeshes`: per surviving element `i`,
/// `vertexCounts[i]` vertices and `indexCounts[i]` indices taken in order
/// from the concatenated arrays (mirrors the `exportGlbFromMeshes` wire
/// convention). `localPositions` is 1:1 with `renderPositions` (f64, file
/// units, element object frame); `localIndices` is 1:1 with `renderIndices`
/// but in the IFC frame's winding. Skipped elements are reported in
/// `skippedIds` / `skippedReasons` and must keep their original geometry.
#[wasm_bindgen]
pub struct SimplifiedMeshes {
    element_ids: Vec<u32>,
    levels: Vec<u8>,
    vertex_counts: Vec<u32>,
    index_counts: Vec<u32>,
    render_positions: Vec<f32>,
    render_normals: Vec<f32>,
    render_indices: Vec<u32>,
    render_origins: Vec<f64>,
    local_positions: Vec<f64>,
    local_indices: Vec<u32>,
    tris_before: Vec<u32>,
    tris_after: Vec<u32>,
    cavities_dropped: Vec<u32>,
    skipped_ids: Vec<u32>,
    skipped_reasons: Vec<JsValue>,
}

#[wasm_bindgen]
impl SimplifiedMeshes {
    #[wasm_bindgen(getter, js_name = elementIds)]
    pub fn element_ids(&self) -> Vec<u32> {
        self.element_ids.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn levels(&self) -> Vec<u8> {
        self.levels.clone()
    }

    #[wasm_bindgen(getter, js_name = vertexCounts)]
    pub fn vertex_counts(&self) -> Vec<u32> {
        self.vertex_counts.clone()
    }

    #[wasm_bindgen(getter, js_name = indexCounts)]
    pub fn index_counts(&self) -> Vec<u32> {
        self.index_counts.clone()
    }

    #[wasm_bindgen(getter, js_name = renderPositions)]
    pub fn render_positions(&self) -> Vec<f32> {
        self.render_positions.clone()
    }

    #[wasm_bindgen(getter, js_name = renderNormals)]
    pub fn render_normals(&self) -> Vec<f32> {
        self.render_normals.clone()
    }

    #[wasm_bindgen(getter, js_name = renderIndices)]
    pub fn render_indices(&self) -> Vec<u32> {
        self.render_indices.clone()
    }

    /// xyz per element (frame matches the render positions' convention).
    #[wasm_bindgen(getter, js_name = renderOrigins)]
    pub fn render_origins(&self) -> Vec<f64> {
        self.render_origins.clone()
    }

    #[wasm_bindgen(getter, js_name = localPositions)]
    pub fn local_positions(&self) -> Vec<f64> {
        self.local_positions.clone()
    }

    #[wasm_bindgen(getter, js_name = localIndices)]
    pub fn local_indices(&self) -> Vec<u32> {
        self.local_indices.clone()
    }

    #[wasm_bindgen(getter, js_name = trisBefore)]
    pub fn tris_before(&self) -> Vec<u32> {
        self.tris_before.clone()
    }

    #[wasm_bindgen(getter, js_name = trisAfter)]
    pub fn tris_after(&self) -> Vec<u32> {
        self.tris_after.clone()
    }

    #[wasm_bindgen(getter, js_name = cavitiesDropped)]
    pub fn cavities_dropped(&self) -> Vec<u32> {
        self.cavities_dropped.clone()
    }

    #[wasm_bindgen(getter, js_name = skippedIds)]
    pub fn skipped_ids(&self) -> Vec<u32> {
        self.skipped_ids.clone()
    }

    /// Skip reason per `skippedIds` entry (stable slugs:
    /// `no-geometry` / `missing-placement` / `singular-placement` /
    /// `empty-result` / `invalid-unit-scale`).
    #[wasm_bindgen(getter, js_name = skippedReasons)]
    pub fn skipped_reasons(&self) -> Vec<JsValue> {
        self.skipped_reasons.clone()
    }
}

#[wasm_bindgen]
impl IfcAPI {
    /// Simplify already-produced element meshes at per-element demesher
    /// levels (1-4 = cavity removal + clustering at 0.5/0.25/0.10/0.03
    /// triangle ratio, 5 = bounding box).
    ///
    /// One RECORD per input `MeshData` entry (an element may span several
    /// records — per-material submeshes; pass all of them, grouped or not).
    /// Per record `i`: `vertexCounts[i]` vertices from `positions` (and
    /// `normals` when non-empty), `indexCounts[i]` indices from `indices`
    /// (per-record local), `origins[i*3..]`, `localToWorld[i*16..]` valid
    /// only when `localToWorldPresent[i] != 0`, level `levels[i]` (records
    /// of one element must agree). Arrays are the boundary Y-up convention
    /// when `yUp` is true (the browser/SDK case).
    ///
    /// `rtcX/Y/Z` = `coordinateInfo.originShift` (IFC Z-up metres);
    /// `unitScale` = metres per project length unit.
    #[wasm_bindgen(js_name = simplifyMeshes)]
    #[allow(clippy::too_many_arguments)]
    pub fn simplify_meshes(
        &self,
        express_ids: &[u32],
        levels: &[u8],
        positions: &[f32],
        normals: &[f32],
        indices: &[u32],
        vertex_counts: &[u32],
        index_counts: &[u32],
        origins: &[f64],
        local_to_world: &[f64],
        local_to_world_present: &[u8],
        rtc_x: f64,
        rtc_y: f64,
        rtc_z: f64,
        unit_scale: f64,
        y_up: bool,
    ) -> Result<SimplifiedMeshes, JsValue> {
        let n = express_ids.len();
        if levels.len() != n
            || vertex_counts.len() != n
            || index_counts.len() != n
            || origins.len() != n * 3
            || local_to_world.len() != n * 16
            || local_to_world_present.len() != n
        {
            return Err(
                js_sys::Error::new("simplifyMeshes: per-record array lengths disagree").into(),
            );
        }
        let has_normals = !normals.is_empty();
        if has_normals && normals.len() != positions.len() {
            return Err(js_sys::Error::new(
                "simplifyMeshes: normals must be empty or 1:1 with positions",
            )
            .into());
        }

        // Slice the concatenated arrays into per-record views, grouped by
        // element in first-seen order.
        // Accumulate offsets in u64: on wasm32 `usize` is 32-bit, so a hostile
        // `vertexCounts` entry near u32::MAX would overflow `count * 3` /
        // the running sum and could slip past the bounds check below.
        let mut order: Vec<u32> = Vec::new();
        let mut groups: rustc_hash::FxHashMap<u32, Vec<usize>> = rustc_hash::FxHashMap::default();
        let mut pos_offsets: Vec<u64> = Vec::with_capacity(n);
        let mut idx_offsets: Vec<u64> = Vec::with_capacity(n);
        let (mut pos_off, mut idx_off) = (0u64, 0u64);
        for i in 0..n {
            pos_offsets.push(pos_off);
            idx_offsets.push(idx_off);
            pos_off += vertex_counts[i] as u64 * 3;
            idx_off += index_counts[i] as u64;
            if !groups.contains_key(&express_ids[i]) {
                order.push(express_ids[i]);
            }
            groups.entry(express_ids[i]).or_default().push(i);
        }
        // Exact totals: trailing unaccounted positions/indices are a malformed
        // wire payload, not slack to ignore.
        if pos_off != positions.len() as u64 || idx_off != indices.len() as u64 {
            return Err(js_sys::Error::new(
                "simplifyMeshes: counts do not match concatenated array lengths",
            )
            .into());
        }

        let mut out = SimplifiedMeshes {
            element_ids: Vec::new(),
            levels: Vec::new(),
            vertex_counts: Vec::new(),
            index_counts: Vec::new(),
            render_positions: Vec::new(),
            render_normals: Vec::new(),
            render_indices: Vec::new(),
            render_origins: Vec::new(),
            local_positions: Vec::new(),
            local_indices: Vec::new(),
            tris_before: Vec::new(),
            tris_after: Vec::new(),
            cavities_dropped: Vec::new(),
            skipped_ids: Vec::new(),
            skipped_reasons: Vec::new(),
        };

        for id in order {
            let record_indices = &groups[&id];
            let level = levels[record_indices[0]];
            if record_indices.iter().any(|&i| levels[i] != level) {
                return Err(js_sys::Error::new(&format!(
                    "simplifyMeshes: records for element {id} have conflicting levels"
                ))
                .into());
            }
            let records: Vec<SimplifyRecordInput<'_>> = record_indices
                .iter()
                .map(|&i| {
                    // In-bounds by the total check above, so the u64->usize
                    // casts cannot truncate.
                    let (po, pn) = (
                        pos_offsets[i] as usize,
                        (vertex_counts[i] as u64 * 3) as usize,
                    );
                    let io = idx_offsets[i] as usize;
                    let pos = &positions[po..po + pn];
                    let nrm = if has_normals {
                        &normals[po..po + pn]
                    } else {
                        &[][..]
                    };
                    let idx = &indices[io..io + index_counts[i] as usize];
                    let l2w = if local_to_world_present[i] != 0 {
                        let mut m = [0.0f64; 16];
                        m.copy_from_slice(&local_to_world[i * 16..i * 16 + 16]);
                        Some(m)
                    } else {
                        None
                    };
                    SimplifyRecordInput {
                        positions: pos,
                        normals: nrm,
                        indices: idx,
                        origin: [origins[i * 3], origins[i * 3 + 1], origins[i * 3 + 2]],
                        local_to_world: l2w,
                    }
                })
                .collect();

            match simplify_element(&records, level, [rtc_x, rtc_y, rtc_z], unit_scale, y_up) {
                Ok(res) => {
                    out.element_ids.push(id);
                    out.levels.push(level);
                    out.vertex_counts
                        .push((res.render_positions.len() / 3) as u32);
                    out.index_counts.push(res.render_indices.len() as u32);
                    out.render_positions
                        .extend_from_slice(&res.render_positions);
                    out.render_normals.extend_from_slice(&res.render_normals);
                    out.render_indices.extend_from_slice(&res.render_indices);
                    out.render_origins.extend_from_slice(&res.render_origin);
                    out.local_positions.extend_from_slice(&res.local_positions);
                    out.local_indices.extend_from_slice(&res.local_indices);
                    out.tris_before.push(res.tris_before);
                    out.tris_after.push(res.tris_after);
                    out.cavities_dropped.push(res.cavity_components_dropped);
                }
                Err(skip) => {
                    out.skipped_ids.push(id);
                    out.skipped_reasons.push(JsValue::from_str(skip.as_str()));
                    if matches!(skip, SimplifySkip::EmptyResult) {
                        // Unexpected: worth a console breadcrumb, not a failure.
                        web_sys::console::warn_1(&JsValue::from_str(&format!(
                            "[ifc-lite] simplifyMeshes: element {id} produced an empty result; kept original"
                        )));
                    }
                }
            }
        }

        Ok(out)
    }
}
