// SPDX-License-Identifier: MPL-2.0
//! Source-schema inventory. Geometry job eligibility is never a membership rule.

#[path = "prefix.rs"]
mod prefix;

use super::{Counts, Product};
use ifc_lite_core::parser::{header, skip_step_trivia};
use ifc_lite_core::{AttributeValue, DecodedEntity, EntityIndex, EntityScanner, SchemaVersion};
use std::collections::{BTreeMap, BTreeSet};

pub(super) const MAX_BYTES: usize = 512 * 1024 * 1024;
pub(super) const MAX_RECORDS: usize = 2_000_000;
const MAX_RECORD_BYTES: usize = 1024 * 1024;

pub(super) struct Inventory {
    pub records: Vec<(u32, String)>,
    pub index: EntityIndex,
    pub schema: SchemaVersion,
    pub diagnostics: Vec<String>,
}

pub(super) fn inventory(content: &[u8], limit: usize) -> Inventory {
    let schema = header::first_declared_schema(content, SchemaVersion::from_file_schema);
    let mut result = Inventory {
        records: Vec::new(),
        index: EntityIndex::default(),
        // A fallback can retain provisional rows, but cannot certify enumeration.
        schema: schema.unwrap_or(SchemaVersion::Ifc4x3),
        diagnostics: Vec::new(),
    };
    if schema.is_none() {
        result.diagnostics.push("enumeration:unknown_schema".into());
    }
    let mut scanner = EntityScanner::new(content);
    let mut end = scanner.position();
    if end == 0 {
        result
            .diagnostics
            .push("enumeration:missing_DATA_header".into());
    }
    if prefix::data_start(content) != Some(end) {
        result
            .diagnostics
            .push("enumeration:unverified_DATA_prefix".into());
    }
    while let Some((id, name, start, next)) = scanner.next_entity() {
        if result.records.len() >= limit {
            result.diagnostics.push("enumeration:record_bound".into());
            return result;
        }
        if skip_step_trivia(content, end) != Some(start) {
            result
                .diagnostics
                .push(format!("enumeration:unread_record_before/{start}"));
        }
        end = next;
        if result.index.contains_key(&id) {
            result
                .diagnostics
                .push(format!("enumeration:duplicate_id/{id}"));
            continue;
        }
        result.records.push((id, name.to_ascii_uppercase()));
        if next - start > MAX_RECORD_BYTES {
            result
                .diagnostics
                .push(format!("enumeration:record_byte_bound/{id}"));
        } else {
            result.index.insert(id, (start, next));
        }
    }
    if scanner.skipped_oversized_ids() > 0 || scanner.malformed_record_start().is_some() {
        result
            .diagnostics
            .push("enumeration:scanner_dropped_records".into());
    }
    // Only a fully framed single DATA section is certified by this example.
    // Scanner recovery / unknown syntax / truncated tails never mean complete.
    let tail = &content[end..];
    let section = header::find_keyword_then(tail, b"ENDSEC", header::Then::Semicolon);
    let framed = section.is_some_and(|section| {
        if skip_step_trivia(tail, 0) != Some(section.start) {
            return false;
        }
        let footer = &tail[section.then + 1..];
        header::find_keyword_then(footer, b"END-ISO-10303-21", header::Then::Semicolon).is_some_and(
            |hit| {
                skip_step_trivia(footer, 0) == Some(hit.start)
                    && skip_step_trivia(footer, hit.then + 1) == Some(footer.len())
            },
        )
    });
    if !framed {
        result
            .diagnostics
            .push("enumeration:unverified_DATA_end".into());
    }
    result
}

pub(super) fn product(ifc_type: &str) -> Product {
    Product {
        ifc_type: ifc_type.to_owned(),
        global_id: None,
        representation_state: "unresolved",
        representation_roles: BTreeMap::new(),
        intrinsic_visual_roles: BTreeSet::new(),
        enumeration_complete: true,
        representation_families: BTreeMap::new(),
        source_admission: "refused",
        verdict: "refused",
        reasons: BTreeSet::new(),
        counts: Counts::default(),
        item_ids: BTreeSet::new(),
    }
}

pub(super) fn fail(product: &mut Product, reason: &str) {
    product.enumeration_complete = false;
    product.reasons.insert(reason.to_owned());
}

pub(super) fn attribute<'a>(
    entity: &'a DecodedEntity,
    schema: SchemaVersion,
    name: &str,
) -> Option<&'a AttributeValue> {
    let index = schema
        .attribute_names(entity.ifc_type.name())?
        .iter()
        .position(|candidate| *candidate == name)?;
    entity.get(index)
}

// Unlike get_refs, this never silently drops a malformed aggregate member.
pub(super) fn refs(value: Option<&AttributeValue>) -> Option<Vec<u32>> {
    let AttributeValue::List(values) = value? else {
        return None;
    };
    values
        .iter()
        .map(|value| match value {
            AttributeValue::EntityRef(id) => Some(*id),
            _ => None,
        })
        .collect()
}
