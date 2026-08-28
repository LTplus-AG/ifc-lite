// SPDX-License-Identifier: MPL-2.0
//! STEP text-level primitives shared by the STEP exporter (`step.rs`): string
//! escaping, `#ref` scanning, and the attribute-list splitting used to apply
//! root-attribute mutations.
//!
//! Header `FILE_SCHEMA` detection used to live here and is now `schema_detect`.
//! It left because it is not a text EDIT: it reads one fact out of raw bytes
//! before anything is parsed, and unlike everything here it runs on whole
//! uncapped attacker-supplied files.
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
/// solidus, map every ASCII control character (the C0 range plus DEL) to a
/// space, and encode any character outside the basic graphic range as its
/// `\X2\`/`\X4\` control directive — never a raw byte — since ISO 10303-21
/// 6.3.3.4 restricts a literal's plain-text bytes to 32-126. buildingSMART's
/// IFC string-encoding guidance states the same for IFC2X3/IFC4/IFC4X3: a
/// character outside decimal 32-126 "has to be encoded" (e.g. 'Ä' as
/// `\X2\00C4\X0\`). A reader that treats the file's bytes as ISO-8859-1 — the
/// byte encoding the base standard and most real consumers assume — turns a
/// raw UTF-8 multi-byte sequence into mojibake or a broken parse; this exact
/// writer shape is a reported, reproduced defect in real IFC tooling
/// (IfcOpenShell#699/#1016; files rejected by Solibri).
///
/// `pub`, and re-exported from the crate root as `escape_step_string`, so the
/// integration-test binary `tests/step_escape_parity.rs` can pin it to the
/// shared vectors in `tests/fixtures/step_escape_vectors.json` — the same
/// vectors the TypeScript `escapeStepString` is held to, since the two
/// implementations cannot share code (#3300). Only this one function is
/// re-exported, not the whole module, so the rest of `step_text` stays
/// crate-private and the public surface widens by exactly one symbol —
/// narrower than the `pub mod csv_cell` the CSV parity pin already relies on.
pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            // ISO 10303-21 doubles both the apostrophe and the reverse
            // solidus inside a string literal; each is independent of the
            // other (order in the source string is preserved as-is).
            '\'' => out.push_str("''"),
            '\\' => out.push_str("\\\\"),
            '\0'..='\u{1F}' | '\u{7F}' => out.push(' '),
            '\u{20}'..='\u{7E}' => out.push(c),
            _ => {
                let cp = c as u32;
                if cp <= 0xFFFF {
                    out.push_str(&format!("\\X2\\{cp:04X}\\X0\\"));
                } else {
                    out.push_str(&format!("\\X4\\{cp:08X}\\X0\\"));
                }
            }
        }
    }
    out
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
