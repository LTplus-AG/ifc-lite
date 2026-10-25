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
/// own (occurrence scope only), then its related type's.
fn candidate_sets(index: &FileIndex, schema: &str, object_id: u32, write: &PropWrite, occurrence_only: bool) -> Vec<u32> {
    let occurrence = match write.scope {
        PropScope::Occurrence => occurrence_rels(index, schema, object_id).into_iter().filter_map(|rel| occurrence_set_of(index, schema, rel)).collect(),
        PropScope::Type => Vec::new(),
    };
    let typed = match type_rel(index, schema, object_id) {
        Some((_, type_id)) if !occurrence_only => type_sets(index, schema, type_id),
        _ => Vec::new(),
    };
    [occurrence, typed].concat()
}

/// The set among `sets` that `write` lands on: the one listing `target`, else
/// the first of the write's name.
fn find_holder(index: &FileIndex, schema: &str, sets: &[u32], write: &PropWrite, target: Option<u32>) -> Option<u32> {
    find_set(index, schema, sets.iter(), write.kind, &write.pset, target).map(|(set, ..)| set)
}

/// The set `write` lands on: the one listing its exact target, else the first
/// of the right name. Writes with the same holder are resolved together, so
/// a set is cloned or folded into once, whether the writes name their record
/// or not.
pub(crate) fn holding_set(index: &FileIndex, schema: &str, object_id: u32, write: &PropWrite) -> Option<u32> {
    find_holder(index, schema, &candidate_sets(index, schema, object_id, write, false), write, write.target)
}

/// `write` as it is resolved, with the set it lands on. An occurrence write
/// that targets a record only the related type holds is an override: it joins
/// the object's own set of that name (or starts one) like an untargeted
/// write, so the object never ends up with two sets of one name. A write
/// whose named set does not list its target is refused.
pub(crate) fn resolve_write(index: &FileIndex, schema: &str, object_id: u32, write: &PropWrite) -> Result<(PropWrite, Option<u32>), String> {
    let holder = holding_set(index, schema, object_id, write);
    let mut write = write.clone();
    let Some(target) = write.target else { return Ok((write, holder)) };
    if let Some(holder) = holder {
        let (container, _) = container_names(write.kind);
        if decoded_name(index, schema, holder, container).as_deref() != Some(write.pset.as_str()) {
            return Err(format!("target #{target} is not a member of the named set {}", write.pset));
        }
    }
    if write.scope == PropScope::Occurrence {
        let own = candidate_sets(index, schema, object_id, &write, true);
        if find_holder(index, schema, &own, &write, Some(target)).is_none() && type_owned_member(index, schema, object_id, &write) == Some(target) {
            write.target = None;
        }
    }
    // An override joins the object's own set of the name, so its holder is
    // the one an untargeted write finds.
    let holder = if write.target.is_none() { holding_set(index, schema, object_id, &write) } else { holder };
    Ok((write, holder))
}
