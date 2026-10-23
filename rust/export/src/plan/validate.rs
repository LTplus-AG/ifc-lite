// SPDX-License-Identifier: MPL-2.0
//! Output validation: every `#ref` resolves, every GlobalId
//! is unique, each entity's attribute count matches what its schema
//! declares, and no object carries two directly-attached property/quantity
//! sets of the same name (the shape a bad copy-on-write produces: an
//! occurrence keeping the old shared set AND a new override both named
//! `Pset_WallCommon`, so a reader has no way to say which one is current).
//! Returns findings rather than panicking — a caller decides whether a
//! finding blocks publishing the file, this executor does not.
//!
//! [`StreamValidator`] sees each record once, as it is written, and never
//! holds the output: the defined-id test is the caller's (the writer answers
//! it from the source index), and the only state kept per record is a GlobalId
//! for the uniqueness check. The duplicate-set check is scoped by the caller
//! to the objects a plan patched, since a patch is the only way this executor
//! can introduce one.

use std::collections::BTreeMap;

use rustc_hash::FxHashMap;

use crate::merged::extract_global_id_fast;
use crate::step_record_frame::record_frame;
use crate::step_slot::slots_of;

use super::attrs::attribute_index;
use super::index::parse_attrs;
use super::types::ValidationFinding;

pub(crate) struct StreamValidator<'s> {
    schema: &'s str,
    findings: Vec<ValidationFinding>,
    /// First record carrying each GlobalId (always 22 bytes).
    global_ids: FxHashMap<[u8; 22], u32>,
    refs: Vec<u32>,
}

impl<'s> StreamValidator<'s> {
    pub(crate) fn new(schema: &'s str) -> Self {
        Self { schema, findings: Vec::new(), global_ids: FxHashMap::default(), refs: Vec::new() }
    }

    /// Check one output record. `type_upper` is its UPPERCASE entity type,
    /// `line` its full text, and `is_defined` answers whether an id is
    /// declared anywhere in the output.
    pub(crate) fn record(&mut self, id: u32, type_upper: &str, line: &str, is_defined: impl Fn(u32) -> bool) {
        if let Some(g) = extract_global_id_fast(type_upper, line.as_bytes()) {
            if let Ok(key) = <[u8; 22]>::try_from(g.as_bytes()) {
                match self.global_ids.get(&key) {
                    Some(&first) => self.findings.push(ValidationFinding {
                        express_id: Some(id),
                        message: format!("GlobalId {g} duplicated: also on #{first}"),
                    }),
                    None => {
                        self.global_ids.insert(key, id);
                    }
                }
            }
        }

        self.refs.clear();
        crate::step_text::refs_in_line(line.as_bytes(), &mut self.refs);
        for &r in &self.refs {
            if !is_defined(r) {
                self.findings.push(ValidationFinding {
                    express_id: Some(id),
                    message: format!("#{id} references #{r}, which is not in the file"),
                });
            }
        }

        if let Some(expected) = ifc_lite_core::attribute_names_for_schema(self.schema, type_upper) {
            match attribute_count(line) {
                Some(count) if count != expected.len() => self.findings.push(ValidationFinding {
                    express_id: Some(id),
                    message: format!(
                        "#{id} ({type_upper}) has {count} attributes, {} declares {}",
                        self.schema,
                        expected.len()
                    ),
                }),
                Some(_) => {}
                None => self.findings.push(ValidationFinding {
                    express_id: Some(id),
                    message: format!("#{id} ({type_upper}) did not scan into an attribute list"),
                }),
            }
        }
    }

    pub(crate) fn finish(mut self, more: Vec<ValidationFinding>) -> Vec<ValidationFinding> {
        self.findings.extend(more);
        self.findings
    }
}

/// Objects carrying two `IfcRelDefinesByProperties`-attached sets (either
/// kind — an `IfcPropertySet` or an `IfcElementQuantity`) with the same
/// `Name` directly. This is distinct from a TYPE's set and an occurrence's
/// override sharing a name, which is IFC's own by-name override rule and
/// deliberately not flagged here — only two sets attached to the SAME
/// object at the SAME (occurrence) level are a defect.
///
/// `rels` are the relationship texts to read, `record` gives any output
/// record's `(UPPERCASE type, text)`, and only objects `in_scope` accepts are
/// reported.
pub(crate) fn duplicate_pset_names(
    file_schema: &str,
    rels: impl IntoIterator<Item = String>,
    record: impl Fn(u32) -> Option<(String, String)>,
    in_scope: impl Fn(u32) -> bool,
) -> Vec<ValidationFinding> {
    let (Some(related_idx), Some(def_idx)) = (
        attribute_index(file_schema, "IFCRELDEFINESBYPROPERTIES", "RelatedObjects"),
        attribute_index(file_schema, "IFCRELDEFINESBYPROPERTIES", "RelatingPropertyDefinition"),
    ) else {
        return Vec::new();
    };
    // `(set entity, set name)` and the set's id, per object.
    type Named = ((String, String), u32);
    let mut names_by_object: BTreeMap<u32, Vec<Named>> = BTreeMap::new();

    for rel in rels {
        let Some(attrs) = parse_attrs(&rel) else { continue };
        let Some(related) = attrs.get(related_idx).and_then(|a| a.list.as_ref()) else { continue };
        let Some(def_id) = attrs.get(def_idx).and_then(|a| a.scalar) else { continue };
        let (def_type, def_line) = record(def_id).unwrap_or_default();
        let Some(name_idx) = attribute_index(file_schema, &def_type, "Name") else { continue };
        let Some(name) = crate::step_text::attribute_of(&def_line, name_idx) else { continue };
        let name = name.trim().trim_matches('\'').to_string();

        for &object_id in related.iter().flatten().filter(|&&o| in_scope(o)) {
            names_by_object.entry(object_id).or_default().push(((def_type.clone(), name.clone()), def_id));
        }
    }

    let mut findings = Vec::new();
    for (object_id, mut named) in names_by_object {
        named.sort();
        for window in named.windows(2) {
            // Keyed by set entity and name: a property set and a quantity
            // set may share a name.
            if window[0].0 == window[1].0 {
                findings.push(ValidationFinding {
                    express_id: Some(object_id),
                    message: format!(
                        "#{object_id} carries two property/quantity sets named '{}': #{} and #{}",
                        window[0].0 .1, window[0].1, window[1].1
                    ),
                });
            }
        }
    }
    findings
}

fn attribute_count(line: &str) -> Option<usize> {
    let frame = record_frame(line)?;
    Some(slots_of(frame.args(line))?.len())
}

/// Validate a whole STEP buffer, every object in scope. For tests: the
/// executor validates while it writes.
#[cfg(test)]
pub(crate) fn validate(output: &[u8], file_schema: &str) -> Vec<ValidationFinding> {
    let mut records: std::collections::HashMap<u32, (String, String)> = Default::default();
    let mut order = Vec::new();
    let mut scanner = ifc_lite_core::EntityScanner::new(output);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        let text = String::from_utf8_lossy(&output[start..end]).into_owned();
        records.insert(id, (type_name.to_ascii_uppercase(), text));
        order.push(id);
    }
    let mut v = StreamValidator::new(file_schema);
    for id in &order {
        let (type_upper, text) = &records[id];
        v.record(*id, type_upper, text, |r| records.contains_key(&r));
    }
    let rels = order
        .iter()
        .filter(|id| records[id].0 == "IFCRELDEFINESBYPROPERTIES")
        .map(|id| records[id].1.clone());
    let psets = duplicate_pset_names(file_schema, rels, |id| records.get(&id).cloned(), |_| true);
    v.finish(psets)
}

#[cfg(test)]
#[path = "validate_tests.rs"]
mod tests;
