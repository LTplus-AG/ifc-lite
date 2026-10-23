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

use std::collections::{HashMap, HashSet};

use crate::step_slot::split_top_level_args;

const ASSIGNMENT: &str = "IFCPRESENTATIONSTYLEASSIGNMENT";
/// Deepest list nesting [`StyleFlatten::strip`] reads (IFC nests three).
const MAX_DEPTH: usize = 8;

/// What [`StyleFlatten::rewrite`] makes of one record.
#[derive(Debug, PartialEq)]
pub(crate) enum Flat {
    /// Written as it is.
    Keep,
    /// Not written: an assignment, or a styled item whose `Styles` flattens to nothing.
    Drop,
    /// Written as this text.
    Write(String),
}

/// The assignments of one source file and what each holds.
#[derive(Default)]
pub(crate) struct StyleFlatten {
    members: HashMap<u32, Vec<String>>,
    /// Styled items whose `Styles` names records only, by those ids: the ones
    /// that can flatten to nothing. Read from the source once an assignment
    /// holds nothing IFC4X3 can name (`collected`); created ones always.
    styled: HashMap<u32, Vec<u32>>,
    collected: bool,
    /// Styled items whose flattened `Styles` is empty (`SET [1:?]` in IFC4X3,
    /// so `()` is not a file): not written, and every reference to one is
    /// removed (a list member) or written `$` (a single slot).
    emptied: HashSet<u32>,
    /// The canonical source schema; empty when the export does not flatten.
    from: &'static str,
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

/// The `#n` ids of a `Styles` value, or `None` when a member is not a reference.
fn style_refs(value: &str) -> Option<Vec<u32>> {
    list_members(value)?.iter().map(|m| ref_id(m)).collect()
}

fn is_styled(from: &str, ty: &str) -> bool {
    ifc_lite_core::is_subtype_of_for_schema(from, &ty.to_ascii_uppercase(), "IFCSTYLEDITEM")
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
        let mut flat = Self { from: crate::schema_convert::canon(from), ..Self::default() };
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            if type_name.eq_ignore_ascii_case(ASSIGNMENT) {
                flat.note(id, &String::from_utf8_lossy(&content[start..end]));
            }
        }
        flat.settle(content);
        (!flat.members.is_empty()).then_some(flat)
    }

    /// [`Self::build`] for an export between two schema labels; empty when
    /// the conversion does not flatten.
    pub(crate) fn for_export(content: &[u8], from: &str, to: &str) -> Self {
        let (from, to) = (crate::schema_convert::canon(from), crate::schema_convert::canon(to));
        let idle = Self { from: if Self::applies(from, to) { from } else { "" }, ..Self::default() };
        Self::build(content, from, to).unwrap_or(idle)
    }

    /// `line`, flattened when it is a styled item naming an assignment;
    /// `None` when it is not written.
    pub(crate) fn line(&self, from: &str, line: String) -> Option<String> {
        match self.rewrite(crate::schema_convert::canon(from), &line) {
            Flat::Keep => Some(line),
            Flat::Drop => None,
            Flat::Write(text) => Some(text),
        }
    }

    /// [`Self::rewrite`] over a record's bytes, for the merged writer.
    pub(crate) fn bytes(&self, from: &str, bytes: &[u8]) -> Flat {
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

    /// Register a styled item by its text (see `styled`).
    fn note_styled(&mut self, id: u32, text: &str) {
        let refs = split_record(text).and_then(|(_, attrs, _)| split_top_level_args(attrs)).and_then(|a| style_refs(a.get(1)?));
        match refs {
            Some(r) => self.styled.insert(id, r),
            None => self.styled.remove(&id),
        };
    }

    /// Register every assignment and styled item among records the export
    /// writes in place of or after the source ones (edited, created,
    /// generated, rewritten), before any record is written: a styled item may
    /// precede the assignment it names.
    pub(crate) fn note_all<'a>(&mut self, content: &[u8], records: impl Iterator<Item = (u32, &'a str)>) {
        if self.from.is_empty() {
            return; // this conversion does not flatten
        }
        for (id, text) in records {
            match split_record(text) {
                Some((ty, _, _)) if ty.eq_ignore_ascii_case(ASSIGNMENT) => self.note(id, text),
                Some((ty, _, _)) if is_styled(self.from, ty) => self.note_styled(id, text),
                _ => {}
            }
        }
        self.settle(content);
    }

    /// Copy-on-write copies and attribute edits of assignments and styled
    /// items: a copy takes its source's `Styles` unless an edit sets it
    /// (assignment slot 0, styled item slot 1); an edit of an existing record
    /// replaces it.
    pub(crate) fn note_edits(
        &mut self,
        content: &[u8],
        copies: &[(u32, u32, std::collections::BTreeMap<usize, String>)],
        edits: &HashMap<u32, std::collections::BTreeMap<usize, String>>,
    ) {
        for (id, e) in edits {
            if let (true, Some(v)) = (self.members.contains_key(id), e.get(&0)) {
                if let Some(m) = list_members(v) {
                    self.members.insert(*id, without_null_style(m));
                }
            }
        }
        self.collect(content);
        for (id, e) in edits {
            if let (true, Some(v)) = (self.styled.contains_key(id), e.get(&1)) {
                self.set_styled(*id, v);
            }
        }
        for (copy, source, own) in copies {
            let edit = |slot: usize| own.get(&slot).or_else(|| edits.get(source).and_then(|e| e.get(&slot)));
            if let Some(inherited) = self.members.get(source).cloned() {
                self.members.insert(*copy, inherited);
                if let Some(m) = edit(0).and_then(|v| list_members(v)) {
                    self.members.insert(*copy, without_null_style(m));
                }
            } else if let Some(inherited) = self.styled.get(source).cloned() {
                self.styled.insert(*copy, inherited);
                if let Some(v) = edit(1) {
                    self.set_styled(*copy, v);
                }
            }
        }
        self.settle(content);
    }

    fn set_styled(&mut self, id: u32, value: &str) {
        match style_refs(value) {
            Some(r) => self.styled.insert(id, r),
            None => self.styled.remove(&id),
        };
    }

    /// Read the source's styled items once an assignment holds nothing.
    fn collect(&mut self, content: &[u8]) {
        if self.collected || !self.members.values().any(Vec::is_empty) {
            return;
        }
        self.collected = true;
        let from = self.from;
        let mut kinds: HashMap<&str, bool> = HashMap::new();
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        while let Some((id, ty, start, end)) = scanner.next_entity() {
            if *kinds.entry(ty).or_insert_with(|| is_styled(from, ty)) && !self.styled.contains_key(&id) {
                self.note_styled(id, &String::from_utf8_lossy(&content[start..end]));
            }
        }
    }

    /// Decide which styled items flatten to nothing.
    fn settle(&mut self, content: &[u8]) {
        self.collect(content);
        let empty = |r: &u32| self.members.get(r).is_some_and(Vec::is_empty);
        self.emptied =
            self.styled.iter().filter(|(_, refs)| !refs.is_empty() && refs.iter().all(empty)).map(|(id, _)| *id).collect();
    }

    /// A record that is not written: an assignment, or a styled item whose
    /// `Styles` flattens to nothing.
    pub(crate) fn drops(&self, id: u32) -> bool {
        self.members.contains_key(&id) || self.emptied.contains(&id)
    }

    /// `Styles` of a styled item naming an assignment, flattened; `None` for
    /// any other record.
    fn flattened(&self, from: &str, ty: &str, args: &[String]) -> Option<Vec<String>> {
        let styles = list_members(args.get(1)?)?;
        if !styles.iter().any(|m| ref_id(m).is_some_and(|id| self.members.contains_key(&id))) {
            return None;
        }
        if !ifc_lite_core::is_subtype_of_for_schema(from, &ty.to_ascii_uppercase(), "IFCSTYLEDITEM") {
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
        Some(flat)
    }

    /// `arg` without its references to an emptied styled item; `None` when
    /// `arg` is one.
    fn strip(&self, arg: &str, depth: usize) -> Option<String> {
        let t = arg.trim();
        if ref_id(t).is_some_and(|id| self.emptied.contains(&id)) {
            return None;
        }
        let items = (depth < MAX_DEPTH).then(|| t.strip_prefix('(')?.strip_suffix(')')).flatten();
        if let Some(items) = items.and_then(split_top_level_args) {
            let kept: Vec<Option<String>> = items.iter().map(|m| self.strip(m, depth + 1)).collect();
            if kept.iter().zip(&items).any(|(k, m)| k.as_deref() != Some(m.as_str())) {
                return Some(format!("({})", kept.into_iter().flatten().collect::<Vec<_>>().join(",")));
            }
        }
        Some(arg.to_string())
    }

    /// `line` with its `Styles` entries flattened and its references to an
    /// emptied styled item removed. `from` is the canonical source schema.
    pub(crate) fn rewrite(&self, from: &str, line: &str) -> Flat {
        let trimmed = line.trim_end();
        let body = trimmed.strip_suffix(';').unwrap_or(trimmed);
        let Some((ty, attrs, head)) = split_record(body) else { return Flat::Keep };
        let Some(mut args) = split_top_level_args(attrs) else { return Flat::Keep };
        let mut changed = false;
        if let Some(flat) = self.flattened(from, ty, &args) {
            if flat.is_empty() {
                return Flat::Drop;
            }
            args[1] = format!("({})", flat.join(","));
            changed = true;
        }
        if !self.emptied.is_empty() && attrs.contains('#') {
            for arg in &mut args {
                let stripped = self.strip(arg, 0).unwrap_or_else(|| "$".to_string());
                if stripped != *arg {
                    *arg = stripped;
                    changed = true;
                }
            }
        }
        match (changed, body.find('=')) {
            (true, Some(eq)) => Flat::Write(format!("{}{}{});", &body[..=eq], head, args.join(","))),
            _ => Flat::Keep,
        }
    }
}

#[cfg(test)]
#[path = "schema_style_flatten_tests.rs"]
mod tests;
