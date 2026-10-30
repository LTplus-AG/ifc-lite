// SPDX-License-Identifier: MPL-2.0
//! Report-only exact bands and measured layer-phase costs (#7955 M4).
use super::{metrics::{transform, Metrics}, precision};
use ifc_lite_processing::ProcessingResult;
use ifc_lite_retained_native::ShapeOnlyProduct;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default)]
pub struct LayerReport {
    band_times: Vec<f64>,
    cap_times: Vec<f64>,
    maximum_snap: f64,
    outcomes: BTreeMap<String, usize>,
    products: Vec<Value>,
}
impl LayerReport {
    pub fn outcome(&mut self, candidates: &BTreeSet<u32>, id: u32, code: &str) {
        if candidates.contains(&id) { *self.outcomes.entry(code.into()).or_default() += 1; }
    }
    pub fn published(&mut self, model: &str, shape: &ShapeOnlyProduct, exact: &ProcessingResult) -> Result<(), String> {
        if !shape.parts.iter().any(|p| p.layer.is_some()) { return Ok(()); }
        self.band_times.push(shape.band_ms);
        self.cap_times.push(shape.cap_ms);
        self.maximum_snap = self.maximum_snap.max(shape.max_snap_metres);
        let meshes: Vec<_> = exact.meshes.iter().filter(|m| m.express_id == shape.product_id).collect();
        let mut exact_parts = Vec::new();
        for mesh in &meshes {
            let points: Vec<_> = mesh.positions.chunks_exact(3).map(|p| exact.frame.to_world(
                std::array::from_fn(|i| mesh.origin[i] + f64::from(p[i])))).collect();
            let mut measured = Metrics::default();
            measured.add_mesh(&points, &mesh.indices)?;
            exact_parts.push(json!({"areaM2": measured.area, "bbox": measured.bbox}));
        }
        let mut retained = Vec::new();
        for (index, part) in shape.parts.iter().enumerate() {
            let Some(mesh) = meshes.get(index).or_else(|| meshes.first()) else { continue; };
            let points: Vec<_> = part.positions.chunks_exact(3).map(|p| precision::round_world(
                exact.frame, mesh.origin, transform(&part.world_from_object, [p[0], p[1], p[2]]))).collect();
            let mut measured = Metrics::default();
            measured.add_mesh(&points, &part.indices)?;
            retained.push(json!({"index": part.layer.map(|l| l.index),
                "materialId": part.layer.map(|l| l.material_id), "areaM2": measured.area,
                "bbox": measured.bbox, "cappedVolumeM3": part.capped_volume_m3}));
        }
        self.products.push(json!({"model": model, "id": shape.product_id,
            "classification": if shape.parts.iter().any(|p| p.curved) { "exact_planar_layers" } else { "planar_layers" },
            "exactComparison": "report", "retainedBandsInExactStorageFrame": retained, "exactBands": exact_parts,
            "bandMs": shape.band_ms, "capMs": shape.cap_ms, "maxSnapMetres": shape.max_snap_metres}));
        Ok(())
    }
    pub fn summary(&self) -> Value {
        json!({"bandMsP95": p95(&self.band_times), "capMsP95": p95(&self.cap_times),
            "maximumSnapMetres": self.maximum_snap, "visualLayerProductsByOutcome": self.outcomes,
            "products": self.products})
    }
}
fn p95(values: &[f64]) -> Option<f64> {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted.get((95 * sorted.len()).div_ceil(100).saturating_sub(1)).copied()
}

/// Report-only inventory: read the canonical index once and independently fold
/// sub-2 mm source layers, including products refused before band construction.
pub fn candidates(bytes: &[u8]) -> BTreeSet<u32> {
    let bundle = ifc_lite_core::SourceBundle::new(bytes.to_vec());
    let mut decoder = bundle.decoder();
    let Ok(text) = std::str::from_utf8(bytes) else { return BTreeSet::new(); };
    let scale = ifc_lite_geometry::GeometryRouter::with_units(text, &mut decoder).unit_scale();
    let index = ifc_lite_geometry::MaterialLayerIndex::from_content(text, &mut decoder).to_flat();
    let mut start = 0;
    let mut result = BTreeSet::new();
    for (&id, &count) in index.element_ids.iter().zip(&index.layer_counts) {
        let end = start + count as usize;
        let mut layers: Vec<_> = index.layer_thicknesses[start..end].iter().map(|t| t * scale).collect();
        while layers.len() > 1 {
            let Some(v) = (0..layers.len()).filter(|&i| layers[i] < 0.002)
                .min_by(|&i, &j| layers[i].total_cmp(&layers[j])) else { break; };
            let neighbour = if v == 0 { 1 } else if v + 1 == layers.len() || layers[v-1] >= layers[v+1] { v-1 } else { v+1 };
            layers[neighbour] += layers[v];
            layers.remove(v);
        }
        if layers.len() >= 2 { result.insert(id); }
        start = end;
    }
    result
}
