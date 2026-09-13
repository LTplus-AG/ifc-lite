// SPDX-License-Identifier: MPL-2.0

//! Rust half of the STEP-string-escape cross-language parity pin (#3300,
//! second half).
//!
//! Pins `ifc_lite_export::escape_step_string` (re-exported from
//! `step_text::escape`) to the shared vectors in
//! `tests/fixtures/step_escape_vectors.json`. The TypeScript escaper
//! (`packages/data/src/step-serializers.ts`, `escapeStepString`, via
//! `packages/data/src/step-escape.parity.test.ts`) is held to the SAME file,
//! so the two cannot drift apart silently. Mirrors `csv_cell_parity.rs`,
//! which does the same for the CSV-cell escaper.

use ifc_lite_export::escape_step_string as escape;

fn fixture() -> serde_json::Value {
    let raw = include_str!("fixtures/step_escape_vectors.json");
    serde_json::from_str(raw).expect("fixture is valid JSON")
}

#[test]
fn rust_step_escape_matches_shared_vectors() {
    let doc = fixture();
    let cases = doc["cases"].as_array().expect("cases is an array");
    assert!(
        cases.len() > 20,
        "an empty or near-empty vector list proves nothing; got {}",
        cases.len()
    );

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let input = case["input"].as_str().expect("input is a string");
        let expected = case["expected"].as_str().expect("expected is a string");

        let got = escape(input);
        assert_eq!(
            got, expected,
            "vector `{name}`: input {input:?} gave {got:?}, want {expected:?}"
        );
    }
}

/// The read side of the same pin: what `escape` writes for non-ASCII text,
/// `ifc_lite_core::decode_ifc_string` reads back. This round trip used to be
/// tested in core against a second encoder (`encode_ifc_string`) that wrote
/// `\X\` for U+0080..U+00FF and never doubled `'`; that encoder is deleted
/// (architecture review behind #4577, F6), so the property is pinned here against
/// the one writer that remains. Inputs carry no `'` or `\`, since doubling
/// those is a literal-context rule the tokenizer's consumers undo, not the
/// decoder.
#[test]
fn escape_round_trips_through_the_core_decoder() {
    for s in ["plain", "Br\u{FC}cke", "\u{1F600}", "a\u{E9}b", "\u{0430}\u{0431}"] {
        assert_eq!(ifc_lite_core::decode_ifc_string(&escape(s)), s, "{s:?}");
    }
}
