// SPDX-License-Identifier: MPL-2.0
//! M11-F (#7955): every published triangle carries a persistent source key, one
//! key per revision-local kernel face (re-derived here from the published mesh,
//! not trusted from attribution), and an uncut product's keys and per-key areas
//! equal the analytic source's. Exact item projection is reported, never gated.
use super::OracleResult;
use ifc_lite_processing::AnalyticQuantitySources;
use ifc_lite_retained_native::{oracle::faces, ShapeOnlyProduct};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

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

/// Triangles whose key differs from the first key on their revision-local face,
/// plus every triangle of a part whose face or key arrays do not cover its mesh.
pub fn nonuniform(product: &ShapeOnlyProduct) -> usize {
    product.parts.iter().filter_map(|part| part.faces.as_ref().map(|faces| (part, faces))).map(|(part, faces)| {
        let count = part.indices.len() / 3;
        if part.revision_local_faces.len() != count || faces.triangles.len() != count
            || faces.triangles.iter().any(|&k| k as usize >= faces.table.len()) { return count.max(1); }
        let mut first: BTreeMap<u32, u32> = BTreeMap::new();
        part.revision_local_faces.iter().zip(&faces.triangles).filter(|(face, key)| *first.entry(**face).or_insert(**key) != **key).count()
    }).sum()
}

/// Report only (spec §3.3): keys projected onto items with `via` folded into the
/// host item, against the exact engine's `geometry_item_id` set for the product.
pub fn exact_projection(model: &str, product: &ShapeOnlyProduct, exact: Option<&(BTreeSet<u32>, bool)>) -> Value {
    let projected: BTreeSet<u32> = product.parts.iter().filter_map(|p| p.faces.as_ref())
        .flat_map(|f| f.table.iter().filter(|k| k.via == 0).map(|k| k.item)).collect();
    let (items, merged) = exact.map_or((None, false), |(items, merged)| (Some(items), *merged));
    json!({"model": model, "id": product.product_id, "retained": projected, "exact": items, "exactMerged": merged,
        "equal": items.is_some_and(|items| *items == projected)})
}
/// Aggregate of the per-product projection rows.
pub fn projection_summary(rows: &[Value]) -> Value {
    let count = |f: &dyn Fn(&Value) -> bool| rows.iter().filter(|r| f(r)).count();
    let differing: Vec<&Value> = rows.iter().filter(|r| r["equal"] == false && r["exact"] != Value::Null).take(20).collect();
    json!({"gated": false, "compared": count(&|r| r["exact"] != Value::Null), "equal": count(&|r| r["equal"] == true),
        "exactMerged": count(&|r| r["exactMerged"] == true), "noExactMesh": count(&|r| r["exact"] == Value::Null), "differingExamples": differing})
}

pub fn check(product: &ShapeOnlyProduct, sources: &AnalyticQuantitySources, tolerances: &serde_json::Value) -> Vec<OracleResult> {
    let total: usize = product.parts.iter().map(|p| p.indices.len() / 3).sum();
    let keyed: usize = product.parts.iter().filter_map(|p| p.faces.as_ref()).map(|f| f.triangles.len()).sum();
    let unkeyed = (total - keyed.min(total)) as f64 / total.max(1) as f64;
    let split = nonuniform(product) as f64;
    let mut results = vec![OracleResult { family: "faceAttribution", value: unkeyed, limit: 0., pass: unkeyed == 0., gated: true, ..Default::default() },
        OracleResult { family: "faceUniformity", value: split, limit: 0., pass: split == 0., gated: true, ..Default::default() }];
    // M4 partitions the original host skin: verify each band's qualifier,
    // then sum its source-key areas before comparing to the uncut host oracle.
    let mut actual = measured(product);
    if product.parts.iter().any(|p| p.layer.is_some()) {
        let valid = product.parts.iter().all(|part| part.layer.is_some_and(|layer| {
            part.faces.as_ref().is_some_and(|faces| faces.table.iter()
                .all(|key| key.role.ends_with(&format!(";band({})", layer.index))))
        }));
        results.push(OracleResult { family: "faceBandQualification", value: f64::from(!valid), limit: 0., pass: valid, gated: true, ..Default::default() });
        if !valid { return results; }
        actual = actual.map(|areas| {
            let mut assembled = BTreeMap::new();
            for (key, area) in areas {
                let (source, _) = key.rsplit_once(";band(").expect("validated band qualifier");
                *assembled.entry(source.to_owned()).or_insert(0.) += area;
            }
            assembled
        });
    }
    // Cut hosts need their source cut set; the native M11-F witnesses gate those through face_bands.
    let (Some(expected), Some(actual)) = (if product.cuts == 0 { faces::uncut(sources, product.product_id) } else { None }, actual)
        else { return results };
    let limit = |kind: &str| tolerances["faceAreaRelative"][kind].as_f64().unwrap_or(f64::NAN);
    let mismatched = expected.keys().filter(|k| !actual.contains_key(*k)).count() + actual.keys().filter(|k| !expected.contains_key(*k)).count();
    results.push(OracleResult { family: "faceKeys", value: mismatched as f64, limit: 0., pass: mismatched == 0, gated: true, ..Default::default() });
    for (family, curved) in [("faceAreaLinear", false), ("faceAreaCurved", true)] {
        let worst = expected.iter().filter(|(_, e)| e.curved == curved)
            .map(|(k, e)| actual.get(k).map_or(f64::INFINITY, |a| (a - e.area_m2).abs() / e.area_m2)).fold(0., f64::max);
        let limit = limit(if curved { "curved" } else { "linear" });
        results.push(OracleResult { family, value: worst, limit, pass: worst <= limit, gated: true, ..Default::default() });
    }
    results
}
