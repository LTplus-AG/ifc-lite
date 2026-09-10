// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/// StoreEditor has no unqualified literal-string marker. Its STEP writer
/// interprets these exact trimmed spellings as structural tokens (#4441).
/// Refuse before authoring; do not change ordinary strings or add quotes that
/// would themselves become label content. Match ECMAScript String.trim (not
/// Rust's broader Unicode White_Space predicate, which differs at U+0085).
pub(super) fn validate(value: &str, label: &str) -> Result<(), String> {
    let token = value.trim_matches(|c| matches!(c,
        '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}'));
    let reserved = matches!(token, "$" | "*")
        || token.strip_prefix('#').is_some_and(|id|
            !id.is_empty() && id.bytes().all(|c| c.is_ascii_digit()))
        || token.strip_prefix('.').and_then(|s| s.strip_suffix('.')).is_some_and(|s|
            !s.is_empty() && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_'));
    if reserved {
        return Err(format!("{label} is a reserved appearance wire token and cannot be preserved"));
    }
    Ok(())
}
