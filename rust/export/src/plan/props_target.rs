// SPDX-License-Identifier: MPL-2.0
//! Which set and value record a property write lands on: the set that lists
//! its target, the one the related type owns, and the unit a replacement
//! keeps. Read-only; [`super::props`] decides what to write.

use super::attrs::attribute_index;
use super::index::FileIndex;
use super::props_lookup::{container_names, decoded_name, find_member, find_set, list_attr, occurrence_rels, scalar_attr, type_rel};
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
    let type_psets = list_attr(index, schema, type_id, &index.type_of(type_id)?, "HasPropertySets")?;
    let (_, _, members) = find_set(index, schema, type_psets.iter(), write.kind, &write.pset, write.target)?;
    find_member(index, schema, &members, &write.prop, write.target)
}

/// The sets `write` can land on, in the order they are tried: the object's
/// own (occurrence scope only), then its related type's.
pub(super) fn candidate_sets(index: &FileIndex, schema: &str, object_id: u32, write: &PropWrite, occurrence_only: bool) -> Vec<u32> {
    let occurrence: Vec<u32> = match write.scope {
        PropScope::Occurrence => occurrence_rels(index, schema, object_id)
            .into_iter()
            .filter_map(|rel| scalar_attr(index, schema, rel, "IFCRELDEFINESBYPROPERTIES", "RelatingPropertyDefinition"))
            .collect(),
        PropScope::Type => Vec::new(),
    };
    let from_type = || {
        let (_, type_id) = type_rel(index, schema, object_id)?;
        list_attr(index, schema, type_id, &index.type_of(type_id)?, "HasPropertySets")
    };
    let typed = if occurrence_only { Vec::new() } else { from_type().unwrap_or_default() };
    occurrence.into_iter().chain(typed).collect()
}

/// The set `write` lands on: the one listing its exact target, else the first
/// of the right name. Writes with the same holder are resolved together, so
/// a set is cloned or folded into once, whether the writes name their record
/// or not.
pub(crate) fn holding_set(index: &FileIndex, schema: &str, object_id: u32, write: &PropWrite) -> Option<u32> {
    let all = candidate_sets(index, schema, object_id, write, false);
    find_set(index, schema, all.iter(), write.kind, &write.pset, write.target).map(|(set, _, _)| set)
}

/// `write` as it is resolved. An occurrence write that targets a record only
/// the related type holds is an override: it joins the object's own set of
/// that name (or starts one) like an untargeted write, so the object never
/// ends up with two sets of one name.
pub(crate) fn effective_write(index: &FileIndex, schema: &str, object_id: u32, write: &PropWrite) -> Result<PropWrite, String> {
    let mut write = write.clone();
    let Some(target) = write.target else { return Ok(write) };
    // The set that lists the record must be the one the write names.
    if let Some(holder) = holding_set(index, schema, object_id, &write) {
        let (container, _) = container_names(write.kind);
        if decoded_name(index, schema, holder, container).as_deref() != Some(write.pset.as_str()) {
            return Err(format!("target #{target} is not a member of the named set {}", write.pset));
        }
    }
    if write.scope == PropScope::Occurrence {
        let own = candidate_sets(index, schema, object_id, &write, true);
        if find_set(index, schema, own.iter(), write.kind, &write.pset, Some(target)).is_none() && type_owned_member(index, schema, object_id, &write) == Some(target) {
            write.target = None;
        }
    }
    Ok(write)
}
