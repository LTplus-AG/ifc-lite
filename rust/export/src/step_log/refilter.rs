// SPDX-License-Identifier: MPL-2.0
//! The reference filters the source pass runs whenever a session is active
//! (`filterHiddenRefsFromRelationshipLine`, `narrowNonRelPositionalRefLists`):
//! a record that names an entity this export does not write drops it from a
//! list slot, or is withheld when the reference sits where no omitted spelling
//! exists. This is the reference cleanup behind `DELETE_ENTITY`.

use crate::generated::step_log_tables::{NONREL_AGGREGATE_SLOTS, STYLE_SLOT_BOUNDS};

use super::lines::{read_slots, record_parts};

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

/// `/^\s*#\d+\s*=/`.
fn starts_with_record_id(text: &str) -> bool {
    let t = text.trim_start();
    let Some(rest) = t.strip_prefix('#') else { return false };
    let digits = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    digits > 0 && rest[digits..].trim_start().starts_with('=')
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
    let t = strip_trivia(item);
    let digits = t.strip_prefix('#')?;
    (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then(|| digits.parse().ok()).flatten()
}

/// `splitTopLevelListItems`.
fn list_items(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut parts = Vec::new();
    let mut current = String::new();
    let (mut depth, mut in_string, mut i) = (0i32, false, 0usize);
    while i < chars.len() {
        let c = chars[i];
        if !in_string && c == '/' && chars.get(i + 1) == Some(&'*') {
            let stop = (i + 2..chars.len().saturating_sub(1)).find(|&k| chars[k] == '*' && chars[k + 1] == '/').map_or(chars.len(), |k| k + 2);
            current.extend(&chars[i..stop]);
            i = stop;
            continue;
        }
        current.push(c);
        if in_string {
            if c == '\'' {
                if chars.get(i + 1) == Some(&'\'') {
                    current.push('\'');
                    i += 1;
                } else {
                    in_string = false;
                }
            }
        } else if c == '\'' {
            in_string = true;
        } else if c == '(' {
            depth += 1;
        } else if c == ')' {
            depth -= 1;
        } else if c == ',' && depth == 0 {
            current.pop();
            parts.push(current.trim().to_string());
            current.clear();
        }
        i += 1;
    }
    if !current.trim().is_empty() {
        parts.push(current.trim().to_string());
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
    let (prefix_end, _, suffix) = record_parts(text).expect("the slots were read from this record");
    format!("{}{}{}", &text[..prefix_end], args.join(","), suffix)
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
    let Some(args) = read_slots(text) else {
        return if starts_with_record_id(text) { None } else { Some(Filtered::Keep) };
    };
    let record_type = record_type(text);
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
    let Some(args) = read_slots(text) else { return Filtered::Keep };
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

/// The record's own type keyword, uppercased (`readStepSlots`' `type`).
fn record_type(text: &str) -> String {
    let after = text.split_once('=').map_or("", |(_, r)| r.trim_start());
    let end = after.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(after.len());
    after[..end].to_uppercase()
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
