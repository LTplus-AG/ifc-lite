// SPDX-License-Identifier: MPL-2.0
//! IFC2X3 typed material and profile properties as IFC4 property records.

use std::collections::HashMap;

use ifc_lite_core::parser::{is_step_value, parse_ref, parse_step_real, skip_step_trivia};
use ifc_lite_core::EntityScanner;

use crate::generated::ifc2x3_typed_properties::IFC2X3_TYPED_PROPERTIES;
use crate::schema_convert::canon;
use crate::schema_ifc4_slots::Ifc4SlotCheck;
use crate::schema_structural_diagnostics::StructuralDiagnostics;
use crate::step_ids::IdAllocator;
use crate::step_record_frame::{record_frame, record_head};
use crate::step_slot::slots_of;

pub(crate) type Row = (&'static str, usize, &'static [(&'static str, &'static [Field])]);
pub(crate) struct Field(pub(crate) usize, pub(crate) &'static str, pub(crate) &'static str, pub(crate) Kind);
pub(crate) enum Kind { Number, Boolean, Text }

fn lookup(ty: &str) -> Option<&'static Row> {
    let upper = ty.bytes().any(|b| b.is_ascii_lowercase()).then(|| ty.to_ascii_uppercase());
    IFC2X3_TYPED_PROPERTIES
        .binary_search_by_key(&upper.as_deref().unwrap_or(ty), |row| row.0)
        .ok().map(|i| &IFC2X3_TYPED_PROPERTIES[i])
}

pub(crate) fn applies(from: &str, to: &str) -> bool {
    canon(from) == "IFC2X3" && matches!(canon(to), "IFC4" | "IFC4X3")
}

pub(crate) fn has_typed_records(content: &[u8]) -> bool {
    let mut scan = EntityScanner::new(content);
    while let Some((_, ty, _, _)) = scan.next_entity() {
        if lookup(ty).is_some() {
            return true;
        }
    }
    false
}

impl Kind {
    fn accepts(&self, value: &str) -> bool {
        let bytes = value.as_bytes();
        match self {
            Self::Number => parse_step_real(bytes).is_some(),
            Self::Text => skip_step_trivia(bytes, 0).and_then(|start| bytes.get(start)) == Some(&b'\'')
                && is_step_value(bytes),
            Self::Boolean => {
                let Some(start) = skip_step_trivia(bytes, 0) else { return false };
                let token = bytes.get(start..start + 3);
                token.is_some_and(|v| v.eq_ignore_ascii_case(b".T.") || v.eq_ignore_ascii_case(b".F."))
                    && skip_step_trivia(bytes, start + 3) == Some(bytes.len())
            }
        }
    }
}

struct Group {
    name: &'static str,
    properties: Vec<(&'static str, String)>,
}

struct Draft {
    source_type: &'static str,
    groups: Vec<Group>,
    check_ifc4_slots: bool,
}

#[derive(Default)]
pub(crate) struct TypedPropertyUpgrade {
    pub(crate) enabled: bool,
    drafts: HashMap<u32, Draft>,
    refused: usize,
}

impl TypedPropertyUpgrade {
    /// Remember values from the effective input, keyed by their final id.
    /// Reserve generated ids after every source and appended record is known.
    pub(crate) fn capture(&mut self, source: &str, from: &str, to: &str, id: u32) -> bool {
        if !self.enabled || from != "IFC2X3" || !matches!(to, "IFC4" | "IFC4X3") {
            return false;
        }
        let Some(head) = record_head(source) else { return false };
        let Some(&(source_type, arity, sets)) = lookup(head.type_name(source)) else { return false };
        let Some(values) = record_frame(source).and_then(|frame| slots_of(frame.args(source))) else { return false };
        if values.len() != arity {
            return false;
        }
        let Some(attributes) = crate::schema_convert::schema_attribute_names(from, source_type) else { return false };
        let groups: Vec<Group> = sets.iter().filter_map(|(name, fields)| {
            let properties = fields.iter().filter_map(|Field(index, name, ty, kind)| {
                let value = values[*index];
                kind.accepts(value).then(|| (attributes[*index], format!("IFCPROPERTYSINGLEVALUE('{name}',$,{ty}({value}),$);")))
            }).collect::<Vec<_>>();
            (!properties.is_empty()).then_some(Group { name, properties })
        }).collect();
        if groups.is_empty() {
            return false;
        }
        self.drafts.insert(id, Draft { source_type, groups, check_ifc4_slots: to == "IFC4" });
        true
    }

    pub(crate) fn warning(&self) -> Option<String> {
        (self.refused > 0).then(|| format!(
            "{} typed property record(s) could not be preserved because the target reference is missing or the export has run out of STEP ids (#10797).",
            self.refused
        ))
    }

    pub(crate) fn finish(
        &mut self, text: &str, mut ids: IdAllocator, slots: &mut Ifc4SlotCheck, dropped: &mut usize,
        structural: &mut StructuralDiagnostics,
    ) -> Option<(String, usize)> {
        if self.drafts.is_empty() {
            return None;
        }
        let mut scanner = EntityScanner::new(text);
        let mut output = String::with_capacity(text.len());
        let mut appended = Vec::new();
        let mut copied = 0;
        while let Some((id, _, start, end)) = scanner.next_entity() {
            let Some(draft) = self.drafts.remove(&id) else { continue };
            let line = &text[start..end];
            output.push_str(&text[copied..start]);
            copied = end;
            if let Some(replacement) = draft.emit(line, &mut ids, &mut appended) {
                let restored: usize = draft.groups.iter().map(|group| group.properties.len()).sum();
                *dropped = dropped.saturating_sub(restored);
                if draft.check_ifc4_slots {
                    slots.count(&replacement);
                    for (attribute, _) in draft.groups.iter().flat_map(|group| &group.properties) {
                        structural.restore_omitted_value(draft.source_type, attribute, "IFC4");
                    }
                }
                output.push_str(&replacement);
            } else {
                self.refused += 1;
                if draft.check_ifc4_slots {
                    slots.count(line);
                }
                output.push_str(line);
            }
        }
        output.push_str(&text[copied..]);
        for line in &appended {
            output.push_str(line);
            output.push('\n');
        }
        Some((output, appended.len()))
    }
}

impl Draft {
    fn emit(&self, line: &str, ids: &mut IdAllocator, appended: &mut Vec<String>) -> Option<String> {
        let frame = record_frame(line)?;
        let parts = slots_of(frame.args(line))?;
        let [_, _, _, reference] = parts.as_slice() else { return None };
        parse_ref(reference.as_bytes())?;
        let size = self.groups.iter().map(|group| group.properties.len() + 1).sum::<usize>() - 1;
        let size = u32::try_from(size).ok()?;
        let first = ids.reserve(size)?;
        let mut available = (0..size).map(|offset| first + offset);
        let mut parent = None;
        for (index, group) in self.groups.iter().enumerate() {
            let refs = group.properties.iter().map(|(_, property)| {
                let id = available.next().expect("reserved every property");
                appended.push(format!("#{id}={property}"));
                format!("#{id}")
            }).collect::<Vec<_>>();
            let args = format!("'{}',$,({}),{reference}", group.name, refs.join(","));
            if index == 0 {
                parent = Some(frame.with_args(line, &args));
            } else {
                let id = available.next().expect("reserved every extra set");
                appended.push(format!("#{id}={}({args});", frame.head.type_name(line)));
            }
        }
        parent
    }
}
