// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The one `IFCPROJECT` locator (XCUT-6, CORE-3, PROC-AL-12).
//!
//! Every reader that needs "the project" starts here: a SIMD keyword search
//! plus a record-boundary check, never a full [`crate::EntityScanner`] walk.
//! [`find_project_ids`] returns EVERY project id in file order (a federated
//! file declares several, and per-owner unit contexts need all of them);
//! [`find_project_id`] is its first element, the model's project.
//! [`crate::EntityDecoder::project_id`] caches that answer per decoder.
//!
//! A scan that already visits every entity for another reason may keep
//! noting the first `IFCPROJECT` it walks past: same policy (first in file
//! order), no extra pass.

use crate::express_id::parse_express_id;
use crate::parser::find_keyword;

/// Every `IFCPROJECT` express id in file order.
///
/// A refused id (issue #3421: an `IFCPROJECT` express id above `u32::MAX`) is
/// reported through [`crate::parser::report_oversized_ids`] — the same sink
/// the definition scanner uses (issue #3395/#3752) — because it is exactly
/// that class of event: this function backtracks from `IFCPROJECT(` to the
/// record's OWN id, so a refusal here is indistinguishable in kind from a scan
/// refusing to index the record at all. Left unreported, it would default the
/// file's unit scales with the silent-1000×-oversized symptom issue #1367
/// already fixed for the "not found at all" case.
pub fn find_project_ids(content: &[u8]) -> Vec<u32> {
    let mut ids = Vec::new();
    let refused = scan_projects(content, &mut |id| {
        ids.push(id);
        true
    });
    crate::parser::report_oversized_ids(refused);
    ids
}

/// The model's project: the first `IFCPROJECT` in file order, or `None` when
/// the file has none. Stops at the first hit, so it costs no more than the
/// distance to it. Reports a refused id like [`find_project_ids`].
pub fn find_project_id(content: &[u8]) -> Option<u32> {
    let mut first = None;
    let refused = scan_projects(content, &mut |id| {
        first = Some(id);
        false
    });
    crate::parser::report_oversized_ids(refused);
    first
}

/// The first `IFCPROJECT` an entity scan meets: the fallback of
/// [`crate::EntityDecoder::project_id`] for what the byte search cannot see
/// (trivia between the keyword and `(`, a comment around `=`) or accepts
/// wrongly (a record-shaped decoy inside a string). Runs only when the search
/// finds no confirmed project, so the common path never pays for it.
pub(crate) fn scan_for_project_id(content: &[u8]) -> Option<u32> {
    let mut scanner = crate::parser::EntityScanner::new(content);
    while let Some((id, kind, _, _)) = scanner.next_entity() {
        if crate::parser::keyword_eq(kind, "IFCPROJECT") {
            return Some(id);
        }
    }
    None
}

/// Case-insensitive search for the literal keyword `IFCPROJECT(` at or after
/// `from` (issue #4497: STEP keyword case is not significant, so a lowercase
/// or CamelCase exporter's `ifcproject(`/`IfcProject(` must resolve exactly
/// like the uppercase form). [`find_keyword`] anchors on `J`, which occurs in
/// almost nothing else; the measurement that chose it over the lead `I` is
/// recorded on that function's module. The `from` cut matters because the
/// caller resumes at `previous_hit + 1`, so a hit behind it would be
/// returned forever.
pub(crate) fn find_project_keyword(content: &[u8], from: usize) -> Option<usize> {
    find_keyword(content.get(from..)?, b"IFCPROJECT(").map(|rel| from + rel)
}

/// Visit each project id in file order until `visit` returns `false`.
/// Returns how many ids were refused as oversized.
fn scan_projects(content: &[u8], visit: &mut dyn FnMut(u32) -> bool) -> usize {
    let mut refused = 0usize;
    let mut from = 0usize;
    // Search for the keyword+paren only; the `=` and `#<id>` are reconstructed by
    // backtracking. Exporters vary the whitespace around `=` — Revit/EDM emits
    // `#1593796= IFCPROJECT(` with a SPACE, so the old `=IFCPROJECT(` literal
    // never matched and the whole unit chain silently defaulted (length → metres
    // on a mm model, plane-angle → radians on a degree model, making arched
    // openings render as full circles — issue #1367). `IFCPROJECT(` cannot
    // collide with `IFCPROJECTEDCRS(` because the `(` must immediately follow.
    while let Some(kw) = find_project_keyword(content, from) {
        // Backtrack over optional whitespace, then require '='.
        let mut i = kw;
        while i > 0 && content[i - 1].is_ascii_whitespace() {
            i -= 1;
        }
        if i > 0 && content[i - 1] == b'=' {
            i -= 1; // step over '='
            // Optional whitespace between the express id and '='.
            while i > 0 && content[i - 1].is_ascii_whitespace() {
                i -= 1;
            }
            // Backtrack over the express id digits to the '#'.
            let digits_end = i;
            while i > 0 && content[i - 1].is_ascii_digit() {
                i -= 1;
            }
            if i > 0 && content[i - 1] == b'#' && i < digits_end && starts_a_record(content, i - 1)
            {
                // Refuse (not wrap) above u32::MAX (#3421); a refused id just
                // keeps searching. Counted (issue #3752) so the caller can
                // report it via the scanner's own oversized-id sink instead
                // of it vanishing.
                match parse_express_id(&content[i..digits_end]) {
                    Some(id) => {
                        if !visit(id) {
                            return refused;
                        }
                    }
                    None => refused += 1,
                }
            }
        }
        // `IFCPROJECT(` not preceded by a record-starting `#<digits>=` (e.g.
        // the whole thing quoted inside a string) — keep searching.
        from = kw + 1;
    }
    refused
}

/// Does the `#` at `hash` begin a record, rather than sit inside a quoted
/// string or a comment?
///
/// 10303-21 terminates every entity instance with `;`, so a declaration's
/// `#` is preceded — across trivia only — by that `;` or by the start of
/// input. Without this check a description or comment containing a
/// record-shaped decoy such as `'note: #9=ifcproject( …'` is accepted, and
/// the scan returns a WRONG express id AND stops, so the real project is
/// never reached: `extract_length_unit_scale` then rejects that id on its
/// `IFCPROJECT` type guard and the caller's `unwrap_or(1.0)` restores the
/// 1000×-oversized millimetre default issue #4497 exists to remove. The
/// hazard predates case-insensitive matching, which only widens it from
/// uppercase decoys to ordinary lowercase prose.
///
/// Validating instead that the id decodes to an `IFCPROJECT` would be
/// stricter, but it needs an entity index per candidate — the
/// O(file)-scan-per-decoder cost [`resolve_unit_scales`] exists to keep
/// dead. This stays a single linear byte scan.
///
/// "Trivia", not whitespace: a `/* … */` comment is legal wherever
/// whitespace is, so `#1=IFCWALL(…); /* note */ #7=IFCPROJECT(…)` is a real
/// declaration and must not be refused (the entity scanner's `skip_step_trivia`
/// makes the same allowance in the forward direction).
fn starts_a_record(content: &[u8], hash: usize) -> bool {
    let mut i = hash;
    loop {
        while i > 0 && content[i - 1].is_ascii_whitespace() {
            i -= 1;
        }
        // A closing `*/` here means a comment sits between the boundary and
        // the `#`; skip back over it and re-test. An unopened `*/` is not
        // trivia, so refuse rather than loop.
        if i >= 2 && content[i - 1] == b'/' && content[i - 2] == b'*' {
            match memchr::memmem::rfind(&content[..i - 2], b"/*") {
                Some(open) => i = open,
                None => return false,
            }
            continue;
        }
        return i == 0 || content[i - 1] == b';';
    }
}

#[cfg(test)]
#[path = "project_locator_tests.rs"]
mod tests;
