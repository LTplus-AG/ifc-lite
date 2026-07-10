// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Pins the Rust unit-SYMBOL resolver (`rust/core/src/project_units`) to the
//! shared cross-language test vectors in `tests/fixtures/unit_symbol_vectors.json`.
//! The TypeScript resolver in `@ifc-lite/parser`
//! (`packages/parser/src/project-units.parity.test.ts`) is held to the same
//! fixture, so the two cannot drift (issue #1573).

use ifc_lite_core::{EntityScanner, ProjectUnits};

fn find_project_id(ifc: &str) -> Option<u32> {
    let mut scanner = EntityScanner::new(ifc);
    while let Some((id, type_name, _s, _e)) = scanner.next_entity() {
        if type_name == "IFCPROJECT" {
            return Some(id);
        }
    }
    None
}

#[test]
fn rust_unit_symbols_match_shared_vectors() {
    let raw = include_str!("fixtures/unit_symbol_vectors.json");
    let doc: serde_json::Value = serde_json::from_str(raw).expect("fixture is valid JSON");
    let cases = doc["cases"].as_array().expect("cases is an array");
    assert!(!cases.is_empty(), "fixture has at least one case");

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let ifc = case["ifc"].as_str().expect("ifc is a string");
        let project_id = find_project_id(ifc)
            .unwrap_or_else(|| panic!("case `{name}`: fixture must contain an IFCPROJECT"));

        let mut decoder = ifc_lite_core::EntityDecoder::new(ifc);
        let units = ProjectUnits::resolve(&mut decoder, project_id);

        for m in case["measures"].as_array().expect("measures is an array") {
            let measure = m["measure"].as_str().expect("measure is a string");
            let got = units.unit_for_measure(measure);

            match m["symbol"].as_str() {
                None => assert!(
                    got.is_none(),
                    "case `{name}` / {measure}: expected no unit, got {got:?}"
                ),
                Some(expected_symbol) => {
                    let got = got.unwrap_or_else(|| {
                        panic!("case `{name}` / {measure}: expected `{expected_symbol}`, got None")
                    });
                    assert_eq!(
                        got.symbol, expected_symbol,
                        "case `{name}` / {measure}: symbol mismatch"
                    );
                    let expected_scale = m["siScale"].as_f64().expect("siScale is a number");
                    let tol = expected_scale.abs() * 1e-12;
                    assert!(
                        (got.si_scale - expected_scale).abs() <= tol,
                        "case `{name}` / {measure}: si_scale got {}, want {expected_scale}",
                        got.si_scale
                    );
                }
            }
        }
    }
}
