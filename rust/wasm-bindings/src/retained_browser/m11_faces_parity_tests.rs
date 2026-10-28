// SPDX-License-Identifier: MPL-2.0
//! #7955 M11-F: the browser module Worker derives the native persistent face keys.
use std::collections::{BTreeMap, BTreeSet};
use wasm_bindgen::prelude::*;
use wasm_bindgen_test::*;
#[wasm_bindgen(inline_js = "export async function m11fReference() { const r = await fetch('/smlib/m11-f-native-faces.json'); if (!r.ok) throw new Error('M11-F native reference missing'); return r.json(); }
export function m11fKeys(outcome) {
  if (outcome.status === 'refused') return {id: outcome.expressId, code: outcome.code, keys: null};
  if (!outcome.parts.every(part => part.faces && part.faces.triangles.length === part.indices.length / 3)) throw new Error('unkeyed triangles');
  const keys = [...new Set(outcome.parts.flatMap(part => part.faces.table))].sort();
  return {id: outcome.expressId, code: 'published', keys};
}")]
extern "C" {
    #[wasm_bindgen(catch, js_name = m11fReference)]
    async fn reference() -> Result<JsValue, JsValue>;
    #[wasm_bindgen(catch, js_name = m11fKeys)]
    fn keys(outcome: &JsValue) -> Result<JsValue, JsValue>;
}
#[derive(serde::Deserialize, Debug, PartialEq)]
struct Row { id: u32, code: String, keys: Option<BTreeSet<String>> }
#[wasm_bindgen_test(async)]
async fn retained_browser_m11_faces_parity() {
    let native: BTreeMap<String, Vec<Row>> = serde_wasm_bindgen::from_value(reference().await.unwrap()).unwrap();
    for (name, bytes) in [("f-a-curved.ifc", include_bytes!("../../../../tests/fixtures/synthetic-retained/f-a-curved.ifc").as_slice()),
        ("issue_2019_wall_two_overlapping_openings.ifc", include_bytes!("../../../processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc").as_slice()),
        ("swept_disk_trimmed_line.ifc", include_bytes!("../../../geometry/tests/fixtures/swept_disk_trimmed_line.ifc").as_slice())] {
        let expected: BTreeMap<u32, Row> = native[name].iter().map(|r| (r.id, Row { id: r.id, code: r.code.clone(), keys: r.keys.clone() })).collect();
        assert!(expected.values().any(|r| r.keys.as_ref().is_some_and(|k| !k.is_empty())), "{name}: no native keys");
        let mut run = crate::api::IfcAPI::new().retained_model(bytes, None).await.unwrap();
        let mut actual = BTreeMap::new();
        loop {
            let outcome = run.next_outcome();
            if outcome.is_undefined() { break; }
            let row: Row = serde_wasm_bindgen::from_value(keys(&outcome).unwrap()).unwrap();
            actual.insert(row.id, row);
        }
        assert_eq!(actual, expected, "{name}: native and browser persistent face keys");
    }
}
