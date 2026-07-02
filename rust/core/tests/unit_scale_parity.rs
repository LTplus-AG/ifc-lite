// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Pins the Rust length-unit-scale extractor to the shared cross-language test
//! vectors in `tests/fixtures/unit_scale_vectors.json`. The TypeScript extractor
//! in `@ifc-lite/parser` (`packages/parser/src/unit-scale.parity.test.ts`) is
//! held to the same fixture, so the two cannot drift.

use ifc_lite_core::{
    extract_length_unit_scale, try_extract_length_unit_scale, EntityDecoder, EntityScanner,
};

/// Locate the first IFCPROJECT id the way the real pipeline does: from the
/// entity scan (ordering-independent, so the late-project case works).
fn find_project_id(ifc: &str) -> Option<u32> {
    let mut scanner = EntityScanner::new(ifc);
    while let Some((id, type_name, _start, _end)) = scanner.next_entity() {
        if type_name == "IFCPROJECT" {
            return Some(id);
        }
    }
    None
}

#[test]
fn rust_unit_scale_matches_shared_vectors() {
    let raw = include_str!("fixtures/unit_scale_vectors.json");
    let doc: serde_json::Value = serde_json::from_str(raw).expect("fixture is valid JSON");
    let cases = doc["cases"].as_array().expect("cases is an array");
    assert!(!cases.is_empty(), "fixture has at least one case");

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let ifc = case["ifc"].as_str().expect("ifc is a string");
        let expected = case["lengthUnitScale"]
            .as_f64()
            .expect("lengthUnitScale is a number");

        let project_id = find_project_id(ifc)
            .unwrap_or_else(|| panic!("case `{name}`: fixture must contain an IFCPROJECT"));

        let mut decoder = EntityDecoder::new(ifc);
        let got = extract_length_unit_scale(&mut decoder, project_id)
            .unwrap_or_else(|e| panic!("case `{name}`: extraction failed: {e:?}"));

        // Relative tolerance: every expected scale is a positive constant.
        let tol = expected.abs() * 1e-12;
        assert!(
            (got - expected).abs() <= tol,
            "case `{name}`: got {got}, want {expected}"
        );

        // The streaming pre-pass sibling must never CONTRADICT the full
        // extractor: on a complete index it either resolves to the same scale
        // or defers (None, e.g. for conversion-based length units).
        if let Some(pre) = try_extract_length_unit_scale(&mut decoder, project_id) {
            assert!(
                (pre - expected).abs() <= tol,
                "case `{name}`: try_extract_length_unit_scale got {pre}, want {expected}"
            );
        }
    }
}
