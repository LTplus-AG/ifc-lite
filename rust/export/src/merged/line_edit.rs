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

/// Rewrite every `#N` reference in a STEP entity line. `remap(n)` returns
/// `Some(absolute_id)` to redirect a reference (no offset), or `None` to apply
/// `offset`. Single-quoted strings are passed through as raw bytes (a `#` there
/// is literal text), tracking only in/out-of-string state.
pub fn rewrite_refs(line: &[u8], offset: u32, remap: &impl Fn(u32) -> Option<u32>) -> String {
    let mut out: Vec<u8> = Vec::with_capacity(line.len() + 8);
    let mut i = 0;
    let mut in_string = false;
    while i < line.len() {
        let b = line[i];
        if b == b'\'' {
            in_string = !in_string;
            out.push(b'\'');
            i += 1;
            continue;
        }
        if !in_string && b == b'#' {
            let mut j = i + 1;
            let mut n: u32 = 0;
            let mut any = false;
            while j < line.len() && line[j].is_ascii_digit() {
                // Saturate rather than wrap: a malformed reference number wider than
                // u32 must not silently wrap onto a small, valid id (CR #2952). A
                // clamped id stays dangling (caught downstream), never mis-pointed.
                n = n.saturating_mul(10).saturating_add((line[j] - b'0') as u32);
                j += 1;
                any = true;
            }
            if any {
                let target = remap(n).unwrap_or_else(|| n.saturating_add(offset));
                out.push(b'#');
                out.extend_from_slice(target.to_string().as_bytes());
                i = j;
                continue;
            }
        }
        out.push(b);
        i += 1;
    }
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
    let start = line.iter().position(|&b| b == b'=').map_or(0, |i| i + 1);
    crate::step_text::refs_in_line(&line[start..], out);
}

/// Byte offsets of the opening and closing parenthesis of the top-level argument
/// list of `#id=TYPE(…);`, honouring quoted strings and nested parentheses.
fn arg_span(line: &str) -> Option<(usize, usize)> {
    let bytes = line.as_bytes();
    let from = bytes.iter().position(|&b| b == b'=').map_or(0, |i| i + 1);
    let open = from + bytes[from..].iter().position(|&b| b == b'(')?;
    let mut depth = 0i32;
    let mut in_string = false;
    let mut i = open;
    while i < bytes.len() {
        let c = bytes[i];
        if in_string {
            if c == b'\'' {
                if bytes.get(i + 1) == Some(&b'\'') {
                    i += 2;
                    continue;
                }
                in_string = false;
            }
            i += 1;
            continue;
        }
        match c {
            b'\'' => in_string = true,
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some((open, i));
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Split a STEP argument list body into its top-level arguments, as slices of
/// the input (quotes and nested parentheses aware). `""` yields one empty arg.
fn split_args(args: &str) -> Vec<&str> {
    let bytes = args.as_bytes();
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        let c = bytes[i];
        if in_string {
            if c == b'\'' {
                if bytes.get(i + 1) == Some(&b'\'') {
                    i += 2;
                    continue;
                }
                in_string = false;
            }
            i += 1;
            continue;
        }
        match c {
            b'\'' => in_string = true,
            b'(' => depth += 1,
            b')' => depth -= 1,
            b',' if depth == 0 => {
                out.push(&args[start..i]);
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    out.push(&args[start..]);
    out
}

/// Parse an argument that is exactly one reference (`"#7"` → `7`).
fn parse_ref(arg: &str) -> Option<u32> {
    let t = arg.trim();
    let digits = t.strip_prefix('#')?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// True when `arg` is a list literal (`(…)`).
fn is_list(arg: &str) -> bool {
    arg.len() >= 2 && arg.starts_with('(') && arg.ends_with(')')
}

/// Classify every reference in `line` by the argument slot it occupies, or
/// `None` when the line's argument list cannot be parsed at all — a line no
/// rewrite can narrow, which the drop analysis must treat as a blocker rather
/// than as "names nothing".
pub(super) fn classify_refs(line: &str) -> Option<Vec<(u32, RefSlot)>> {
    let mut out = Vec::new();
    let (open, close) = arg_span(line)?;
    for arg in split_args(&line[open + 1..close]) {
        let trimmed = arg.trim();
        if let Some(n) = parse_ref(trimmed) {
            out.push((n, RefSlot::Single));
            continue;
        }
        if is_list(trimmed) {
            for element in split_args(&trimmed[1..trimmed.len() - 1]) {
                match parse_ref(element) {
                    Some(n) => out.push((n, RefSlot::ListElement)),
                    None => push_nested(element, &mut out),
                }
            }
            continue;
        }
        push_nested(trimmed, &mut out);
    }
    Some(out)
}

/// Record every reference inside `text` as [`RefSlot::Nested`].
fn push_nested(text: &str, out: &mut Vec<(u32, RefSlot)>) {
    let mut refs = Vec::new();
    crate::step_text::refs_in_line(text.as_bytes(), &mut refs);
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
    let mut refs = Vec::new();
    arg_refs(line.as_bytes(), &mut refs);
    if !refs.iter().any(|r| dropped.contains(r)) {
        return LineDecision::Keep;
    }
    let Some((open, close)) = arg_span(line) else { return LineDecision::Keep };
    let args = split_args(&line[open + 1..close]);
    let mut rebuilt = String::with_capacity(line.len());
    rebuilt.push_str(&line[..=open]);
    for (i, arg) in args.iter().enumerate() {
        if i > 0 {
            rebuilt.push(',');
        }
        let trimmed = arg.trim();
        if parse_ref(trimmed).is_some_and(|n| dropped.contains(&n)) {
            return LineDecision::Skip;
        }
        if !is_list(trimmed) {
            rebuilt.push_str(arg);
            continue;
        }
        let elements = split_args(&trimmed[1..trimmed.len() - 1]);
        let kept: Vec<&str> = elements
            .iter()
            .copied()
            .filter(|e| !parse_ref(e).is_some_and(|n| dropped.contains(&n)))
            .collect();
        if kept.len() == elements.len() {
            rebuilt.push_str(arg);
            continue;
        }
        if kept.iter().all(|e| e.trim().is_empty()) {
            return LineDecision::Skip;
        }
        rebuilt.push('(');
        rebuilt.push_str(&kept.join(","));
        rebuilt.push(')');
    }
    rebuilt.push_str(&line[close..]);
    LineDecision::Rewrite(rebuilt)
}

#[cfg(test)]
#[path = "line_edit_tests.rs"]
mod line_edit_tests;
