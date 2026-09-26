// SPDX-License-Identifier: MPL-2.0
//! `resolveEffectiveEntityRecord`: a record's attributes as the export will
//! write them — the created payload or the source record, re-laid-out for a
//! retype by name, then the named and positional edits on top. The exporter
//! reads relationships and set containers through it when the session edited
//! them.

use serde_json::Value;

use super::attrs::schema_names;
use super::pass::Pass;
use super::refs::Slot;

pub(crate) struct Record {
    pub(crate) names: &'static [&'static str],
    pub(crate) attributes: Vec<Slot>,
}

impl Record {
    /// The slot named `name`, if the record's class declares it.
    pub(crate) fn named(&self, name: &str) -> Option<&Slot> {
        let i = self.names.iter().position(|n| *n == name)?;
        self.attributes.get(i)
    }
}

fn put(attributes: &mut Vec<Slot>, index: usize, slot: Slot) {
    if index >= attributes.len() {
        attributes.resize(index + 1, Slot::Authored(Value::Null));
    }
    attributes[index] = slot;
}

pub(crate) fn effective_record(pass: &Pass<'_, '_>, id: u32) -> Option<Record> {
    let (record_type, attrs): (String, Vec<Slot>) = match pass.overlay.created(id) {
        Some(e) => (e.entity_type.to_uppercase(), e.attributes.iter().cloned().map(Slot::Authored).collect()),
        None => {
            let (ty, attrs) = pass.src.entity(id)?;
            (ty, attrs.into_iter().map(Slot::Source).collect())
        }
    };
    let effective_type = match pass.overlay.retypes.get(&id) {
        Some((t, _)) => t.to_uppercase(),
        None => record_type.clone(),
    };
    let names = schema_names(&effective_type, pass.schema);
    let mut attributes = if names.is_empty() || effective_type == record_type {
        attrs
    } else {
        let source_names = schema_names(&record_type, pass.schema);
        if source_names.is_empty() {
            attrs
        } else {
            let mut by_name: Vec<(&str, Slot)> = Vec::new();
            for (i, name) in source_names.iter().enumerate() {
                let value = attrs.get(i).cloned().unwrap_or(Slot::Authored(Value::Null));
                match by_name.iter_mut().find(|(n, _)| n == name) {
                    Some(entry) => entry.1 = value,
                    None => by_name.push((name, value)),
                }
            }
            names
                .iter()
                .map(|n| by_name.iter().find(|(m, _)| m == n).map(|(_, v)| v.clone()).unwrap_or(Slot::Authored(Value::Null)))
                .collect()
        }
    };
    for (name, value) in pass.attribute_edits(id).unwrap_or(&[]) {
        if let Some(i) = names.iter().position(|n| n == name) {
            put(&mut attributes, i, Slot::Authored(Value::String(value.clone())));
        }
    }
    for (i, value) in pass.overlay.positionals(id) {
        put(&mut attributes, *i, Slot::Authored(value.clone()));
    }
    Some(Record { names, attributes })
}
