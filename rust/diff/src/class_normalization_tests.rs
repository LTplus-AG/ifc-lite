// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::with_overrides;
use crate::{engine::{diff_models, DiffOptions}, model::*, JsString};
use std::collections::HashMap;

const LOWER: &str = "\u{16ebb}";
const UPPER: &str = "\u{16ea0}";

fn row(key: &str, class: &str) -> EntityFingerprint {
    EntityFingerprint { key: key.into(), ifc_type: class.into(), data_hash: key.into(),
        geometry_hash: Some(key.into()), aabb: Some(EntityAabb { min: [0.0; 3], max: [1.0; 3] }),
        volume: Some(1.0), components: None, container: None, reference: () }
}
fn unicode_16() -> HashMap<JsString, JsString> {
    [(LOWER.into(), LOWER.into()), (UPPER.into(), UPPER.into())].into()
}
fn excluded_count() -> usize {
    let base = [row("b", UPPER)];
    let options = DiffOptions { key: KeyDiffOptions { exclude_types: vec![LOWER.into()],
        ..Default::default() }, ..Default::default() };
    diff_models(&base, &[], &options).core.entries.len()
}
fn successor_count() -> usize {
    let base = [row("b", "IfcWall")];
    let head = [row("h", UPPER)];
    let options = DiffOptions { match_unpaired_by_content: true, detect_successors: true,
        class_families: Some(vec![vec![LOWER.into(), "IfcWall".into()]]), ..Default::default() };
    diff_models(&base, &head, &options).successors.unwrap().len()
}

#[test]
fn issue_8042_native_unicode_17_default_and_lossless_units_remain() {
    assert_eq!(JsString::from(LOWER).normalized_class(), UPPER);
    assert_eq!(JsString::from("\u{a7d3}").normalized_class(), "\u{a7d2}");
    let value = JsString::from_units(vec![0xfeff, 0xd800, 0x61, 0xdfff, 0x20]);
    assert_eq!(value.normalized_class().units(), &[0xd800, 0x41, 0xdfff]);
    assert_eq!(excluded_count(), 0);
    assert_eq!(successor_count(), 1);
}

#[test]
fn issue_8042_nested_comparisons_restore_outer_then_native_behavior() {
    with_overrides(unicode_16(), || {
        assert_eq!(excluded_count(), 1);
        assert_eq!(successor_count(), 0);
        with_overrides(HashMap::new(), || {
            assert_eq!(excluded_count(), 0);
            assert_eq!(successor_count(), 1);
        });
        assert_eq!(excluded_count(), 1);
        assert_eq!(successor_count(), 0);
        // The context is thread-local, even while an outer comparison is live.
        std::thread::spawn(|| {
            assert_eq!(excluded_count(), 0);
            assert_eq!(successor_count(), 1);
        }).join().unwrap();
    });
    assert_eq!(excluded_count(), 0);
    assert_eq!(successor_count(), 1);
}

#[test]
fn issue_8042_normalized_outputs_are_fixed_points_even_for_older_unicode() {
    let original = JsString::from(format!("\u{feff}{LOWER} "));
    with_overrides([(original.clone(), LOWER.into())].into(), || {
        let normalized = original.normalized_class();
        assert_eq!(normalized, LOWER);
        assert_eq!(normalized.normalized_class(), LOWER);
    });
    assert_eq!(original.normalized_class(), UPPER);
}

#[test]
fn issue_8042_error_and_unwind_restore_context_before_reuse() {
    with_overrides(unicode_16(), || {
        let error: Result<(), &str> = with_overrides(HashMap::new(), || {
            assert_eq!(successor_count(), 1);
            Err("comparison stopped")
        });
        assert_eq!(error, Err("comparison stopped"));
        assert_eq!(successor_count(), 0);
        let unwind = std::panic::catch_unwind(|| with_overrides(HashMap::new(), || {
            assert_eq!(excluded_count(), 0);
            panic!("issue #8042: interrupted nested comparison");
        }));
        assert!(unwind.is_err());
        assert_eq!(excluded_count(), 1);
    });
    assert_eq!(excluded_count(), 0);
    assert_eq!(successor_count(), 1);
}
