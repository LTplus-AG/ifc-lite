// SPDX-License-Identifier: MPL-2.0
//! Which set and value record a property write lands on: the set that lists
//! its target, the one the related type owns, and the unit a replacement
//! keeps, and the resolved form of a targeted write. Reads the file only;
//! [`super::props`] decides what to write.

use super::attrs::attribute_index;
use super::index::FileIndex;
use super::props_lookup::{container_names, decoded_name, find_member, find_set, occurrence_rels, occurrence_set_of, type_rel, type_sets};
use super::props_synth;
use super::types::{PropScope, PropWrite, PsetKind};

/// `write`, carrying the unit of the value record it replaces when the caller
/// named none: a copy keeps the unit the original had, as an in-place edit
/// keeps its slot. Only from a value of the same measure (the same quantity entity, or
/// a property of the same measure type), so a length never takes an area's
/// unit.
pub(super) fn keeping_old_unit(index: &FileIndex, schema: &str, write: &PropWrite, old: Option<u32>) -> PropWrite {
    let mut write = write.clone();
    if write.unit.is_none() {
        write.unit = old.and_then(|old| {
            let entity = index.type_of(old)?;
            (props_synth::value_entity(&write).ok()? == entity).then_some(())?;
            if write.kind == PsetKind::Property {
                let nominal = attribute_index(schema, &entity, "NominalValue")?;
                let value = crate::step_text::attribute_of(&index.raw_line(old)?, nominal)?;
                // An unset value contradicts nothing; a typed one must name
                // the write's measure.
                let bytes = value.as_bytes();
                let start = ifc_lite_core::parser::skip_step_trivia(bytes, 0)?;
                let name_len = bytes[start..].iter().take_while(|b| b.is_ascii_alphanumeric() || **b == b'_').count();
                let name = &value[start..start + name_len];
                (bytes.get(start) == Some(&b'$') || name.eq_ignore_ascii_case(&write.measure_type)).then_some(())?;
            }
            let idx = attribute_index(schema, &entity, "Unit")?;
            index.attrs(old)?.into_iter().nth(idx)?.scalar.map(|unit| format!("#{unit}"))
        });
    }
    write
}

/// The value record of `write`'s property in the set of that name on the
/// object's related type: what an occurrence override with no value of its
/// own overrides, so the effective value whose unit "none" keeps.
pub(super) fn type_owned_member(index: &FileIndex, schema: &str, object_id: u32, write: &PropWrite) -> Option<u32> {
    let (_, type_id) = type_rel(index, schema, object_id)?;
    let (_, _, members) = find_set(index, schema, type_sets(index, schema, type_id).iter(), write.kind, &write.pset, write.target)?;
    find_member(index, schema, &members, &write.prop, write.target)
}

/// The sets `write` can land on, in the order they are tried: the object's
/// own (occurrence scope only, `own`), then its related type's.
fn candidate_sets(index: &FileIndex, schema: &str, object_id: u32, write: &PropWrite, own: &[u32]) -> Vec<u32> {
    let occurrence = if write.scope == PropScope::Occurrence { own.to_vec() } else { Vec::new() };
    let typed = match type_rel(index, schema, object_id) {
        Some((_, type_id)) => type_sets(index, schema, type_id),
        None => Vec::new(),
    };
    [occurrence, typed].concat()
}

/// The set among `sets` that `write` lands on: the one listing `target`
/// (preferring the one the write names), else the first of the write's name.
fn find_holder(index: &FileIndex, schema: &str, sets: &[u32], write: &PropWrite, target: Option<u32>) -> Option<u32> {
    find_set(index, schema, sets.iter(), write.kind, &write.pset, target).map(|(set, ..)| set)
}

/// `write` as it is resolved, with the set it lands on. Every target is
/// checked here, before writes are grouped: it must be in a set of the object,
/// the set must be the one the write names, and the record must be named as
/// the write's property. An occurrence write that targets a record only the
/// related type holds is an override: it is resolved again as an untargeted
/// write, joining the object's own set of that name (or starting one). An
/// untargeted write that finds its property in a set it will edit is given
/// that record as its target, so writes are deduped and grouped on the record
/// they reach.
pub(crate) fn resolve_write(index: &FileIndex, schema: &str, object_id: u32, write: &PropWrite) -> Result<(PropWrite, Option<u32>), String> {
    let own = own_sets(index, schema, object_id);
    let mut write = write.clone();
    let all = candidate_sets(index, schema, object_id, &write, &own);
    if let Some(target) = write.target {
        let Some(holder) = find_holder(index, schema, &all, &write, Some(target)) else {
            return Err(format!("target #{target} is not a member of any set of this object"));
        };
        let (container, _) = container_names(write.kind);
        if decoded_name(index, schema, holder, container).as_deref() != Some(write.pset.as_str()) {
            return Err(format!("target #{target} is not a member of the named set {}", write.pset));
        }
        let member_type = index.type_of(target).unwrap_or_default();
        let member_name = decoded_name(index, schema, target, &member_type);
        if member_name.as_deref() != Some(write.prop.as_str()) {
            return Err(format!("target #{target} is named {}, not {}", member_name.unwrap_or_default(), write.prop));
        }
        if write.scope == PropScope::Type || own.contains(&holder) {
            return Ok((write, Some(holder)));
        }
        // Only the related type holds it: an override, resolved by name.
        write.target = None;
    }
    let Some((holder, _, members)) = find_set(index, schema, all.iter(), write.kind, &write.pset, None) else { return Ok((write, None)) };
    // A member of a set the write edits is its record; one the related type
    // owns is overridden by name.
    if write.scope == PropScope::Type || own.contains(&holder) {
        write.target = find_member(index, schema, &members, &write.prop, None);
    }
    Ok((write, Some(holder)))
}

fn own_sets(index: &FileIndex, schema: &str, object_id: u32) -> Vec<u32> {
    occurrence_rels(index, schema, object_id).into_iter().filter_map(|rel| occurrence_set_of(index, schema, rel)).collect()
}
