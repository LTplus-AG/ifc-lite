// SPDX-License-Identifier: MPL-2.0
//! M11-F (#7955): every published triangle carries a persistent source key, and
//! an uncut product's keys and per-key areas equal the analytic source's.
use super::OracleResult;
use ifc_lite_processing::AnalyticQuantitySources;
use ifc_lite_retained_native::{oracle::faces, ShapeOnlyProduct};
use std::collections::BTreeMap;

/// Per-key area through the frame's linear part only, so georeferenced
/// translations never cancel against object-local precision.
pub fn measured(product: &ShapeOnlyProduct) -> Option<BTreeMap<String, f64>> {
    let mut areas = BTreeMap::new();
    for part in &product.parts {
        let faces = part.faces.as_ref()?;
        let m = &part.world_from_object;
        let linear = |v: [f64; 3]| -> [f64; 3] { std::array::from_fn(|i| m[i] * v[0] + m[i + 4] * v[1] + m[i + 8] * v[2]) };
        for (t, &k) in faces.triangles.iter().enumerate() {
            let p = |c: usize| { let i = part.indices[t * 3 + c] as usize * 3; [part.positions[i], part.positions[i + 1], part.positions[i + 2]] };
            let (a, b, c) = (p(0), p(1), p(2));
            let (u, v) = (linear(std::array::from_fn(|i| b[i] - a[i])), linear(std::array::from_fn(|i| c[i] - a[i])));
            let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
            *areas.entry(faces.table.get(k as usize)?.to_string()).or_insert(0.) += (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt() / 2.;
        }
    }
    Some(areas)
}

pub fn check(product: &ShapeOnlyProduct, sources: &AnalyticQuantitySources, tolerances: &serde_json::Value) -> Vec<OracleResult> {
    let total: usize = product.parts.iter().map(|p| p.indices.len() / 3).sum();
    let keyed: usize = product.parts.iter().filter_map(|p| p.faces.as_ref()).map(|f| f.triangles.len()).sum();
    let unkeyed = (total - keyed.min(total)) as f64 / total.max(1) as f64;
    let mut results = vec![OracleResult { family: "faceAttribution", value: unkeyed, limit: 0., pass: unkeyed == 0., gated: true }];
    // Cut hosts need their source cut set; the native M11-F witnesses gate those through face_bands.
    let (Some(expected), Some(actual)) = (if product.cuts == 0 { faces::uncut(sources, product.product_id) } else { None }, measured(product))
        else { return results };
    let limit = |kind: &str| tolerances["faceAreaRelative"][kind].as_f64().unwrap_or(f64::NAN);
    let mismatched = expected.keys().filter(|k| !actual.contains_key(*k)).count() + actual.keys().filter(|k| !expected.contains_key(*k)).count();
    results.push(OracleResult { family: "faceKeys", value: mismatched as f64, limit: 0., pass: mismatched == 0, gated: true });
    for (family, curved) in [("faceAreaLinear", false), ("faceAreaCurved", true)] {
        let worst = expected.iter().filter(|(_, e)| e.curved == curved)
            .map(|(k, e)| actual.get(k).map_or(f64::INFINITY, |a| (a - e.area_m2).abs() / e.area_m2)).fold(0., f64::max);
        let limit = limit(if curved { "curved" } else { "linear" });
        results.push(OracleResult { family, value: worst, limit, pass: worst <= limit, gated: true });
    }
    results
}
