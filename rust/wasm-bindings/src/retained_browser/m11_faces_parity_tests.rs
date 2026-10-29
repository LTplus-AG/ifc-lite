// SPDX-License-Identifier: MPL-2.0
//! #7955 M11-F: the browser module Worker derives the native persistent face keys,
//! with the same triangle count per key and per-key areas within the preregistered
//! `faceAreaRelative.linear` bound: native and wasm kernels may place the vertices of a
//! cut curved surface a few 1e-10 apart, which is geometry, not face identity.
use std::collections::{BTreeMap, BTreeSet};
use wasm_bindgen::prelude::*;
use wasm_bindgen_test::*;
#[wasm_bindgen(inline_js = "export async function m11fReference() { const r = await fetch('/smlib/m11-f-native-faces.json'); if (!r.ok) throw new Error('M11-F native reference missing'); return r.json(); }
export function m11fKeys(outcome) {
  if (outcome.status === 'refused') return {id: outcome.expressId, code: outcome.code, keys: null};
  if (!outcome.parts.every(part => part.faces && part.faces.triangles.length === part.indices.length / 3)) throw new Error('unkeyed triangles');
  const keys = [...new Set(outcome.parts.flatMap(part => part.faces.table))].sort();
  const faces = {};
  for (const part of outcome.parts) {
    const p = part.positions, m = part.worldFromObject, ids = part.indices;
    const linear = v => [0, 1, 2].map(i => m[i] * v[0] + m[i + 4] * v[1] + m[i + 8] * v[2]);
    part.faces.triangles.forEach((k, t) => {
      const at = c => [0, 1, 2].map(i => p[ids[t * 3 + c] * 3 + i]);
      const [a, b, c] = [at(0), at(1), at(2)];
      const u = linear([0, 1, 2].map(i => b[i] - a[i])), v = linear([0, 1, 2].map(i => c[i] - a[i]));
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const face = faces[part.faces.table[k]] ??= {triangles: 0, area: 0};
      face.triangles += 1;
      face.area += Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]) / 2;
    });
  }
  return {id: outcome.expressId, code: 'published', keys, faces};
}")]
extern "C" {
    #[wasm_bindgen(catch, js_name = m11fReference)]
    async fn reference() -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = m11fKeys)]
    fn keys(outcome: &JsValue) -> Result<JsValue, JsValue>;
}
#[derive(serde::Deserialize, Debug, PartialEq, Clone)]
struct Face { triangles: usize, area: f64 }
#[derive(serde::Deserialize, Debug, Clone)]
struct Row { id: u32, code: String, keys: Option<BTreeSet<String>>, #[serde(default)] faces: Option<BTreeMap<String, Face>> }
#[wasm_bindgen_test(async)]
async fn retained_browser_m11_faces_parity() {
    let native: BTreeMap<String, Vec<Row>> = serde_wasm_bindgen::from_value(reference().await.unwrap()).unwrap();
    let tolerances: serde_json::Value = serde_json::from_str(include_str!("../../../../tests/fixtures/cli-retained/tolerances.d/m11-f.json")).unwrap();
    let relative = tolerances["faceAreaRelative"]["linear"].as_f64().unwrap();
    for (name, bytes) in [("f-a-curved.ifc", include_bytes!("../../../../tests/fixtures/synthetic-retained/f-a-curved.ifc").as_slice()),
        ("issue_2019_wall_two_overlapping_openings.ifc", include_bytes!("../../../processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc").as_slice()),
        ("swept_disk_trimmed_line.ifc", include_bytes!("../../../geometry/tests/fixtures/swept_disk_trimmed_line.ifc").as_slice()),
        ("f-i-presentation.ifc", include_bytes!("../../../../tests/fixtures/synthetic-retained/f-i-presentation.ifc").as_slice())] {
        let expected: BTreeMap<u32, Row> = native[name].iter().map(|r| (r.id, r.clone())).collect();
        assert!(expected.values().any(|r| r.keys.as_ref().is_some_and(|k| !k.is_empty())), "{name}: no native keys");
        let mut run = crate::api::IfcAPI::new().retained_model(bytes, None).await.unwrap();
        let mut actual = BTreeMap::new();
        loop {
            let outcome = run.next_outcome();
            if outcome.is_undefined() { break; }
            let row: Row = serde_wasm_bindgen::from_value(keys(&outcome).unwrap()).unwrap();
            actual.insert(row.id, row);
        }
        let summary = |rows: &BTreeMap<u32, Row>| rows.values().map(|r| (r.id, r.code.clone(), r.keys.clone())).collect::<Vec<_>>();
        assert_eq!(summary(&actual), summary(&expected), "{name}: native and browser persistent face keys");
        for (id, row) in &expected {
            let Some(native) = &row.faces else { continue };
            let browser = actual[id].faces.as_ref().unwrap_or_else(|| panic!("{name} #{id}: browser faces missing"));
            assert_eq!(browser.keys().collect::<Vec<_>>(), native.keys().collect::<Vec<_>>(), "{name} #{id}");
            for (key, face) in native {
                let other = &browser[key];
                assert_eq!(other.triangles, face.triangles, "{name} #{id} {key}: triangle count");
                assert!((other.area - face.area).abs() <= relative * face.area, "{name} #{id} {key}: area {} vs {}", other.area, face.area);
            }
        }
    }
}
