// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Expected strings here are V8's `JSON.stringify` output. The broad corpus
//! lives in `tests/fingerprint_parity.rs`, generated from the shipped engine;
//! these cover the serializer's own edges, including the ones the fixture
//! cannot reach because `serde_json` normalizes them on the way in.

use super::{non_finite_token, stringify, stringify_sorted, JsonValue};

fn obj(entries: &[(&str, JsonValue)]) -> JsonValue {
    JsonValue::Object(
        entries
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.clone()))
            .collect(),
    )
}

#[test]
fn primitives_match_json_stringify() {
    assert_eq!(stringify(&JsonValue::Null), "null");
    assert_eq!(stringify(&JsonValue::Bool(true)), "true");
    assert_eq!(stringify(&JsonValue::Bool(false)), "false");
    assert_eq!(stringify(&JsonValue::String("x".to_owned())), "\"x\"");
}

#[test]
fn numbers_use_ecmascript_formatting_not_rust_display() {
    // node -e 'for (const n of [1e21,1e-7,0.1,-0,1/3,5e-324,42]) console.log(JSON.stringify(n))'
    let cases: &[(f64, &str)] = &[
        (1e21, "1e+21"),
        (1e-7, "1e-7"),
        (0.1, "0.1"),
        (-0.0, "0"),
        (1.0 / 3.0, "0.3333333333333333"),
        (5e-324, "5e-324"),
        (42.0, "42"),
        (12.5, "12.5"),
    ];
    for (value, expected) in cases {
        assert_eq!(
            stringify(&JsonValue::Number(*value)),
            *expected,
            "formatting disagreed for {value}",
        );
    }
}

#[test]
fn rust_display_really_does_disagree() {
    // Guards the premise of the test above: if Rust ever started formatting
    // these the ECMAScript way, `ryu-js` would stop being load-bearing and
    // this crate's dependency could be reconsidered.
    assert_ne!(format!("{}", 1e21_f64), "1e+21");
    assert_ne!(format!("{}", 1e-7_f64), "1e-7");
}

#[test]
fn non_finite_numbers_serialize_as_null() {
    // `JSON.stringify(NaN) === "null"`. The fingerprint layer converts these
    // to string tokens before they reach the serializer precisely because
    // this collides with an absent value.
    assert_eq!(stringify(&JsonValue::Number(f64::NAN)), "null");
    assert_eq!(stringify(&JsonValue::Number(f64::INFINITY)), "null");
    assert_eq!(stringify(&JsonValue::Number(f64::NEG_INFINITY)), "null");
}

#[test]
fn non_finite_tokens_use_ecmascript_spelling() {
    // ECMAScript `String(n)`, not Rust's `Display` (`inf` / `-inf`).
    assert_eq!(non_finite_token(f64::NAN), "NaN");
    assert_eq!(non_finite_token(f64::INFINITY), "Infinity");
    assert_eq!(non_finite_token(f64::NEG_INFINITY), "-Infinity");
}

#[test]
fn escaping_matches_v8_exactly() {
    // Expectations are assembled from character codes rather than written as
    // literals. That is deliberate: an earlier draft spelled them as Rust
    // escapes and a tool in the authoring path rewrote `\u0000` into an actual
    // NUL byte, so the test asserted that a control character serializes to
    // itself and failed against correct output. Nothing in this function can
    // be silently rewritten, because nothing in it is an escape sequence.
    let quote = char::from_u32(0x22).expect("ASCII quote");
    let backslash = char::from_u32(0x5c).expect("ASCII backslash");
    let quoted = |body: &str| format!("{quote}{body}{quote}");

    // (input code point, expected body between the quotes)
    let cases: Vec<(u32, String)> = vec![
        (0x22, format!("{backslash}{quote}")),
        (0x5c, format!("{backslash}{backslash}")),
        (0x08, format!("{backslash}b")),
        (0x09, format!("{backslash}t")),
        (0x0a, format!("{backslash}n")),
        (0x0c, format!("{backslash}f")),
        (0x0d, format!("{backslash}r")),
        // Every other C0 control takes the lowercase \u00xx form.
        (0x00, format!("{backslash}u0000")),
        (0x01, format!("{backslash}u0001")),
        (0x0b, format!("{backslash}u000b")),
        (0x1f, format!("{backslash}u001f")),
    ];

    for (code, expected_body) in cases {
        let input = char::from_u32(code).expect("valid scalar value").to_string();
        assert_eq!(
            stringify(&JsonValue::String(input)),
            quoted(&expected_body),
            "escaping disagreed for U+{code:04X}",
        );
    }
}

#[test]
fn characters_v8_leaves_alone_are_left_alone() {
    // Several JSON writers escape `/`, `U+007F`, `U+2028` and `U+2029`. V8
    // does not, and this has to match V8, so each is pinned explicitly.
    for raw in ["/", "\u{7f}", "\u{2028}", "\u{2029}", "\u{e9}", "\u{1f600}"] {
        assert_eq!(
            stringify(&JsonValue::String(raw.to_owned())),
            format!("\"{raw}\""),
            "V8 leaves {raw:?} unescaped",
        );
    }
}

#[test]
fn astral_characters_survive_serialization() {
    // Regression guard: an earlier draft walked UTF-16 code units and dropped
    // surrogate pairs entirely, silently emptying any astral string.
    let emoji = "\u{1f600}";
    let serialized = stringify(&JsonValue::String(emoji.to_owned()));
    assert_eq!(serialized, format!("\"{emoji}\""));
    assert!(serialized.chars().any(|ch| ch == '\u{1f600}'));
}

#[test]
fn stringify_preserves_insertion_order() {
    // `buildDataFingerprint` hashes an object literal whose key order is part
    // of the format, so this must NOT sort.
    let value = obj(&[
        ("Type", JsonValue::String("IfcWall".to_owned())),
        ("Name", JsonValue::String("W".to_owned())),
    ]);
    assert_eq!(stringify(&value), r#"{"Type":"IfcWall","Name":"W"}"#);
}

#[test]
fn stringify_sorted_sorts_keys_and_differs_from_insertion_order() {
    let value = obj(&[
        ("b", JsonValue::Number(1.0)),
        ("a", JsonValue::Number(2.0)),
    ]);
    assert_eq!(stringify(&value), r#"{"b":1,"a":2}"#);
    assert_eq!(stringify_sorted(&value), r#"{"a":2,"b":1}"#);
}

#[test]
fn stringify_sorted_is_insensitive_to_input_key_order() {
    let forward = obj(&[
        ("a", JsonValue::Number(2.0)),
        ("b", JsonValue::Number(1.0)),
    ]);
    let reverse = obj(&[
        ("b", JsonValue::Number(1.0)),
        ("a", JsonValue::Number(2.0)),
    ]);
    assert_eq!(stringify_sorted(&forward), stringify_sorted(&reverse));
    assert_ne!(stringify(&forward), stringify(&reverse));
}

#[test]
fn sorted_keys_use_utf16_order() {
    // The astral key sorts BELOW U+E000 in UTF-16 code units, and above it in
    // Rust's native ordering. Confirmed against V8:
    //   node -e 'console.log(JSON.stringify(Object.keys({"\u{10000}":1,"":1}).sort()))'
    //   ["\u{10000}",""]
    let value = obj(&[
        ("\u{e000}", JsonValue::Number(1.0)),
        ("\u{10000}", JsonValue::Number(2.0)),
    ]);
    assert_eq!(
        stringify_sorted(&value),
        format!("{{\"{}\":2,\"{}\":1}}", "\u{10000}", "\u{e000}"),
    );
}

#[test]
fn nested_structures_serialize_recursively() {
    let value = obj(&[(
        "outer",
        JsonValue::Array(vec![
            JsonValue::Number(1.0),
            obj(&[("inner", JsonValue::Null)]),
            JsonValue::Bool(true),
        ]),
    )]);
    assert_eq!(stringify(&value), r#"{"outer":[1,{"inner":null},true]}"#);
}

#[test]
fn empty_containers_match_json_stringify() {
    assert_eq!(stringify(&JsonValue::Array(Vec::new())), "[]");
    assert_eq!(stringify(&JsonValue::Object(Vec::new())), "{}");
    assert_eq!(stringify_sorted(&JsonValue::Object(Vec::new())), "{}");
}
