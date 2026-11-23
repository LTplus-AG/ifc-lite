// SPDX-License-Identifier: MPL-2.0
//! Withhold obsolete types with no target representation (#10970, #10971).
//! Evaluate refs in the final schema and ID space, after conversion and edits.
//! Twin of packages/export/src/schema-converter-unrooted-upgrade.ts.

use std::collections::{HashMap, HashSet};
use std::ops::Range;

use ifc_lite_core::{AttrSlot, EntityScanner, SchemaVersion};
use ifc_lite_core::parser::{is_step_value, StepListItems};

use crate::schema_convert::{canon, schema_attribute_names};
use crate::schema_unrepresented::{missing_type_route, Route};
use crate::step_record_frame::{record_frame, RecordFrame};
use crate::step_slot::slots_of;
use crate::step_text::ref_spans;

#[derive(Clone, Copy)]
pub(crate) struct Upgrade {
    from: &'static str,
    to: &'static str,
}

impl Upgrade {
    pub(crate) fn between(from: &str, to: &str) -> Option<Self> {
        let (from, to) = (canon(from), canon(to));
        matches!((from, to), ("IFC2X3", "IFC4") | ("IFC2X3" | "IFC4", "IFC4X3"))
            .then_some(Self { from, to })
    }

    pub(crate) fn omitted_type(self, raw: &str) -> bool {
        let upper = raw.bytes().any(|b| b.is_ascii_lowercase()).then(|| raw.to_ascii_uppercase());
        let ty = upper.as_deref().unwrap_or(raw);
        missing_type_route(ty, ty, self.from, self.to, schema_attribute_names(self.from, ty).is_some())
            == Route::Omitted
    }

    /// The streaming writers hold the DATA section only when the source
    /// may emit a removed type. The output scan resolves edits and selection.
    pub(crate) fn seeds(self, content: &[u8]) -> impl Iterator<Item = u32> + '_ {
        let mut scanner = EntityScanner::new(content);
        std::iter::from_fn(move || {
            while let Some((id, ty, _, _)) = scanner.next_entity() {
                if self.omitted_type(ty) {
                    return Some(id);
                }
            }
            None
        })
    }

    pub(crate) fn prune(self, text: &str) -> Option<(String, HashSet<u32>, Vec<String>)> {
        prune(text, &self.seeds(text.as_bytes()).collect(), self.to)
    }
}

fn refs(value: &str) -> impl Iterator<Item = u32> + '_ {
    ref_spans(value.as_bytes()).filter_map(|span| span.id)
}

fn list_minimum(schema: SchemaVersion, ty: &str, attribute: AttrSlot) -> Option<usize> {
    // The pruning bounds below describe IFC4 and IFC4X3. Check legacy aggregates whole.
    // Sectioned-spine sections and positions correspond by index. Withhold on any loss.
    if schema == SchemaVersion::Ifc2x3 || !attribute.aggregate || ty == "IFCSECTIONEDSPINE" {
        return None;
    }
    use crate::generated::ifc4_required_slots::{IFC4_AGGREGATE_PRUNE_EXCEPTIONS, IFC4X3_AGGREGATE_PRUNE_EXCEPTIONS};
    let exceptions = if schema == SchemaVersion::Ifc4 { IFC4_AGGREGATE_PRUNE_EXCEPTIONS } else { IFC4X3_AGGREGATE_PRUNE_EXCEPTIONS };
    let key = (ty, attribute.index);
    let special = exceptions
        .binary_search_by_key(&key, |&(name, index, _)| (name, index))
        .ok()
        .map(|i| exceptions[i].2);
    // Arrays and aggregate alternatives of SELECTs cannot be narrowed as a
    // variable-length STEP list. The sentinel describes a whole-slot loss.
    special.unwrap_or(Some(1))
}

fn list_members(value: &str) -> Option<Vec<&str>> {
    let mut items = StepListItems::of_list(value.as_bytes())?;
    if !is_step_value(value.as_bytes()) {
        return None;
    }
    let parts: Vec<&str> = items.by_ref().map(|part| {
        std::str::from_utf8(part).expect("STEP lexer trims only ASCII delimiters")
    }).collect();
    items.closed().then_some(parts)
}

fn read_slots<'a>(target: SchemaVersion, ty: &str, raw: &'a str) -> Option<(SchemaVersion, Vec<&'a str>, impl Iterator<Item = AttrSlot>)> {
    let values = slots_of(raw)?;
    let (schema, layout) = if let Some(layout) = target.attributes(ty) {
        (target, layout)
    } else if target == SchemaVersion::Ifc4 {
        (SchemaVersion::Ifc2x3, SchemaVersion::Ifc2x3.attributes(ty)?)
    } else {
        return None;
    };
    (values.len() == layout.len()).then_some((schema, values, layout))
}

#[derive(Default)]
struct Dependencies {
    users: HashMap<u32, Vec<usize>>,
    members: Vec<Option<usize>>,
    groups: Vec<Group>,
}

struct Group {
    owner: u32,
    remaining: usize,
    minimum: usize,
}

impl Dependencies {
    fn add(&mut self, owner: u32, members: &[&str], minimum: usize) {
        let group = self.groups.len();
        let first_member = self.members.len();
        for value in members {
            let member = self.members.len();
            let mut hits = refs(value).peekable();
            if hits.peek().is_some() {
                self.members.push(Some(group));
                for id in hits {
                    self.users.entry(id).or_default().push(member);
                }
            }
        }
        if self.members.len() != first_member {
            self.groups.push(Group { owner, remaining: members.len(), minimum });
        }
    }

    fn record(&mut self, target: SchemaVersion, id: u32, ty: &str, raw: &str) {
        let Some((schema, values, layout)) = read_slots(target, ty, raw) else {
            self.add(id, &[raw], 1);
            return;
        };
        for (value, attr) in values.into_iter().zip(layout) {
            if attr.optional {
                continue;
            }
            match list_minimum(schema, ty, attr).and_then(|min| Some((list_members(value)?, min))) {
                Some((members, min)) if min > 0 => self.add(id, &members, min),
                Some(_) => {},
                None => self.add(id, &[value], 1),
            }
        }
    }

    fn cascade(mut self, seeds: &HashSet<u32>) -> HashSet<u32> {
        let mut dropped = seeds.clone();
        let mut pending: Vec<u32> = seeds.iter().copied().collect();
        while let Some(id) = pending.pop() {
            for &member in self.users.get(&id).into_iter().flatten() {
                let Some(index) = self.members[member].take() else { continue };
                let group = &mut self.groups[index];
                group.remaining -= 1;
                if group.remaining < group.minimum && dropped.insert(group.owner) {
                    pending.push(group.owner);
                }
            }
        }
        dropped
    }
}

struct Record {
    id: u32,
    ty: String,
    span: Range<usize>,
    frame: Option<RecordFrame>,
}

fn index(text: &str, seeds: &HashSet<u32>, schema: SchemaVersion) -> (Vec<Record>, HashSet<u32>) {
    let mut scanner = EntityScanner::new(text);
    let mut records = Vec::new();
    let mut dependencies = Dependencies::default();
    while let Some((id, name, start, end)) = scanner.next_entity() {
        let line = &text[start..end];
        let frame = record_frame(line);
        let ty = name.to_ascii_uppercase();
        if !seeds.contains(&id) {
            dependencies.record(schema, id, &ty, frame.map_or(line, |frame| frame.args(line)));
        }
        records.push(Record { id, ty, span: start..end, frame });
    }
    (records, dependencies.cascade(seeds))
}

fn rewrite(schema: SchemaVersion, line: &str, ty: &str, frame: RecordFrame, dropped: &HashSet<u32>) -> Option<String> {
    let raw = frame.args(line);
    let touches = |value| refs(value).any(|id| dropped.contains(&id));
    if !touches(raw) {
        return None;
    }
    let (schema, values, layout) = read_slots(schema, ty, raw)?;
    let slots: Vec<String> = values.into_iter().zip(layout).map(|(value, attr)| {
        if !touches(value) {
            return value.to_owned();
        }
        if let Some(min) = list_minimum(schema, ty, attr) {
            if let Some(mut members) = list_members(value) {
                members.retain(|member| !touches(member));
                if members.len() >= min {
                    return format!("({})", members.join(","));
                }
            }
        }
        "$".to_owned()
    }).collect();
    Some(frame.with_args(line, &slots.join(",")))
}

/// Return the rewritten text, omitted IDs and warnings for the records removed.
pub(crate) fn prune(text: &str, seeds: &HashSet<u32>, to: &str) -> Option<(String, HashSet<u32>, Vec<String>)> {
    if seeds.is_empty() {
        return None;
    }
    let to = canon(to);
    let schema = SchemaVersion::from_file_schema(to)?;
    let issue = if schema == SchemaVersion::Ifc4 { 10970 } else { 10971 };
    let (records, dropped) = index(text, seeds, schema);
    let mut out = String::with_capacity(text.len());
    let mut warnings = Vec::new();
    let mut copied = 0;
    for record in records {
        out.push_str(&text[copied..record.span.start]);
        let line = &text[record.span.clone()];
        copied = record.span.end;
        if dropped.contains(&record.id) {
            let reason = if seeds.contains(&record.id) {
                format!("the {to} schema does not declare its type")
            } else {
                format!("a required {to} attribute lost a reference")
            };
            warnings.push(format!("#{} ({}) was omitted because {reason} (#{issue}).", record.id, record.ty));
            // Each writer appends a newline immediately after its record.
            copied += usize::from(text.as_bytes().get(copied) == Some(&b'\n'));
        } else if let Some(rewritten) = record.frame.and_then(|frame| rewrite(schema, line, &record.ty, frame, &dropped)) {
            out.push_str(&rewritten);
        } else {
            out.push_str(line);
        }
    }
    out.push_str(&text[copied..]);
    Some((out, dropped, warnings))
}
