// SPDX-License-Identifier: MPL-2.0
//! STEP text-level primitives shared by the STEP exporter (`step.rs`): string
//! escaping, header `FILE_SCHEMA` detection, `#ref` scanning, and the
//! attribute-list splitting used to apply root-attribute mutations.
//!
//! Split out of `step.rs` to keep that file under the module-size ratchet
//! (`rust/processing/tests/module_size_ratchet.rs`). These are self-contained
//! line/string utilities with no dependency on the DATA-section emission
//! orchestration that stays in `step.rs`.

use std::borrow::Cow;
use std::collections::BTreeMap;

/// The edits that apply to one record, where a caller's attribute mutation and
/// a copy-on-write repointing can both land on it. The repointing wins: it was
/// computed from the caller's value rather than instead of it.
pub(crate) fn merge_edits<'a>(
    muts: Option<&'a BTreeMap<usize, String>>,
    repointed: Option<&'a BTreeMap<usize, String>>,
) -> Option<Cow<'a, BTreeMap<usize, String>>> {
    match (muts, repointed) {
        (None, None) => None,
        (Some(edits), None) | (None, Some(edits)) => Some(Cow::Borrowed(edits)),
        (Some(muts), Some(repointed)) => {
            let mut merged = muts.clone();
            merged.extend(repointed.iter().map(|(i, v)| (*i, v.clone())));
            Some(Cow::Owned(merged))
        }
    }
}

/// Escape a STEP string literal body: double the apostrophe and reverse
/// solidus, and map every ASCII control character (the C0 range plus DEL) to
/// a space, since ISO 10303-21 restricts a literal's plain-text bytes to the
/// basic graphic range 32-126.
pub(crate) fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            // ISO 10303-21 doubles both the apostrophe and the reverse
            // solidus inside a string literal; each is independent of the
            // other (order in the source string is preserved as-is).
            '\'' => out.push_str("''"),
            '\\' => out.push_str("\\\\"),
            '\0'..='\u{1F}' | '\u{7F}' => out.push(' '),
            _ => out.push(c),
        }
    }
    out
}

/// Find the first occurrence of `needle` in `haystack` that is *not* inside a
/// STEP single-quoted string literal — i.e. skip matches that fall within a
/// header field's string value. Quote state is tracked by toggling on every
/// `'` byte; a literal apostrophe inside a string is escaped by doubling
/// (`''` per ISO 10303-21 6.3.2.4), so a doubled pair toggles the state twice
/// and correctly nets to a no-op, the same technique `refs_in_line` already
/// uses above for `#`-reference scanning. Linear in `haystack.len()` — no
/// backtracking, no regex.
fn find_unquoted(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    let mut in_quote = false;
    let mut i = 0;
    let last_start = haystack.len() - needle.len();
    while i < haystack.len() {
        if haystack[i] == b'\'' {
            in_quote = !in_quote;
            i += 1;
            continue;
        }
        if !in_quote && i <= last_start && haystack[i..i + needle.len()] == *needle {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Detect the source `FILE_SCHEMA` label (e.g. `IFC2X3`); defaults to `IFC4`.
pub(crate) fn detect_schema(content: &[u8]) -> String {
    // Only look in the header region: from the start through the HEADER
    // section's closing `ENDSEC;`. A fixed byte cutoff is not safe here —
    // an earlier header field (e.g. a long DESCRIPTION or AUTHOR string)
    // can push FILE_SCHEMA past any fixed budget, silently falling back to
    // the IFC4 default and applying the wrong schema conversion. Scan for
    // the actual section terminator instead; if it's missing (malformed
    // input), fall back to scanning the whole buffer.
    //
    // Both this ENDSEC; search and the FILE_SCHEMA search below must be
    // quote-aware: a header field's plain-text string VALUE (e.g. a
    // DESCRIPTION or AUTHOR carrying the literal text "ENDSEC;" or
    // "FILE_SCHEMA") is not the section terminator or the schema entry, and
    // a raw byte search cannot tell the difference.
    let head_len = find_unquoted(content, b"ENDSEC;")
        .map(|idx| idx + b"ENDSEC;".len())
        .unwrap_or(content.len());
    let head = &content[..head_len];
    if let Some(idx) = find_unquoted(head, b"FILE_SCHEMA") {
        let rest = String::from_utf8_lossy(&head[idx..]);
        if let Some(q1) = rest.find('\'') {
            if let Some(q2) = rest[q1 + 1..].find('\'') {
                let label = &rest[q1 + 1..q1 + 1 + q2];
                if !label.is_empty() {
                    // `label` is the RAW, still-STEP-escaped slice between
                    // the quotes. Both call sites (`step.rs`'s
                    // `source_schema` fallback and `merged.rs`) feed this
                    // straight into `escape()` when the header is
                    // re-written, which doubles `\` again -- un-double it
                    // here first so a schema label carrying a literal `\`
                    // round-trips instead of being re-escaped on top of
                    // its own escaping. A no-op for every real schema
                    // label (IFC2X3, IFC4, IFC4X3_ADD2, ...), none of
                    // which contain a backslash.
                    return label.replace("\\\\", "\\");
                }
            }
        }
    }
    "IFC4".to_string()
}

/// Collect outgoing `#<digits>` references in a STEP entity line, skipping the
/// contents of single-quoted strings (where a `#` is literal text).
pub(crate) fn refs_in_line(line: &[u8], out: &mut Vec<u32>) {
    let mut i = 0;
    let mut in_quote = false;
    while i < line.len() {
        let b = line[i];
        if b == b'\'' {
            // STEP escapes a quote as '' — toggling twice is a no-op, which is fine.
            in_quote = !in_quote;
            i += 1;
            continue;
        }
        if !in_quote && b == b'#' {
            let mut j = i + 1;
            let mut n: u32 = 0;
            let mut any = false;
            while j < line.len() && line[j].is_ascii_digit() {
                n = n.wrapping_mul(10).wrapping_add((line[j] - b'0') as u32);
                j += 1;
                any = true;
            }
            if any {
                out.push(n);
                i = j;
                continue;
            }
        }
        i += 1;
    }
}

/// Split a STEP attribute list into its top-level arguments (parens/strings aware).
fn split_top_level_args(attrs: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut current = String::new();
    // Over chars, not bytes. `bytes[i] as char` reads a UTF-8 continuation byte
    // as a Latin-1 character and re-encodes it, so a property name like
    // `Größe` came back as `GrÃ¶ÃŸe` in any record this rewrote. Every
    // delimiter STEP cares about is ASCII, so iterating chars costs nothing and
    // leaves the rest of the text alone.
    let mut chars = attrs.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\'' && !in_string {
            in_string = true;
            current.push(ch);
        } else if ch == '\'' && in_string {
            if chars.peek() == Some(&'\'') {
                current.push_str("''");
                chars.next();
                continue;
            }
            in_string = false;
            current.push(ch);
        } else if in_string {
            current.push(ch);
        } else if ch == '(' {
            depth += 1;
            current.push(ch);
        } else if ch == ')' {
            depth -= 1;
            current.push(ch);
        } else if ch == ',' && depth == 0 {
            out.push(std::mem::take(&mut current));
        } else {
            current.push(ch);
        }
    }
    out.push(current);
    out
}

/// Apply root-attribute edits to a `#id=TYPE(attrs);` line. Returns the line unchanged
/// when it cannot be parsed.
pub(crate) fn apply_attr_mutations(line: &str, muts: &BTreeMap<usize, String>) -> String {
    let trimmed = line.trim_end();
    let body = trimmed.strip_suffix(';').unwrap_or(trimmed);
    let eq = match body.find('=') {
        Some(e) => e,
        None => return line.to_string(),
    };
    let after = &body[eq + 1..];
    let popen = match after.find('(') {
        Some(p) => p,
        None => return line.to_string(),
    };
    let aclose = match after.rfind(')') {
        Some(c) if c > popen => c,
        _ => return line.to_string(),
    };
    let prefix = &body[..=eq];
    let type_name = &after[..popen];
    let mut args = split_top_level_args(&after[popen + 1..aclose]);
    for (idx, val) in muts {
        if *idx < args.len() {
            args[*idx] = val.clone();
        }
    }
    format!("{prefix}{type_name}({});", args.join(","))
}

#[cfg(test)]
#[path = "step_text_tests.rs"]
mod tests;

/// Rewrite a record's own id, leaving everything after the `=` untouched.
///
/// For a copy-on-write copy: the body is the original's, byte for byte, with
/// one attribute already replaced, and only the number in front changes.
pub(crate) fn renumber(line: &str, new_id: u32) -> String {
    let trimmed = line.trim_end();
    match trimmed.find('=') {
        Some(eq) => format!("#{new_id}{}", &trimmed[eq..]),
        None => line.to_string(),
    }
}

/// One attribute of a `#id=TYPE(args);` line, by position.
///
/// Split from the substitution below so a caller applying two edits to the
/// same attribute can feed the first result into the second, rather than
/// computing both from the original and losing one.
pub(crate) fn attribute_of(line: &str, index: usize) -> Option<String> {
    let trimmed = line.trim_end();
    let body = trimmed.strip_suffix(';').unwrap_or(trimmed);
    let eq = body.find('=')?;
    let after = &body[eq + 1..];
    let popen = after.find('(')?;
    let aclose = after.rfind(')').filter(|c| *c > popen)?;
    split_top_level_args(&after[popen + 1..aclose])
        .into_iter()
        .nth(index)
}

/// Replace references inside one attribute, leaving its neighbours alone.
///
/// Rewrites every unquoted `#from` in the attribute to `#to`. Returns the
/// rewritten attribute, or `None` when the attribute does not hold that
/// reference. The caller is expected to treat `None` as "this edit cannot be
/// made" rather than proceeding, because a copy nothing points at is an orphan
/// and a reference to a filtered record is a dangling one.
///
/// A list keeps its order and its other entries: repointing one element of a
/// property set's `HasProperties` must not disturb the rest, or the diff
/// against the source stops being small.
///
/// Text is left alone. A property value reading `'lot #41'` is a sentence, and
/// rewriting inside it would change what the file says rather than what it
/// points at.
pub(crate) fn substitute_ref_in_attr(attr: &str, from: u32, to: u32) -> Option<String> {
    let old = format!("#{from}");
    let new = format!("#{to}");
    let mut out = String::with_capacity(attr.len());
    let mut replaced = false;
    let mut in_string = false;
    let mut rest = attr;
    while let Some(ch) = rest.chars().next() {
        if in_string {
            if ch == '\'' {
                if rest[ch.len_utf8()..].starts_with('\'') {
                    out.push_str("''");
                    rest = &rest[ch.len_utf8() * 2..];
                    continue;
                }
                in_string = false;
            }
            out.push(ch);
            rest = &rest[ch.len_utf8()..];
            continue;
        }
        if ch == '\'' {
            in_string = true;
            out.push(ch);
            rest = &rest[ch.len_utf8()..];
            continue;
        }
        if ch == '#' && rest.starts_with(old.as_str()) {
            let after = &rest[old.len()..];
            // `#4` must not match inside `#41`.
            if !after.starts_with(|c: char| c.is_ascii_digit()) {
                out.push_str(&new);
                rest = after;
                replaced = true;
                continue;
            }
        }
        out.push(ch);
        rest = &rest[ch.len_utf8()..];
    }
    replaced.then_some(out)
}
