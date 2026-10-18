// SPDX-License-Identifier: MPL-2.0
//! STEP entity-line surgery for the merged exporter: rewrite the `#N`
//! references of one model's line into the merged file's id space, classify
//! where a reference sits in the argument list, and rewrite a line that
//! references an entity being dropped ([`super::empty`]).
//!
//! Slot classification is what makes dropping safe. A reference in a *list*
//! (`(#7,#8)`) can be removed and the line kept; a reference in a *single-valued*
//! attribute (`#7`) cannot — the line has to go with it. Anything nested deeper
//! is neither, and the caller treats it as a reason not to drop the target at
//! all.

use std::collections::HashSet;

use ifc_lite_core::parser::{skip_step_trivia, StepRecord};
use ifc_lite_core::StepListItems;
use std::ops::Range;

/// Rewrite every `#N` reference in a STEP entity line. `remap(n)` returns
/// `Some(absolute_id)` to redirect a reference (no offset), or `None` to apply
/// `offset`. Single-quoted strings are passed through as raw bytes (a `#` there
/// is literal text).
///
/// A reference above `u32::MAX` is copied through verbatim (#3421). It used to
/// saturate (CR #2952), which beats the wrapping this file's siblings did but is
/// still wrong here: `u32::MAX` is itself a legal express id, so the clamped
/// value went on to `remap` and `offset` like any other and could be redirected
/// onto a real entity — the same collision, moved onto the sentinel. Emitting
/// the digits unchanged leaves the reference exactly as authored and exactly as
/// dangling, and agrees with [`crate::step_text::refs_in_line`], which no longer
/// collects it (#3740).
pub fn rewrite_refs(line: &[u8], offset: u32, remap: &impl Fn(u32) -> Option<u32>) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(line.len() + 8);
    let mut copied = 0;
    for span in crate::step_text::ref_spans(line) {
        // An unrepresentable id stays as authored.
        let Some(n) = span.id else { continue };
        out.extend_from_slice(&line[copied..span.start]);
        let target = remap(n).unwrap_or_else(|| n.saturating_add(offset));
        out.push(b'#');
        out.extend_from_slice(target.to_string().as_bytes());
        copied = span.end;
    }
    out.extend_from_slice(&line[copied..]);
    String::from_utf8_lossy(&out).into_owned()
}

/// Where a `#N` reference sits in an entity's top-level argument list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RefSlot {
    /// A whole top-level attribute is the reference (`…,#7,…`).
    Single,
    /// A direct element of a top-level list attribute (`…,(#7,#8),…`).
    ListElement,
    /// Anywhere else (inside a nested list or a typed value), where neither
    /// removing the element nor dropping the line is a safe rewrite.
    Nested,
}

/// What to do with a line that references at least one dropped entity.
pub(super) enum LineDecision {
    /// Emit the line unchanged (it references nothing dropped).
    Keep,
    /// Do not emit the line at all.
    Skip,
    /// Emit this rewritten line instead (dropped list elements removed).
    Rewrite(String),
}

/// Collect every `#N` reference in a line's ARGUMENT list, skipping the leading
/// `#id=` (which is the line's own id, not an outgoing reference).
pub(super) fn arg_refs(line: &[u8], out: &mut Vec<u32>) {
    // A complete entity record starts with its own #id. Scan from that
    // boundary so an equals sign inside head trivia cannot cut a comment in
    // half. Keep collecting references even from an unreadable body: the drop
    // planner must conservatively block the containers it names.
    out.extend(crate::step_text::ref_spans(line).skip(1).filter_map(|span| span.id));
}

/// Collect canonical borrowed values only when their enclosing list closes.
/// The slices retain their source addresses, so writers can edit value bytes
/// without rebuilding (and losing) the trivia between them. #7891 follow-up.
fn closed_items<'a>(mut items: StepListItems<'a>) -> Option<Vec<&'a [u8]>> {
    let values = items.by_ref().collect();
    items.closed().then_some(values)
}

fn attributes(line: &str) -> Option<Vec<&[u8]>> {
    closed_items(StepRecord::parse(line.as_bytes())?.attrs())
}

/// `value` is a borrowed subslice returned by core for this exact `line`.
fn value_range(line: &str, value: &[u8]) -> Range<usize> {
    let start = value.as_ptr() as usize - line.as_ptr() as usize;
    start..start + value.len()
}

/// Remove only selected values and structural commas; every trivia byte stays.
fn remove_ranges(line: &str, mut ranges: Vec<Range<usize>>) -> String {
    ranges.sort_unstable_by_key(|r| r.start);
    let mut out = String::with_capacity(line.len());
    let mut copied = 0;
    for range in ranges {
        out.push_str(&line[copied..range.start]);
        copied = range.end;
    }
    out.push_str(&line[copied..]);
    out
}

/// Core has trimmed the value's surrounding STEP trivia. Its tolerant list
/// iterator can close before the end of an attribute (`(#2) (#3)`), so require
/// the canonical whole-value grammar before treating any references as editable
/// list elements. Otherwise classification must retain every reference as nested.
fn is_list(arg: &[u8]) -> bool {
    arg.len() >= 2 && arg.starts_with(b"(") && arg.ends_with(b")")
        && ifc_lite_core::parser::is_step_value(arg)
}

/// Classify every reference in `line` by the argument slot it occupies, or
/// `None` when the line's argument list cannot be parsed at all — a line no
/// rewrite can narrow, which the drop analysis must treat as a blocker rather
/// than as "names nothing".
pub(super) fn classify_refs(line: &str) -> Option<Vec<(u32, RefSlot)>> {
    let mut out = Vec::new();
    for arg in attributes(line)? {
        if let Some(n) = ifc_lite_core::parser::parse_ref(arg) {
            out.push((n, RefSlot::Single));
        } else if is_list(arg) {
            for element in closed_items(StepListItems::of_list(arg)?)? {
                match ifc_lite_core::parser::parse_ref(element) {
                    Some(n) => out.push((n, RefSlot::ListElement)),
                    None => push_nested(element, &mut out),
                }
            }
        } else {
            push_nested(arg, &mut out);
        }
    }
    Some(out)
}

/// Record every reference inside `text` as [`RefSlot::Nested`].
fn push_nested(text: &[u8], out: &mut Vec<(u32, RefSlot)>) {
    let mut refs = Vec::new();
    crate::step_text::refs_in_line(text, &mut refs);
    out.extend(refs.into_iter().map(|n| (n, RefSlot::Nested)));
}

/// Decide what to emit for `line` given the set of entity ids being dropped.
///
/// A single-valued reference to a dropped entity takes the line with it; a list
/// element is removed, and a list left empty also takes the line (an
/// objectified relationship with no subjects is not valid IFC). Callers must
/// only reach this with lines the drop analysis already cleared as prunable —
/// [`classify_refs`] is what it clears them with, so the two cannot disagree.
pub(super) fn decide_line(line: &str, dropped: &HashSet<u32>) -> LineDecision {
    let Some(args) = attributes(line) else { return LineDecision::Keep };
    let mut removed = Vec::new();
    for arg in args {
        if ifc_lite_core::parser::parse_ref(arg).is_some_and(|n| dropped.contains(&n)) {
            return LineDecision::Skip;
        }
        if !is_list(arg) {
            continue;
        }
        let Some(elements) = StepListItems::of_list(arg).and_then(closed_items) else {
            return LineDecision::Keep;
        };
        let dropping: Vec<bool> = elements.iter().map(|e| {
            ifc_lite_core::parser::parse_ref(e).is_some_and(|n| dropped.contains(&n))
        }).collect();
        if !dropping.iter().any(|&drop| drop) {
            continue;
        }
        let Some(last_kept) = dropping.iter().rposition(|&drop| !drop) else {
            return LineDecision::Skip;
        };
        for (i, element) in elements.iter().enumerate().filter(|(i, _)| dropping[*i]) {
            removed.push(value_range(line, element));
            // Before the final survivor, remove the following comma. After
            // it, remove the preceding comma. Consecutive removals therefore
            // never select the same separator, and comments stay in place.
            let before_comma = if i < last_kept { *element } else { elements[i - 1] };
            let Some(comma) = skip_step_trivia(line.as_bytes(), value_range(line, before_comma).end) else {
                return LineDecision::Keep;
            };
            if line.as_bytes().get(comma) != Some(&b',') {
                return LineDecision::Keep;
            }
            removed.push(comma..comma + 1);
        }
    }
    if removed.is_empty() { LineDecision::Keep } else { LineDecision::Rewrite(remove_ranges(line, removed)) }
}

/// Append `ids` to the list attribute `n` of `line`, or `None` when that
/// attribute is not a list (or the line cannot be parsed). Used to fold a later
/// model's relationship into the one an earlier model wrote (#5774).
pub(super) fn append_to_list_attr(line: &str, n: usize, ids: &[u32]) -> Option<String> {
    let args = attributes(line)?;
    let list = *args.get(n)?;
    if !is_list(list) {
        return None;
    }
    let elements = closed_items(StepListItems::of_list(list)?)?;
    if ids.is_empty() {
        return Some(line.to_string());
    }
    let insert = value_range(line, list).end - 1;
    let mut rebuilt = String::with_capacity(line.len() + ids.len() * 12);
    rebuilt.push_str(&line[..insert]);
    for (i, id) in ids.iter().enumerate() {
        if i > 0 || !elements.is_empty() {
            rebuilt.push(',');
        }
        rebuilt.push_str(&format!("#{id}"));
    }
    rebuilt.push_str(&line[insert..]);
    Some(rebuilt)
}

#[cfg(test)]
#[path = "line_edit_tests.rs"]
mod line_edit_tests;
