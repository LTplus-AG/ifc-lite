// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Pins the Rust tokenizer's notion of "trivia between a type name and its
//! `(`" to the shared vectors in `tests/fixtures/type_paren_trivia_vectors.json`.
//! The TypeScript half (`EntityExtractor` in `@ifc-lite/parser`, whose regexes
//! build on `STEP_TRIVIA`) is held to the same fixture in
//! `packages/parser/src/type-paren-trivia.parity.test.ts`, so the two cannot
//! drift (issue #3789).
//!
//! Widening a parser is only half a fix: the fixture carries the rejections
//! too, so neither half can pass by accepting everything. See the fixture's
//! own `_comment` for what each field means.

use ifc_lite_core::{parse_entity, Token};

fn cases() -> Vec<serde_json::Value> {
    let raw = include_str!("fixtures/type_paren_trivia_vectors.json");
    let doc: serde_json::Value = serde_json::from_str(raw).expect("fixture is valid JSON");
    let cases = doc["cases"].as_array().expect("cases is an array").clone();
    assert!(!cases.is_empty(), "fixture has at least one case");
    cases
}

#[test]
fn rust_entity_trivia_matches_shared_vectors() {
    let mut checked = 0;
    for case in cases() {
        if case["trivia"].as_str() != Some("entity") {
            continue;
        }
        checked += 1;
        let name = case["name"].as_str().expect("name is a string");
        let record = case["record"].as_str().expect("record is a string");
        let accepted = case["accepted"].as_bool().expect("accepted is a bool");
        let owned = record.to_string();
        let result = parse_entity(&owned);

        if !accepted {
            assert!(
                result.is_err(),
                "case `{name}`: expected {record:?} to be rejected, got {result:?}"
            );
            continue;
        }
        let (id, _ifc_type, args) =
            result.unwrap_or_else(|e| panic!("case `{name}`: expected {record:?} to parse: {e}"));
        assert_eq!(id, 1, "case `{name}`: express id");
        let want = case["attributeCount"]
            .as_u64()
            .expect("an accepted entity case carries attributeCount")
            as usize;
        assert_eq!(args.len(), want, "case `{name}`: attribute count");
    }
    assert!(checked >= 10, "expected the entity cases, found {checked}");
}

#[test]
fn rust_typed_value_trivia_matches_shared_vectors() {
    let mut checked = 0;
    for case in cases() {
        if case["trivia"].as_str() != Some("typedValue") {
            continue;
        }
        checked += 1;
        let name = case["name"].as_str().expect("name is a string");
        let record = case["record"].as_str().expect("record is a string");
        let accepted = case["accepted"].as_bool().expect("accepted is a bool");
        let owned = record.to_string();
        let result = parse_entity(&owned);

        if !accepted {
            // Rust rejects the whole record where TypeScript falls through to
            // its plain-string branch; the shared property is only that
            // NEITHER reads attribute 0 as a typed value. Both shapes pass.
            if let Ok((_, _, args)) = result {
                if let Some(arg) = args.first() {
                    assert!(
                        !matches!(arg, Token::TypedValue(..)),
                        "case `{name}`: {record:?} must not read as a typed value, got {arg:?}"
                    );
                }
            }
            continue;
        }
        let (_, _, args) =
            result.unwrap_or_else(|e| panic!("case `{name}`: expected {record:?} to parse: {e}"));
        let want_type = case["typeName"]
            .as_str()
            .expect("an accepted typedValue case carries typeName");
        match args.first() {
            Some(Token::TypedValue(type_name, _)) => assert_eq!(
                *type_name,
                want_type.as_bytes(),
                "case `{name}`: typed value type name"
            ),
            other => panic!("case `{name}`: expected a TypedValue, got {other:?}"),
        }
    }
    assert!(checked >= 5, "expected the typedValue cases, found {checked}");
}
