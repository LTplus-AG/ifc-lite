// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use ifc_lite_diff::sidecar_document::{parse_ordered_json, parse_sidecar, serialize_sidecar, SidecarKind};
use serde_json::Value;

#[test]
fn issue_8042_8071_sidecar_utf16_and_json_syntax_match_typescript() {
    let vectors: Vec<Value> = serde_json::from_str(include_str!("sidecar_parse_vectors.json")).unwrap();
    for vector in vectors {
        let kind = if vector["kind"] == "identity" { SidecarKind::Identity } else { SidecarKind::Lineage };
        let text = vector["text"].as_str().unwrap();
        let result = parse_sidecar(text, kind, |_| false);
        if vector["invalid"] == true {
            assert!(result.is_err(), "{} {} accepted: {text}", vector["kind"], vector["name"]);
        } else {
            let parsed = result.unwrap_or_else(|error| panic!("{} {}: {error}", vector["kind"], vector["name"]));
            let wire = serialize_sidecar(&parsed);
            assert_eq!(wire, vector["wire"].as_str().unwrap(), "{} {}", vector["kind"], vector["name"]);
            // Encoding canonicalizes escaped pairs but never changes a lone
            // code unit, duplicate name, or unknown extension on a second pass.
            assert_eq!(serialize_sidecar(&parse_sidecar(&wire, kind, |_| false).unwrap()), wire);
        }
    }
}

#[test]
fn issue_8071_lone_surrogates_are_not_replacement_characters_or_literal_escapes() {
    let input = r#"{"\ud800":"\udc00","�":"�","\\ud800":"\\udc00","\uD800":"last","😀":1,"\ud83d\ude00":2}"#;
    let parsed = parse_ordered_json(input).unwrap();
    assert_eq!(serialize_sidecar(&parsed), "{\n  \"\\ud800\": \"last\",\n  \"�\": \"�\",\n  \"\\\\ud800\": \"\\\\udc00\",\n  \"😀\": 2\n}\n");
}

#[test]
fn issue_8071_json_walk_keeps_a_bounded_nesting_limit() {
    let near_limit = format!("{}0{}", "[".repeat(100), "]".repeat(100));
    assert!(parse_ordered_json(&near_limit).is_ok());
    let over_limit = format!("{}0{}", "[".repeat(200), "]".repeat(200));
    assert!(parse_ordered_json(&over_limit).is_err());
}

#[test]
fn issue_8042_8081_creation_validation_and_diagnostics_keep_utf16() {
    use ifc_lite_diff::sidecar_document::{create_sidecar_document, validate_sidecar_document};
    let vectors: Vec<Value> = serde_json::from_str(include_str!("sidecar_parse_vectors.json")).unwrap();
    for vector in vectors {
        let Some(errors) = vector["errorsWire"].as_str() else { continue; };
        let kind = if vector["kind"] == "identity" { SidecarKind::Identity } else { SidecarKind::Lineage };
        let value = parse_ordered_json(vector["text"].as_str().unwrap()).unwrap();
        assert_eq!(serialize_sidecar(&validate_sidecar_document(&value, kind, |_| false)), errors, "{} {}", vector["kind"], vector["name"]);
        let created = create_sidecar_document(&value, kind, |_| false);
        if let Some(expected) = vector["createWire"].as_str() {
            assert_eq!(serialize_sidecar(&created.unwrap()), expected, "{} {}", vector["kind"], vector["name"]);
        } else {
            assert_eq!(created.unwrap_err().to_json().trim_end(), vector["createErrorJson"].as_str().unwrap(), "{} {}", vector["kind"], vector["name"]);
        }
    }
}
