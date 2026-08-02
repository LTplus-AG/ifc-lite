//! Pins the Rust STEP string decoder to the shared cross-language test vectors
//! in `tests/fixtures/ifc_string_vectors.json`. The TypeScript decoder in
//! `@ifc-lite/encoding` is held to the same fixture, so the two cannot drift.

use ifc_lite_core::{decode_ifc_string, parse_entity, AttributeValue};

/// The from_token funnel must apply the decoder, so a parsed string attribute
/// surfaces as native UTF-8 (not a literal escape) to every consumer.
#[test]
fn parsed_string_attribute_is_decoded() {
    let line = b"#1=IFCWALL('Br\\X2\\00FC\\X0\\cke',$,$);";
    let (_id, _ty, tokens) = parse_entity(line).expect("entity parses");
    match AttributeValue::from_token(&tokens[0]) {
        AttributeValue::String(s) => assert_eq!(s, "Br\u{FC}cke"),
        other => panic!("expected decoded String, got {other:?}"),
    }
}

#[test]
fn rust_decoder_matches_shared_vectors() {
    let raw = include_str!("fixtures/ifc_string_vectors.json");
    let doc: serde_json::Value = serde_json::from_str(raw).expect("fixture is valid JSON");
    let cases = doc["cases"].as_array().expect("cases is an array");
    assert!(!cases.is_empty(), "fixture has at least one case");

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let encoded = case["encoded"].as_str().expect("encoded is a string");
        let expected = case["decoded"].as_str().expect("decoded is a string");
        assert_eq!(
            decode_ifc_string(encoded),
            expected,
            "case `{name}`: decode({encoded:?})"
        );
    }
}
