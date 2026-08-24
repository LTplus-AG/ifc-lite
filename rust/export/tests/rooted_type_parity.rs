// SPDX-License-Identifier: MPL-2.0
//! Pins `rooted_type::is_rooted_type` (Rust) to the shared cross-language
//! sweep in `tests/fixtures/rooted_type_sweep.json`. The JS classifier in
//! `packages/export/src/merged-exporter.ts` (`isRootedType`) is held to the
//! same fixture (`packages/export/src/rooted-type-sweep.parity.test.ts`), so
//! the two "is this entity type an IfcRoot subtype" answers cannot silently
//! drift apart -- the exact failure mode #3015 is about. Exhaustive over the
//! whole IFC4X3 generated schema plus the legacy IFC2X3/IFC4 table, not a
//! sample: a single missing entry is precisely the bug shape a sample can't
//! catch.

use ifc_lite_export::rooted_type::is_rooted_type;

#[test]
fn rust_rooted_type_matches_the_shared_sweep() {
    let raw = include_str!("fixtures/rooted_type_sweep.json");
    let doc: serde_json::Value = serde_json::from_str(raw).expect("fixture is valid JSON");
    let cases = doc["cases"].as_array().expect("cases is an array");
    assert!(
        cases.len() > 900,
        "fixture should exhaustively cover the ~932-type sweep, got {}",
        cases.len()
    );

    let mut mismatches: Vec<String> = Vec::new();
    for case in cases {
        let type_name = case["type"].as_str().expect("type is a string");
        let expected = case["rooted"].as_bool().expect("rooted is a bool");
        let got = is_rooted_type(type_name);
        if got != expected {
            mismatches.push(format!("{type_name}: rust={got} js={expected}"));
        }
    }

    assert!(
        mismatches.is_empty(),
        "{} type(s) disagree with the JS classifier:\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}
