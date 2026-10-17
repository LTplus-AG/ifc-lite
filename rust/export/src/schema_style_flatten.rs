// SPDX-License-Identifier: MPL-2.0
//! `IfcPresentationStyleAssignment` flattening for an IFC2X3 or IFC4 source
//! converted to IFC4X3 (#7742, D57).
//!
//! IFC4X3 dropped the assignment: `IfcStyledItem.Styles` takes
//! `IfcPresentationStyle` members directly. Refusing the assignment (non-rooted,
//! absent from the IFC4X3 registry) would fail 23 of 37 IFC2X3 and 10 of 46
//! IFC4 corpus files that export on main, so the conversion flattens instead:
//! every `Styles` entry of an `IfcStyledItem` (or subtype) that names an
//! assignment is replaced by that assignment's own `Styles` members, in order,
//! each kept once, and the assignment records are not written.
//!
//! Complete by the schemas' own rules: in IFC2X3 and IFC4 the only legal
//! referrer of an assignment is `IfcStyledItem.Styles`. It needs a pre-pass
//! because an assignment may follow the styled item that names it. Twin of
//! `packages/export/src/schema-style-flatten.ts`, pinned for both by
//! `tests/fixtures/schema_style_flatten_vectors.json`.

use std::collections::HashMap;

use crate::step_slot::split_top_level_args;

const ASSIGNMENT: &str = "IFCPRESENTATIONSTYLEASSIGNMENT";

/// The assignments of one source file and what each holds.
#[derive(Default)]
pub(crate) struct StyleFlatten {
    members: HashMap<u32, Vec<String>>,
}

/// `(type keyword, attribute text)` of a `#id=TYPE(attrs);` record.
fn split_record(line: &str) -> Option<(&str, &str, &str)> {
    let eq = line.find('=')?;
    let after = &line[eq + 1..];
    let open = after.find('(')?;
    let close = after.rfind(')')?;
    (close > open).then(|| (after[..open].trim(), &after[open + 1..close], &after[..open + 1]))
}

fn list_members(arg: &str) -> Option<Vec<String>> {
    let t = arg.trim();
    match t.strip_prefix('(').and_then(|r| r.strip_suffix(')')) {
        Some(inner) => split_top_level_args(inner).map(|v| v.into_iter().map(|m| m.trim().to_string()).collect()),
        None => Some(vec![t.to_string()]),
    }
}

/// IFC4X3's `Styles` takes `IfcPresentationStyle` entities only: the typed
/// `IFCNULLSTYLE(.NULL.)` of IFC2X3/IFC4 has no place there and is dropped.
fn without_null_style(members: Vec<String>) -> Vec<String> {
    members
        .into_iter()
        .filter(|m| !m.trim_start().get(..13).is_some_and(|h| h.eq_ignore_ascii_case("IFCNULLSTYLE(")))
        .collect()
}

fn ref_id(token: &str) -> Option<u32> {
    token.trim().strip_prefix('#')?.trim().parse().ok()
}

impl StyleFlatten {
    /// True for the one conversion that flattens: an IFC2X3 or IFC4 source,
    /// an IFC4X3 target.
    pub(crate) fn applies(from: &str, to: &str) -> bool {
        to == "IFC4X3" && matches!(from, "IFC2X3" | "IFC4")
    }

    /// Read every assignment of `content` (canonical schema names). `None`
    /// when this conversion does not flatten or the file holds no assignment.
    pub(crate) fn build(content: &[u8], from: &str, to: &str) -> Option<Self> {
        if !Self::applies(from, to) {
            return None;
        }
        let mut flat = Self::default();
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            if type_name.eq_ignore_ascii_case(ASSIGNMENT) {
                flat.note(id, &String::from_utf8_lossy(&content[start..end]));
            }
        }
        (!flat.members.is_empty()).then_some(flat)
    }

    /// [`Self::build`] for an export between two schema labels; empty when
    /// the conversion does not flatten.
    pub(crate) fn for_export(content: &[u8], from: &str, to: &str) -> Self {
        let (from, to) = (crate::schema_convert::canon(from), crate::schema_convert::canon(to));
        Self::build(content, from, to).unwrap_or_default()
    }

    /// `line`, flattened when it is a styled item naming an assignment.
    pub(crate) fn line(&self, from: &str, line: String) -> String {
        self.rewrite(crate::schema_convert::canon(from), &line).unwrap_or(line)
    }

    /// [`Self::rewrite`] over a record's bytes, for the merged writer.
    pub(crate) fn bytes(&self, from: &str, bytes: &[u8]) -> Option<String> {
        self.rewrite(crate::schema_convert::canon(from), &String::from_utf8_lossy(bytes))
    }

    /// Register an assignment record by its text (source, created or copied;
    /// the last record with an id wins). An unreadable one is forgotten.
    pub(crate) fn note(&mut self, id: u32, text: &str) {
        let members = split_record(text)
            .and_then(|(_, attrs, _)| split_top_level_args(attrs))
            .and_then(|args| list_members(args.first()?))
            .map(without_null_style);
        match members {
            Some(m) => self.members.insert(id, m),
            None => self.members.remove(&id),
        };
    }

    /// Register every assignment among records the export appends (created,
    /// generated, rewritten), before any record is written: a styled item may
    /// precede the assignment it names.
    pub(crate) fn note_all<'a>(&mut self, records: impl Iterator<Item = &'a (u32, String)>) {
        for (id, text) in records {
            if split_record(text).is_some_and(|(ty, _, _)| ty.eq_ignore_ascii_case(ASSIGNMENT)) {
                self.note(*id, text);
            }
        }
    }

    /// Copy-on-write copies and attribute edits of assignments: a copy takes
    /// its source's members unless an edit sets `Styles` (slot 0); an edit of
    /// an existing assignment replaces its members.
    pub(crate) fn note_edits(
        &mut self,
        copies: &[(u32, u32, std::collections::BTreeMap<usize, String>)],
        edits: &HashMap<u32, std::collections::BTreeMap<usize, String>>,
    ) {
        let set = |flat: &mut Self, id: u32, value: &str| {
            if let Some(m) = list_members(value) {
                flat.members.insert(id, without_null_style(m));
            }
        };
        for (id, e) in edits {
            if let (true, Some(v)) = (self.drops(*id), e.get(&0)) {
                set(self, *id, v);
            }
        }
        for (copy, source, own) in copies {
            let Some(inherited) = self.members.get(source).cloned() else { continue };
            self.members.insert(*copy, inherited);
            if let Some(v) = own.get(&0).or_else(|| edits.get(source).and_then(|e| e.get(&0))) {
                set(self, *copy, v);
            }
        }
    }

    /// An assignment record is not written.
    pub(crate) fn drops(&self, id: u32) -> bool {
        self.members.contains_key(&id)
    }

    /// `line` with its `Styles` entries flattened, or `None` when it is not a
    /// styled item naming an assignment. `from` is the canonical source schema.
    pub(crate) fn rewrite(&self, from: &str, line: &str) -> Option<String> {
        let trimmed = line.trim_end();
        let body = trimmed.strip_suffix(';').unwrap_or(trimmed);
        let (ty, attrs, head) = split_record(body)?;
        let mut args = split_top_level_args(attrs)?;
        let upper = ty.to_ascii_uppercase();
        let styles = list_members(args.get(1)?)?;
        if !styles.iter().any(|m| ref_id(m).is_some_and(|id| self.members.contains_key(&id))) {
            return None;
        }
        if !ifc_lite_core::is_subtype_of_for_schema(from, &upper, "IFCSTYLEDITEM") {
            return None;
        }
        let mut flat: Vec<String> = Vec::new();
        for member in styles {
            let expanded = match ref_id(&member).and_then(|id| self.members.get(&id)) {
                Some(inner) => inner.clone(),
                None => vec![member],
            };
            for m in expanded {
                if !flat.contains(&m) {
                    flat.push(m);
                }
            }
        }
        args[1] = format!("({})", flat.join(","));
        let eq = body.find('=')?;
        Some(format!("{}{}{});", &body[..=eq], head, args.join(",")))
    }
}

#[cfg(test)]
#[path = "schema_style_flatten_tests.rs"]
mod tests;
