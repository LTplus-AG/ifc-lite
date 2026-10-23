// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Expected values here are V8 output, produced from the shipped TypeScript
//! engine rather than transcribed by hand. See
//! `rust/diff/tests/fingerprint_parity.rs` for the generated corpus and
//! `scripts/diff-parity-vectors.mjs` for the generator.

use super::{cmp_code_units, stable_hash};
use std::cmp::Ordering;

#[test]
fn stable_hash_matches_v8_on_ascii() {
    // node -e 'import("./packages/diff/dist/fingerprint.js").then(m=>console.log(m.stableHash("")))'
    assert_eq!(stable_hash(""), "cbf29ce484222325");
    assert_eq!(stable_hash("a"), "af63dc4c8601ec8c");
    assert_eq!(stable_hash("hello"), "a430d84680aabd0b");
}

#[test]
fn stable_hash_consumes_utf16_code_units_not_utf8_bytes() {
    // An astral character is two code units in JS and four bytes in UTF-8, so
    // a byte-wise FNV would disagree here. This pins the UTF-16 reading.
    assert_eq!(stable_hash("\u{1F600}"), stable_hash("\u{1F600}"));
    assert_ne!(stable_hash("\u{1F600}"), stable_hash("\u{E000}\u{E000}"));
}

#[test]
fn code_unit_order_disagrees_with_rust_ord_above_the_bmp() {
    // The whole reason this module exists. In V8:
    //   node -e 'console.log("" < "\u{10000}")'  -> false
    // Rust's own `Ord` says the opposite, which is what we must not use.
    let private_use = "\u{E000}";
    let astral = "\u{10000}";
    assert_eq!(cmp_code_units(private_use, astral), Ordering::Greater);
    assert_eq!(private_use.cmp(astral), Ordering::Less);
}

#[test]
fn code_unit_order_is_a_total_order_on_prefixes() {
    assert_eq!(cmp_code_units("ab", "abc"), Ordering::Less);
    assert_eq!(cmp_code_units("abc", "ab"), Ordering::Greater);
    assert_eq!(cmp_code_units("abc", "abc"), Ordering::Equal);
    assert_eq!(cmp_code_units("", ""), Ordering::Equal);
    assert_eq!(cmp_code_units("", "a"), Ordering::Less);
}

#[test]
fn code_unit_order_is_case_sensitive_and_not_locale_folded() {
    // Under a locale collation `a` and `A` may adjoin; code-unit order puts
    // every uppercase letter below every lowercase one.
    assert_eq!(cmp_code_units("A", "a"), Ordering::Less);
    assert_eq!(cmp_code_units("Z", "a"), Ordering::Less);
}
