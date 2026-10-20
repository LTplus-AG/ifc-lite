// SPDX-License-Identifier: MPL-2.0
//! The reference filters the source pass runs whenever a session is active
//! (`filterHiddenRefsFromRelationshipLine`, `narrowNonRelPositionalRefLists`):
//! a record that names an entity this export does not write drops it from a
//! list slot, or is withheld when the reference sits where no omitted spelling
//! exists. This is the reference cleanup behind `DELETE_ENTITY`.

use crate::generated::step_log_tables::{NONREL_AGGREGATE_SLOTS, STYLE_SLOT_BOUNDS};

use super::lines::read_slots;
use crate::step_record_frame::{opens_record, record_frame};

/// Record types filtered like a relationship (`STYLE_RESCUE_TYPES`).
const STYLE_RESCUE_TYPES: &[&str] = &[
    "IFCSTYLEDITEM",
    "IFCSTYLEDREPRESENTATION",
    "IFCPRESENTATIONLAYERASSIGNMENT",
    "IFCPRESENTATIONLAYERWITHSTYLE",
    "IFCINDEXEDTRIANGLETEXTUREMAP",
    "IFCINDEXEDPOLYGONALTEXTUREMAP",
    "IFCTEXTUREMAP",
];

/// What the source pass does with one line.
pub(crate) enum Filtered {
    Keep,
    Rewrite(String),
    /// Withheld, with the warning that says so.
    Withhold(String),
}

/// Whitespace and `/* … */` comments off both ends.
fn strip_trivia(mut s: &str) -> &str {
    loop {
        let t = s.trim();
        if let Some(rest) = t.strip_prefix("/*") {
            match rest.find("*/") {
                Some(end) => s = &rest[end + 2..],
                None => return t,
            }
        } else if let Some(rest) = t.strip_suffix("*/") {
            match rest.rfind("/*") {
                Some(start) => s = &rest[..start],
                None => return t,
            }
        } else {
            return t;
        }
    }
}

/// `BARE_REF_RE`: a list item that is exactly `#N`, trivia aside.
fn bare_ref(item: &str) -> Option<u32> {
    // Core's one reference rule: `#` and digits, nothing else.
    ifc_lite_core::parser::parse_ref(strip_trivia(item).as_bytes())
}

/// `splitTopLevelListItems`.
fn list_items(text: &str) -> Vec<String> {
    // Every delimiter is ASCII, so byte offsets are char boundaries.
    let bytes = text.as_bytes();
    let mut parts = Vec::new();
    let (mut depth, mut start, mut i) = (0i32, 0usize, 0usize);
    while i < bytes.len() {
        match bytes[i] {
            // A comment moves on whole, its commas and parentheses with it.
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i = (i + 2..bytes.len().saturating_sub(1))
                    .find(|&k| bytes[k] == b'*' && bytes[k + 1] == b'/')
                    .map_or(bytes.len(), |k| k + 2);
                continue;
            }
            // A literal moves on whole; where it ends is the shared rule, so a
            // `\S\'` operand stays inside it (#7589). Unterminated: the rest.
            b'\'' => {
                i = ifc_lite_core::step_encoding::step_string_literal_end(bytes, i).unwrap_or(bytes.len());
                continue;
            }
            b'(' => depth += 1,
            b')' => depth -= 1,
            b',' if depth == 0 => {
                parts.push(text[start..i].trim().to_string());
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    if !text[start..].trim().is_empty() {
        parts.push(text[start..].trim().to_string());
    }
    parts
}

/// A slot split into its leading whitespace, value, and trailing whitespace.
fn framed(raw: &str) -> (&str, &str, &str) {
    let attr = raw.trim();
    let start = raw.find(attr).unwrap_or(0);
    (&raw[..start], attr, &raw[start + attr.len()..])
}

fn is_list(attr: &str) -> bool {
    attr.len() >= 2 && attr.starts_with('(') && attr.ends_with(')')
}

fn rebuild(text: &str, args: &[String]) -> String {
    record_frame(text).expect("the slots were read from this record").with_args(text, &args.join(","))
}

fn withheld(id: u32, upper: &str, rel: bool) -> String {
    if rel {
        format!(
            "Relationship #{id} ({upper}) was withheld from the export: it names at least one entity that has no line in this export, in a slot with no spelling for an omitted reference (a single-valued attribute, or a set whose every member is omitted). Anything else that relationship associated is no longer associated in the output."
        )
    } else {
        format!(
            "Entity #{id} ({upper}) was withheld from the export: it names at least one entity that has no line in this export, in a slot with no spelling for an omitted reference (a single-valued attribute, or a set whose every member is omitted)."
        )
    }
}

/// `filterHiddenRefsFromRelationshipLine`; `schema` only for the style
/// records, whose list slots keep their declared lower bound.
fn relationship(text: &str, excluded: &dyn Fn(u32) -> bool, schema: Option<&str>) -> Option<Filtered> {
    let Some((record_type, args)) = read_slots(text) else {
        return if opens_record(text) { None } else { Some(Filtered::Keep) };
    };
    let mut changed = false;
    let mut next = Vec::with_capacity(args.len());
    for (index, raw) in args.iter().enumerate() {
        let (lead, attr, trail) = framed(raw);
        if is_list(attr) {
            let inner = &attr[1..attr.len() - 1];
            let items = if inner.trim().is_empty() { Vec::new() } else { list_items(inner) };
            let survivors: Vec<&String> = items.iter().filter(|i| !bare_ref(i).is_some_and(excluded)).collect();
            if survivors.len() != items.len() {
                if survivors.is_empty() {
                    return None;
                }
                if let Some(schema) = schema {
                    let bound = STYLE_SLOT_BOUNDS
                        .iter()
                        .find(|r| r.0 == schema && r.1 == record_type && usize::from(r.2) == index)
                        .map(|r| r.3 as usize);
                    if bound.is_some_and(|b| survivors.len() < b) {
                        next.push(raw.clone());
                        continue;
                    }
                }
                changed = true;
                let joined: Vec<&str> = survivors.iter().map(|s| s.as_str()).collect();
                next.push(format!("{lead}({}){trail}", joined.join(",")));
                continue;
            }
            next.push(raw.clone());
            continue;
        }
        if bare_ref(attr).is_some_and(excluded) {
            if record_type == "IFCRELCONNECTSSTRUCTURALMEMBER" && args.len() == 10 && index == 9 {
                changed = true;
                next.push(format!("{lead}${trail}"));
                continue;
            }
            return None;
        }
        next.push(raw.clone());
    }
    Some(if changed { Filtered::Rewrite(rebuild(text, &next)) } else { Filtered::Keep })
}

/// `narrowNonRelPositionalRefLists`.
fn narrow(text: &str, excluded: &dyn Fn(u32) -> bool, upper: &str, schema: &str) -> Filtered {
    let Some((_, args)) = read_slots(text) else { return Filtered::Keep };
    let mut changed = false;
    let mut next = Vec::with_capacity(args.len());
    for (index, raw) in args.iter().enumerate() {
        let (lead, attr, trail) = framed(raw);
        if !is_list(attr) {
            next.push(raw.clone());
            continue;
        }
        let inner = if attr.trim() == "()" { "" } else { &attr[1..attr.len() - 1] };
        let items = if inner.trim().is_empty() { Vec::new() } else { list_items(inner) };
        let survivors: Vec<&String> = items.iter().filter(|i| !bare_ref(i).is_some_and(excluded)).collect();
        if survivors.len() == items.len() {
            next.push(raw.clone());
            continue;
        }
        let slot = NONREL_AGGREGATE_SLOTS
            .iter()
            .find(|r| r.0 == schema && r.1 == upper && usize::from(r.2) == index);
        let Some(&(_, _, _, optional, lower)) = slot else {
            next.push(raw.clone());
            continue;
        };
        if !survivors.is_empty() && survivors.len() >= lower as usize {
            changed = true;
            let joined: Vec<&str> = survivors.iter().map(|s| s.as_str()).collect();
            next.push(format!("{lead}({}){trail}", joined.join(",")));
        } else if survivors.is_empty() && optional {
            changed = true;
            next.push(format!("{lead}${trail}"));
        } else {
            next.push(raw.clone());
        }
    }
    if changed {
        Filtered::Rewrite(rebuild(text, &next))
    } else {
        Filtered::Keep
    }
}

/// Whether `NONREL_AGGREGATE_SLOTS` (sorted by schema, then type) has a row
/// for `upper` in `schema`.
fn has_aggregate_rows(schema: &str, upper: &str) -> bool {
    let at = NONREL_AGGREGATE_SLOTS.partition_point(|r| (r.0, r.1) < (schema, upper));
    NONREL_AGGREGATE_SLOTS.get(at).is_some_and(|r| r.0 == schema && r.1 == upper)
}

/// `detachRelatedObjects`' narrowing: `filterHiddenRefsFromRelationshipLine`
/// with `detached` as the exclusion set. `None` when nothing would remain.
pub(crate) fn detach_related_objects(text: &str, detached: &std::collections::HashSet<u32>) -> Option<String> {
    match relationship(text, &|r| detached.contains(&r), None)? {
        Filtered::Keep => Some(text.to_string()),
        Filtered::Rewrite(t) => Some(t),
        Filtered::Withhold(_) => None,
    }
}

/// The source pass's filter for one line of effective type `upper`.
pub(crate) fn filter_source_line(
    text: &str,
    id: u32,
    upper: &str,
    schema: &str,
    excluded: &dyn Fn(u32) -> bool,
    any_excluded: bool,
) -> Filtered {
    if upper.starts_with("IFCREL") {
        return relationship(text, excluded, None).unwrap_or_else(|| Filtered::Withhold(withheld(id, upper, true)));
    }
    if STYLE_RESCUE_TYPES.contains(&upper) {
        let registry = matches!(schema, "IFC2X3" | "IFC4" | "IFC4X3").then_some(schema);
        return relationship(text, excluded, registry.or(Some("")))
            .unwrap_or_else(|| Filtered::Withhold(withheld(id, upper, false)));
    }
    let registry = if matches!(schema, "IFC2X3" | "IFC4" | "IFC4X3") { schema } else { "" };
    // Narrowing changes nothing for a type with no bounded aggregate slot in
    // this schema, or when the pass omits nothing; skip the split for them.
    if !any_excluded || !has_aggregate_rows(registry, upper) {
        return Filtered::Keep;
    }
    narrow(text, excluded, upper, registry)
}

/// The created-entity pass's filter: the same three branches as the source
/// pass, so a created styled item, layer assignment, texture map or
/// non-relationship aggregate naming an omitted entity is narrowed or
/// withheld rather than written with a dangling `#N` (#5941 review; the
/// TypeScript created-entity pass was brought in line in the same change).
pub(crate) fn filter_created_line(
    text: &str,
    id: u32,
    upper: &str,
    schema: &str,
    excluded: &dyn Fn(u32) -> bool,
    any_excluded: bool,
) -> Filtered {
    filter_source_line(text, id, upper, schema, excluded, any_excluded)
}

#[cfg(test)]
#[path = "refilter_tests.rs"]
mod tests;
