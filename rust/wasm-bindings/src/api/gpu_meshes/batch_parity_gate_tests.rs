// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Fail closed on new, stale, duplicate AND changed same-key exceptions (#7782).
use serde_json::Value;
use std::collections::BTreeMap;

fn key(row: &Value) -> String {
    serde_json::to_string(&(&row["fixture"], &row["axis"], &row["element"])).unwrap()
}

pub(super) fn reconcile(observed: &[Value], expected: &[Value]) -> Vec<String> {
    let mut failures = Vec::new();
    let mut actual = BTreeMap::new();
    for row in observed {
        if actual.insert(key(row), row).is_some() {
            failures.push(format!("duplicate observed {}", key(row)));
        }
    }
    let mut rows = BTreeMap::new();
    for row in expected {
        let evidence = &row["evidence"];
        if rows.insert(key(evidence), evidence).is_some() {
            failures.push(format!("duplicate expected {}", key(evidence)));
        }
    }
    for (key, value) in &actual {
        match rows.get(key) {
            None => failures.push(format!("unexpected {key}")),
            Some(expected) if value != expected => failures.push(format!("changed payload {key}")),
            Some(_) => {}
        }
    }
    for key in rows.keys() {
        if !actual.contains_key(key) {
            failures.push(format!("stale {key}: delete its EXPECTED_DIFF row"));
        }
    }
    failures
}

#[test]
fn new_stale_duplicate_and_changed_evidence_fail_7782() {
    let evidence = serde_json::json!({"fixture":"f", "axis":"RefusalCounters", "element":null,
        "native":[0,0], "browser":null});
    let expected = serde_json::json!({"evidence": evidence});
    assert!(reconcile(
        std::slice::from_ref(&evidence),
        std::slice::from_ref(&expected)
    )
    .is_empty());
    assert!(!reconcile(&[], std::slice::from_ref(&expected)).is_empty());
    assert!(!reconcile(std::slice::from_ref(&evidence), &[]).is_empty());
    assert!(!reconcile(
        &[evidence.clone(), evidence.clone()],
        std::slice::from_ref(&expected)
    )
    .is_empty());
    assert!(!reconcile(
        std::slice::from_ref(&evidence),
        &[expected.clone(), expected.clone()]
    )
    .is_empty());
    for browser in [
        serde_json::json!({}),
        serde_json::json!([0, 0]),
        serde_json::json!(["bad", 0]),
    ] {
        let mut changed = evidence.clone();
        changed["browser"] = browser;
        assert!(!reconcile(&[changed], std::slice::from_ref(&expected)).is_empty());
    }
    let mut changed = evidence;
    changed["native"] = serde_json::json!([1, 0]);
    assert!(!reconcile(&[changed], &[expected]).is_empty());
}
