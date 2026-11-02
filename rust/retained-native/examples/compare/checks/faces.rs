// SPDX-License-Identifier: MPL-2.0
//! M11-F (#7955): every published triangle carries a persistent source key, one
//! key per revision-local kernel face (re-derived here from the published mesh,
//! not trusted from attribution), and an uncut product's keys and per-key areas
//! equal the analytic source's. Exact item projection is reported, never gated.
use super::OracleResult;
use ifc_lite_processing::AnalyticQuantitySources;
use ifc_lite_retained_native::{oracle::faces::{self, FaceAreas}, ShapeOnlyProduct};
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
    // Authored face-set rows have no analytic face to match; `face_sets` gates them per row.
    let actual = actual.map(|areas| areas.into_iter().filter(|(k, _)| !k.rsplit_once(':').is_some_and(|(_, role)| role.starts_with("row("))).collect::<BTreeMap<_, _>>());
    // Cut hosts need their source cut set; the native M11-F witnesses gate those through face_bands.
    let (Some(expected), Some(actual)) = (if product.cuts == 0 { faces::uncut(sources, product.product_id) } else { None }, actual)
        else { return results };
    // Face-set rows have no analytic quantity: the authored-row oracles (checks/face_sets.rs) gate them.
    let actual: BTreeMap<_, _> = actual.into_iter().filter(|(key, _)| !key.contains(":row(")).collect();
    let runs = faces::collinear_runs(sources, product.product_id).unwrap_or_default();
    results.extend(compare(&expected, &actual, &runs, tolerances));
    results
}

/// #7955 ruling 3: the only missing key the comparison allows is a 2-4 mm side
/// the kernel folded into a collinear neighbour of the same authored run
/// (verified: dental_clinic #243 `#38165:side(0,8)`, 2.0 mm on y = 1.5074). The
/// 1 nm slack only absorbs the rounding of the width's own arithmetic, so an
/// authored 2.0 or 4.0 mm side is not lost a few ulps short of the bound.
pub const MERGED_SIDE_WIDTH_M: std::ops::RangeInclusive<f64> = 0.002 - 1e-9..=0.004 + 1e-9;

/// Receiver assignments searched per run. Single-receiver sides cost nothing; only
/// sides with a present neighbour on both ends double it (16 such sides).
pub const MAX_MERGE_CHOICES: usize = 1 << 16;

/// Missing keys of one run folded into a present neighbour, when some choice of
/// neighbour per missing key makes every receiving key's area equal its own source
/// area plus the areas it absorbed, within the frozen linear face-area limit.
fn merges(run: &faces::CollinearRun, widest: &BTreeMap<&str, f64>, expected: &FaceAreas, actual: &BTreeMap<String, f64>, limit: f64) -> Vec<(usize, usize)> {
    let present = |i: usize| actual.contains_key(&run.keys[i]);
    let absorbable = |i: usize| !present(i) && expected.contains_key(&run.keys[i]) && MERGED_SIDE_WIDTH_M.contains(&widest[run.keys[i].as_str()]);
    let missing: Vec<usize> = (0..run.keys.len()).filter(|&i| absorbable(i)).collect();
    // Nearest present key on each side, skipping only other absorbable sides.
    let candidates: Vec<Vec<usize>> = missing.iter().map(|&i| {
        let left = (0..i).rev().find(|&j| !absorbable(j)).filter(|&j| present(j));
        let right = (i + 1..run.keys.len()).find(|&j| !absorbable(j)).filter(|&j| present(j));
        left.into_iter().chain(right).collect()
    }).collect();
    if missing.is_empty() || candidates.iter().any(Vec::is_empty) { return Vec::new(); }
    // Only a side between two present neighbours has a choice. Fail closed past
    // MAX_MERGE_CHOICES assignments rather than search unboundedly (#8531).
    let Some(total) = candidates.iter().try_fold(1usize, |n, c| n.checked_mul(c.len())).filter(|&n| n <= MAX_MERGE_CHOICES)
        else { return Vec::new(); };
    for choice in 0..total {
        let (mut rest, mut assignment) = (choice, Vec::new());
        for (&i, options) in missing.iter().zip(&candidates) {
            assignment.push((i, options[rest % options.len()]));
            rest /= options.len();
        }
        let mut receiving: BTreeMap<usize, f64> = BTreeMap::new();
        for &(i, into) in &assignment {
            *receiving.entry(into).or_insert(expected.get(&run.keys[into]).map_or(f64::NAN, |e| e.area_m2)) += expected[&run.keys[i]].area_m2;
        }
        if receiving.iter().all(|(&into, &area)| (actual[&run.keys[into]] - area).abs() / area <= limit) { return assignment; }
    }
    Vec::new()
}

/// Key set and per-key areas of an uncut product against the source. A missing
/// key passes only as a counted `faceKeysKernelMerged` outcome; nothing widens.
pub fn compare(expected: &FaceAreas, actual: &BTreeMap<String, f64>, runs: &[faces::CollinearRun], tolerances: &serde_json::Value) -> Vec<OracleResult> {
    let limit = |kind: &str| tolerances["faceAreaRelative"][kind].as_f64().unwrap_or(f64::NAN);
    let mut expected = expected.clone();
    let mut merged = Vec::new();
    // One key sums every instance of its solid, so it is only as narrow as its
    // widest instance: a 5 mm side elsewhere cannot ride on a 3 mm one.
    let mut widest: BTreeMap<&str, f64> = BTreeMap::new();
    for run in runs {
        for (key, &width) in run.keys.iter().zip(&run.widths_m) {
            let entry = widest.entry(key.as_str()).or_insert(width);
            *entry = entry.max(width);
        }
    }
    for run in runs {
        for (i, into) in merges(run, &widest, &expected, actual, limit("linear")) {
            let (key, target) = (&run.keys[i], &run.keys[into]);
            let area = expected.remove(key).expect("absorbable keys are expected").area_m2;
            expected.get_mut(target).expect("receiving keys are expected").area_m2 += area;
            merged.push(format!("{key} into {target} ({:.3} mm)", widest[run.keys[i].as_str()] * 1e3));
        }
    }
    let mut results = Vec::new();
    if !merged.is_empty() {
        results.push(OracleResult { family: "faceKeysKernelMerged", value: merged.len() as f64, limit: f64::INFINITY, pass: true,
            gated: false, reason: Some(merged.join("; ")), ..Default::default() });
    }
    let mismatched = expected.keys().filter(|k| !actual.contains_key(*k)).count() + actual.keys().filter(|k| !expected.contains_key(*k)).count();
    // Name the keys: an authored width, and whether the published total still holds the area.
    let reason = (mismatched > 0).then(|| {
        let width = |key: &str| widest.get(key).map_or(String::from("no run"), |w| format!("{:.3} mm", w * 1e3));
        let lost: Vec<_> = expected.iter().filter(|(k, _)| !actual.contains_key(*k)).take(8)
            .map(|(k, e)| format!("{k} ({}, {:.6} m2)", width(k), e.area_m2)).collect();
        let extra: Vec<_> = actual.keys().filter(|k| !expected.contains_key(*k)).take(8).cloned().collect();
        format!("missing [{}]; extra [{}]; total source {:.9} published {:.9} m2", lost.join(", "), extra.join(", "),
            expected.values().map(|e| e.area_m2).sum::<f64>(), actual.values().sum::<f64>())
    });
    results.push(OracleResult { family: "faceKeys", value: mismatched as f64, limit: 0., pass: mismatched == 0, gated: true, reason, ..Default::default() });
    for (family, curved) in [("faceAreaLinear", false), ("faceAreaCurved", true)] {
        let worst = expected.iter().filter(|(_, e)| e.curved == curved)
            .map(|(k, e)| actual.get(k).map_or(f64::INFINITY, |a| (a - e.area_m2).abs() / e.area_m2)).fold(0., f64::max);
        let limit = limit(if curved { "curved" } else { "linear" });
        results.push(OracleResult { family, value: worst, limit, pass: worst <= limit, gated: true, ..Default::default() });
    }
    results
}
