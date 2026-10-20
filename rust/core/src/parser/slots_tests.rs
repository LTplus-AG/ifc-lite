// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

fn fixture() -> serde_json::Value {
    serde_json::from_str(include_str!("../../tests/fixtures/step_slot_vectors.json")).unwrap()
}

#[test]
fn is_step_value_agrees_with_the_shared_vectors() {
    let fixture = fixture();
    let rows = fixture["values"].as_array().unwrap();
    assert!(rows.len() > 50);
    for row in rows {
        let text = row["text"].as_str().unwrap();
        assert_eq!(is_step_value(text.as_bytes()), row["valid"].as_bool().unwrap(), "{}", row["name"]);
    }
}

#[test]
fn split_step_slots_agrees_with_the_shared_vectors() {
    let fixture = fixture();
    for row in fixture["splits"].as_array().unwrap() {
        let inner = row["inner"].as_str().unwrap();
        let expected: Option<Vec<&str>> = row["slots"]
            .as_array()
            .map(|slots| slots.iter().map(|slot| slot.as_str().unwrap()).collect());
        assert_eq!(split_step_slots(inner), expected, "{}", row["name"]);
    }
}

/// Whatever passes `is_step_value` is a token the tokenizer reads (the
/// writer never emits what the reader cannot re-read), and the other way
/// round for the shapes the tokenizer reads.
#[test]
fn a_step_value_is_a_token_and_a_slot_list_rejoins() {
    let fixture = fixture();
    for row in fixture["values"].as_array().unwrap() {
        let text = row["text"].as_str().unwrap();
        let record = format!("#1=IFCFOO({text});");
        let parsed = crate::parse_entity(record.as_bytes());
        if row["valid"].as_bool().unwrap() {
            assert!(parsed.is_ok(), "{}: {parsed:?}", row["name"]);
        }
    }
    for row in fixture["splits"].as_array().unwrap() {
        let inner = row["inner"].as_str().unwrap();
        if let Some(slots) = split_step_slots(inner) {
            if !slots.is_empty() {
                assert_eq!(slots.join(","), inner, "{}", row["name"]);
            }
        }
    }
}

#[test]
fn deep_nesting_is_refused_not_a_stack_overflow() {
    let deep = "(".repeat(200_000) + &")".repeat(200_000);
    assert!(!is_step_value(deep.as_bytes()));
    assert_eq!(split_step_slots(&deep), None);
    assert_eq!(split_step_slots(&"(".repeat(200_000)), None);
}
