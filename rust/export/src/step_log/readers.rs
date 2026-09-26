// SPDX-License-Identifier: MPL-2.0
//! The per-record text readers of `step-property-set-readers.ts` and
//! `step-property-set-index.ts`.
//!
//! Each TypeScript reader is a regular expression over the raw record text,
//! and each is ported as the match that expression makes, quirks included:
//! a set name is the RAW text between the quotes (an escaped `''` or `\X2\`
//! name does not match the decoded name an edit carries), and
//! `getRelatedEntities`' pattern starts at the record's FIRST `(`, so the
//! "related objects" it reports include the owner-history reference. The
//! writer's parity target is what those readers answer, not what the record
//! means.

fn ws(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && b[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

fn ws_back(b: &[u8], mut i: usize) -> usize {
    while i > 0 && b[i - 1].is_ascii_whitespace() {
        i -= 1;
    }
    i
}

/// Every `#<digits>` in `text`, as the global `/#(\d+)/g` finds them.
pub(crate) fn hash_ids(text: &str) -> Vec<u32> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'#' {
            let start = i + 1;
            let mut j = start;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            if j > start {
                if let Ok(id) = text[start..j].parse::<u32>() {
                    out.push(id);
                }
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    out
}

/// `/KEYWORD\s*\([^,]*,[^,]*,'([^']*)'/i`: the raw third argument of the first
/// occurrence of `keyword` that the pattern completes on.
fn quoted_third(text: &str, keyword: &str) -> Option<String> {
    let upper = text.to_ascii_uppercase();
    let b = text.as_bytes();
    let mut from = 0;
    while let Some(pos) = upper[from..].find(keyword) {
        let at = from + pos;
        from = at + 1;
        let mut i = ws(b, at + keyword.len());
        if b.get(i) != Some(&b'(') {
            continue;
        }
        i += 1;
        let Some(c1) = text[i..].find(',').map(|p| i + p) else { continue };
        let Some(c2) = text[c1 + 1..].find(',').map(|p| c1 + 1 + p) else { continue };
        if b.get(c2 + 1) != Some(&b'\'') {
            continue;
        }
        let start = c2 + 2;
        let Some(end) = text[start..].find('\'').map(|p| start + p) else { continue };
        return Some(text[start..end].to_string());
    }
    None
}

/// `getPropertySetName`.
pub(crate) fn property_set_name(line: &str) -> Option<String> {
    quoted_third(line, "IFCPROPERTYSET")
}

/// `getElementQuantityName`.
pub(crate) fn element_quantity_name(line: &str) -> Option<String> {
    quoted_third(line, "IFCELEMENTQUANTITY")
}

/// `getPropertyIdsInSet`: `/\(\s*(#[^)]+)\s*\)\s*\)\s*;$/`, the members of the
/// record's closing list.
pub(crate) fn property_ids_in_set(line: &str) -> Vec<u32> {
    let b = line.as_bytes();
    if b.last() != Some(&b';') {
        return Vec::new();
    }
    let mut k = ws_back(b, b.len() - 1);
    if k == 0 || b[k - 1] != b')' {
        return Vec::new();
    }
    k = ws_back(b, k - 1);
    if k == 0 || b[k - 1] != b')' {
        return Vec::new();
    }
    let close = k - 1;
    let floor = line[..close].rfind(')').map_or(0, |p| p + 1);
    let mut i = floor;
    while i < close {
        if b[i] == b'(' {
            let hash = ws(b, i + 1);
            if hash < close && b[hash] == b'#' && hash + 1 < close {
                return hash_ids(&line[hash..close]);
            }
        }
        i += 1;
    }
    Vec::new()
}

/// `getRelatedEntities`: `/\(([^)]+)\)\s*,\s*#(\d+)\s*\)\s*;/`.
pub(crate) fn related_entities(line: &str) -> Vec<u32> {
    let b = line.as_bytes();
    for (i, _) in line.match_indices('(') {
        let Some(close) = line[i + 1..].find(')').map(|p| i + 1 + p) else { continue };
        if close == i + 1 {
            continue;
        }
        let mut j = ws(b, close + 1);
        if b.get(j) != Some(&b',') {
            continue;
        }
        j = ws(b, j + 1);
        if b.get(j) != Some(&b'#') {
            continue;
        }
        j += 1;
        let digits = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j == digits {
            continue;
        }
        j = ws(b, j);
        if b.get(j) != Some(&b')') {
            continue;
        }
        j = ws(b, j + 1);
        if b.get(j) != Some(&b';') {
            continue;
        }
        return hash_ids(&line[i + 1..close]);
    }
    Vec::new()
}

/// `getRelatedPropertySet`: `/,\s*#(\d+)\s*\)\s*;$/`.
pub(crate) fn related_property_set(line: &str) -> Option<u32> {
    let b = line.as_bytes();
    if b.last() != Some(&b';') {
        return None;
    }
    let mut k = ws_back(b, b.len() - 1);
    if k == 0 || b[k - 1] != b')' {
        return None;
    }
    k = ws_back(b, k - 1);
    let end = k;
    while k > 0 && b[k - 1].is_ascii_digit() {
        k -= 1;
    }
    if k == end || k == 0 || b[k - 1] != b'#' {
        return None;
    }
    let id = line[k..end].parse().ok();
    let before = ws_back(b, k - 1);
    (before > 0 && b[before - 1] == b',').then_some(id).flatten()
}

/// The owner-history reference in slot 1 of a rooted record:
/// `/=\s*IFC\w+\s*\(\s*'(?:[^']|'')*'\s*,\s*#(\d+)/i`.
pub(crate) fn owner_history_ref(line: &str) -> Option<u32> {
    let b = line.as_bytes();
    let eq = line.find('=')?;
    let mut i = ws(b, eq + 1);
    if !line[i..].get(..3).is_some_and(|p| p.eq_ignore_ascii_case("IFC")) {
        return None;
    }
    i += 3;
    let word = i;
    while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
        i += 1;
    }
    if i == word {
        return None;
    }
    i = ws(b, i);
    if b.get(i) != Some(&b'(') {
        return None;
    }
    i = ws(b, i + 1);
    if b.get(i) != Some(&b'\'') {
        return None;
    }
    i += 1;
    loop {
        match b.get(i)? {
            b'\'' if b.get(i + 1) == Some(&b'\'') => i += 2,
            b'\'' => break,
            _ => i += 1,
        }
    }
    i = ws(b, i + 1);
    if b.get(i) != Some(&b',') {
        return None;
    }
    i = ws(b, i + 1);
    if b.get(i) != Some(&b'#') {
        return None;
    }
    i += 1;
    let digits = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    line[digits..i].parse().ok()
}

/// `authoredEntityRefs` over an authored string value: exactly one `#<id>`,
/// canonically spelled, or nothing.
pub(crate) fn authored_entity_refs(value: &str) -> Vec<u32> {
    let t = value.trim();
    let Some(digits) = t.strip_prefix('#') else { return Vec::new() };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Vec::new();
    }
    match digits.parse::<u32>() {
        Ok(id) if id > 0 && id.to_string() == digits => vec![id],
        _ => Vec::new(),
    }
}

#[cfg(test)]
#[path = "readers_tests.rs"]
mod tests;
