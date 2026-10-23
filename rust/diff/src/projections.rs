// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Sorted-string-list projections, the shape shared by every fingerprint
//! field that is a bag of resolved NAMES.
//!
//! Ported from `packages/diff/src/fingerprint-projections.ts`. Materials and
//! classification references are both name lists at the wire level: order is
//! not content, duplicates are, and a blank or whitespace-only name says
//! nothing. Names rather than entity references, because an express id is
//! reassigned on every save, so comparing references flags every re-exported
//! element.

use crate::utf16::cmp_code_units;

/// ECMAScript WhiteSpace + LineTerminator, as used by String.prototype.trim.
/// Rust's Unicode whitespace includes U+0085 and excludes U+FEFF; JS does the reverse.
fn is_ecmascript_whitespace(ch: char) -> bool {
    matches!(ch, '\u{0009}'..='\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}'
        | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}'
        | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

/// Sort by UTF-16 code unit, drop blank and whitespace-only entries, keep
/// duplicates.
///
/// Absent and empty project identically — the documented contract of every
/// field this backs, and the reason the fingerprint omits the key entirely
/// when the result is empty.
pub fn sorted_string_list(values: &[String]) -> Vec<String> {
    let mut kept: Vec<String> = values
        .iter()
        .filter(|name| !name.chars().all(is_ecmascript_whitespace))
        .cloned()
        .collect();
    kept.sort_by(|a, b| cmp_code_units(a, b));
    kept
}

#[cfg(test)]
mod tests {
    use super::sorted_string_list;

    fn list(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn sorts_by_code_unit_and_keeps_duplicates() {
        let out = sorted_string_list(&list(&["b", "A", "b", "a"]));
        assert_eq!(out, list(&["A", "a", "b", "b"]));
    }

    #[test]
    fn drops_blank_and_whitespace_only_names() {
        let out = sorted_string_list(&list(&["steel", "", "   ", "\t\n", "concrete"]));
        assert_eq!(out, list(&["concrete", "steel"]));
    }

    #[test]
    fn absent_and_empty_project_identically() {
        assert_eq!(sorted_string_list(&[]), Vec::<String>::new());
        assert_eq!(sorted_string_list(&list(&["  "])), Vec::<String>::new());
    }

    #[test]
    fn javascript_whitespace_differs_from_rust_issue_8042() {
        assert_eq!(sorted_string_list(&list(&["\u{FEFF}", "\u{0085}", " x "])),
            list(&[" x ", "\u{0085}"]));
    }
}
