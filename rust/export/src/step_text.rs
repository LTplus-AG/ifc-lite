// SPDX-License-Identifier: MPL-2.0
//! STEP text-level primitives shared by the STEP exporter (`step.rs`): string
//! escaping, header `FILE_SCHEMA` detection, `#ref` scanning, and the
//! attribute-list splitting used to apply root-attribute mutations.
//!
//! Split out of `step.rs` to keep that file under the module-size ratchet
//! (`rust/processing/tests/module_size_ratchet.rs`). These are self-contained
//! line/string utilities with no dependency on the DATA-section emission
//! orchestration that stays in `step.rs`.

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
                    return label.to_string();
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
    let bytes = attrs.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let ch = bytes[i] as char;
        if ch == '\'' && !in_string {
            in_string = true;
            current.push(ch);
        } else if ch == '\'' && in_string {
            if i + 1 < bytes.len() && bytes[i + 1] == b'\'' {
                current.push_str("''");
                i += 2;
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
        i += 1;
    }
    out.push(current);
    out
}

/// Apply root-attribute edits to a `#id=TYPE(attrs);` line. Returns the line unchanged
/// when it cannot be parsed.
pub(crate) fn apply_attr_mutations(line: &str, muts: &[(usize, String)]) -> String {
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
