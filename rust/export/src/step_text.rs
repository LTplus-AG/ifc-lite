// SPDX-License-Identifier: MPL-2.0
//! STEP text-level primitives shared by the STEP exporter (`step.rs`): string
//! escaping, `#ref` scanning, and the by-index reads and writes of a record's
//! root attributes.
//!
//! Header `FILE_SCHEMA` detection used to live here and is now `schema_detect`.
//! It left because it is not a text EDIT: it reads one fact out of raw bytes
//! before anything is parsed, and unlike everything here it runs on whole
//! uncapped attacker-supplied files.
//!
//! The argument-list SPLIT left too, to `step_slot.rs`, when it grew a grammar
//! check per slot (#4125). It is what the by-index writers here stand on rather
//! than another line utility beside them, and its own header carries the rule
//! that makes them safe.
//!
//! Split out of `step.rs` to keep that file under the module-size ratchet
//! (`rust/processing/tests/module_size_ratchet.rs`). These are self-contained
//! line/string utilities with no dependency on the DATA-section emission
//! orchestration that stays in `step.rs`.

use std::borrow::Cow;
use std::collections::BTreeMap;

use ifc_lite_core::express_id::parse_express_id;

use crate::step_slot::split_top_level_args;

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
    let mut discarded = 0usize;
    refs_in_line_counted(line, out, &mut discarded);
}

/// [`refs_in_line`], additionally counting every reference discarded because it
/// exceeded `u32::MAX` (issue #3421/#3752) into `refused`. Used by the two
/// reachability-closure callers ([`crate::step::export_step_with_stats`]'s
/// included-set walk and [`crate::merged::plan::resolve_included`]) so a
/// refusal there — which decides what a filtered/merged export DOES NOT emit —
/// is at least counted, even though the referenced record, being unrepresentable,
/// could never have been a real entity in this model either. Callers that only
/// use the result to decide whether a line names an already-known id (the
/// merged exporter's dropped-container rewrite in `merged/line_edit.rs`) keep
/// calling plain `refs_in_line`: `dropped`/similar sets there only ever hold
/// ids that were themselves scanned successfully (so at most `u32::MAX`), and
/// a ref this function refuses can never equal one of them — refusing it there
/// changes no decision, so counting it would be reporting a no-op.
pub(crate) fn refs_in_line_counted(line: &[u8], out: &mut Vec<u32>, refused: &mut usize) {
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
            while j < line.len() && line[j].is_ascii_digit() {
                j += 1;
            }
            if j > i + 1 {
                // A ref above `u32::MAX` refuses rather than wrapping onto a
                // real low-numbered entity (issue #3421): it is dropped from
                // the reference list instead of being followed to the wrong
                // entity, the same "no third policy" refusal
                // `parse_express_id` establishes everywhere else. Counted
                // (issue #3752) so a refusal here at least leaves a trace.
                match parse_express_id(&line[i + 1..j]) {
                    Some(n) => out.push(n),
                    None => *refused += 1,
                }
                i = j;
                continue;
            }
        }
        i += 1;
    }
}

/// Apply root-attribute edits to a `#id=TYPE(attrs);` line, keeping the source
/// line and COUNTING the refusal when they cannot be applied.
///
/// The edits are refused when the text is not a `#id=TYPE(...)` record at all,
/// or when its argument list could not be scanned into slots
/// ([`split_top_level_args`] refused it). Either way it is a refusal, not a
/// no-op — the caller asked for an edit that is not in the output. Writing the
/// edit anyway is the #2470 shape one level up: an undoubled apostrophe makes a
/// nine-attribute record scan as seven slots, so writing `Description` by index
/// lands on `ObjectPlacement`, deletes the reference that was there, and reports
/// success (#4125).
///
/// One function, and `refused` rather than an `Option` the caller interprets,
/// because both emit sites need the same PAIR — leave the record as its author
/// wrote it, and say that an edit is missing — and a site that did the first
/// without the second would ship a file that looks like it carried the edit.
pub(crate) fn apply_attr_mutations_counted(
    line: &str,
    muts: &BTreeMap<usize, String>,
    refused: &mut usize,
) -> String {
    let trimmed = line.trim_end();
    let body = trimmed.strip_suffix(';').unwrap_or(trimmed);
    let edited = body.find('=').and_then(|eq| {
        let after = &body[eq + 1..];
        let popen = after.find('(')?;
        let aclose = after.rfind(')').filter(|c| *c > popen)?;
        let prefix = &body[..=eq];
        let type_name = &after[..popen];
        let mut args = split_top_level_args(&after[popen + 1..aclose])?;
        for (idx, val) in muts {
            if *idx < args.len() {
                args[*idx] = val.clone();
            }
        }
        Some(format!("{prefix}{type_name}({});", args.join(",")))
    });
    match edited {
        Some(text) => text,
        None => {
            *refused += 1;
            line.to_string()
        }
    }
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
///
/// `None` covers both "that slot is past the end" and "this record's argument
/// list could not be scanned into slots at all". The caller
/// (`step_cow::candidate`) already treats `None` as "this mutation cannot be
/// made" and counts it into `StepStats::copies_refused`, which is the right
/// answer for either: a slot read out of a mis-scanned list is some other
/// attribute's text, and a copy built from it would carry the wrong value.
pub(crate) fn attribute_of(line: &str, index: usize) -> Option<String> {
    let trimmed = line.trim_end();
    let body = trimmed.strip_suffix(';').unwrap_or(trimmed);
    let eq = body.find('=')?;
    let after = &body[eq + 1..];
    let popen = after.find('(')?;
    let aclose = after.rfind(')').filter(|c| *c > popen)?;
    split_top_level_args(&after[popen + 1..aclose])?
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
