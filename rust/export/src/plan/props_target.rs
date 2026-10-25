// SPDX-License-Identifier: MPL-2.0
//! Which set and value record a property write lands on, resolved once per
//! write into a [`ResolvedWrite`], and the unit a new value record carries.
//! Reads the file only; [`super::props`] decides what to write.

use std::borrow::Cow;

use ifc_lite_core::SchemaFamily;

use super::attrs::attribute_index;
use super::index::FileIndex;
use super::props_lookup::{container_names, decoded_name, find_member, find_set, occurrence_rels, occurrence_set_of, type_rel, type_sets};
use super::props_synth;
use super::types::{PropScope, PropWrite, PsetKind};

/// What one object's property writes resolve against, read once per patch:
/// the file, its schema (and that schema's family, `None` when unknown), the
/// object, and the sets the writes can land on.
pub(crate) struct WriteTarget<'a> {
    pub(crate) index: &'a FileIndex<'a>,
    pub(crate) schema: &'a str,
    pub(crate) family: Option<SchemaFamily>,
    pub(crate) object_id: u32,
    pub(crate) sets: ObjectSets,
}

impl<'a> WriteTarget<'a> {
    pub(crate) fn read(index: &'a FileIndex<'a>, schema: &'a str, object_id: u32) -> Self {
        WriteTarget { index, schema, family: SchemaFamily::of_file_schema(schema), object_id, sets: ObjectSets::read(index, schema, object_id) }
    }
}

/// The sets an object's property writes can land on.
#[derive(Debug, Default)]
pub(crate) struct ObjectSets {
    /// `(IfcRelDefinesByProperties, set)` for each set related to the object.
    pub(crate) own: Vec<(u32, u32)>,
    /// The sets its related type lists in `HasPropertySets`.
    pub(crate) typed: Vec<u32>,
    /// Its related type.
    pub(crate) type_id: Option<u32>,
}

impl ObjectSets {
    fn read(index: &FileIndex, schema: &str, object_id: u32) -> Self {
        let own = occurrence_rels(index, schema, object_id)
            .into_iter()
            .filter_map(|rel| Some((rel, occurrence_set_of(index, schema, rel)?)))
            .collect();
        let type_id = type_rel(index, schema, object_id).map(|(_, type_id)| type_id);
        let typed = type_id.map(|type_id| type_sets(index, schema, type_id)).unwrap_or_default();
        ObjectSets { own, typed, type_id }
    }
}

/// A write as it lands, resolved once against the file. Nothing downstream
/// looks its set or record up again by name.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ResolvedWrite<'w> {
    pub(crate) write: &'w PropWrite,
    /// The set the write edits: one the object owns (occurrence scope) or
    /// one its related type lists (type scope). `None` when there is none of
    /// the write's name; an occurrence write then starts one.
    pub(crate) set: Option<u32>,
    /// The record in `set` the write edits: in place, or by a copy when the
    /// record or its set is shared.
    pub(crate) record: Option<u32>,
    /// With no `record`, the type-owned record an occurrence override
    /// replaces: the one targeted, else the first of the write's name in the
    /// first type set of the write's name.
    pub(crate) overrides: Option<u32>,
}

impl<'w> ResolvedWrite<'w> {
    /// Writes with one key reach one record, or add one member of that name
    /// to the set they land on, so the last of them wins. An override with
    /// no record of the object's own adds the member whichever type record
    /// it overrides: two overrides of one property are one member.
    pub(crate) fn dedupe_key(&self) -> (Option<u32>, Option<&str>) {
        (self.record, self.record.is_none().then_some(self.write.prop.as_str()))
    }

    /// The write a NEW value record is built from: its literal canonical in
    /// `family` and, when the caller named no unit, the unit of the record it
    /// replaces (`record`, else `overrides`). Borrowed when neither changes
    /// it. An in-place edit uses `self.write` as given, which leaves the
    /// record's unit slot alone when it names none.
    pub(crate) fn for_new_record(&self, target: &WriteTarget<'_>) -> Cow<'w, PropWrite> {
        let literal = crate::step_log::canonical_literal(target.family, &self.write.measure_type, &self.write.literal);
        let unit = match self.write.unit {
            Some(_) => None,
            None => self.record.or(self.overrides).and_then(|old| unit_of(target.index, target.schema, self.write, old)),
        };
        if literal == self.write.literal && unit.is_none() {
            return Cow::Borrowed(self.write);
        }
        let mut write = self.write.clone();
        write.literal = literal.into_owned();
        write.unit = unit.or(write.unit);
        Cow::Owned(write)
    }
}

/// `old`'s unit, as `write` would carry it: only from a value of the same
/// measure (the same quantity entity, or a property of the same measure
/// type), so a length never takes an area's unit; otherwise, or when `old`
/// has no unit, none.
fn unit_of(index: &FileIndex, schema: &str, write: &PropWrite, old: u32) -> Option<String> {
    let entity = index.type_of(old)?;
    (props_synth::value_entity(write).ok()? == entity).then_some(())?;
    if write.kind == PsetKind::Property {
        let nominal = attribute_index(schema, &entity, "NominalValue")?;
        let value = crate::step_text::attribute_of(&index.raw_line(old)?, nominal)?;
        // An unset value contradicts nothing; a typed one must name the
        // write's measure.
        let bytes = value.as_bytes();
        let start = ifc_lite_core::parser::skip_step_trivia(bytes, 0)?;
        let name_len = bytes[start..].iter().take_while(|b| b.is_ascii_alphanumeric() || **b == b'_').count();
        let name = &value[start..start + name_len];
        (bytes.get(start) == Some(&b'$') || name.eq_ignore_ascii_case(&write.measure_type)).then_some(())?;
    }
    let idx = attribute_index(schema, &entity, "Unit")?;
    index.attrs(old)?.into_iter().nth(idx)?.scalar.map(|unit| format!("#{unit}"))
}

/// `write` resolved against `object_id`. A target is checked here: it must
/// be in a set of the object, the set must be the one the write names, and
/// the record must be named as the write's property. A target in a set the
/// write edits (the object's own, or for a type-scoped write the type's) is
/// its record. A target only the related type holds is overridden: the write
/// lands on the object's own set of that name (or starts one), on that set's
/// record of the property if it has one. An untargeted write lands on the
/// first set of its name and that set's first record of its property.
pub(crate) fn resolve_write<'w>(target: &WriteTarget<'_>, write: &'w PropWrite) -> Result<ResolvedWrite<'w>, String> {
    let (index, schema) = (target.index, target.schema);
    // The object's own sets, for an occurrence write; a type write sees none.
    let occurrence = write.scope == PropScope::Occurrence;
    let own = || target.sets.own.iter().filter(move |_| occurrence).map(|(_, set)| set);
    let typed = &target.sets.typed;
    let mut overrides = None;
    if let Some(target_id) = write.target {
        // The set listing the target, preferring the one the write names.
        let Some((holder, ..)) = find_set(index, schema, own().chain(typed), write.kind, &write.pset, Some(target_id)) else {
            return Err(format!("target #{target_id} is not a member of any set of this object"));
        };
        let (container, _) = container_names(write.kind);
        if decoded_name(index, schema, holder, container).as_deref() != Some(write.pset.as_str()) {
            return Err(format!("target #{target_id} is not a member of the named set {}", write.pset));
        }
        let member_type = index.type_of(target_id).unwrap_or_default();
        let member_name = decoded_name(index, schema, target_id, &member_type);
        if member_name.as_deref() != Some(write.prop.as_str()) {
            return Err(format!("target #{target_id} is named {}, not {}", member_name.unwrap_or_default(), write.prop));
        }
        if own().any(|&set| set == holder) || !occurrence {
            return Ok(ResolvedWrite { write, set: Some(holder), record: Some(target_id), overrides: None });
        }
        overrides = Some(target_id);
    }
    let found = if occurrence {
        find_set(index, schema, own(), write.kind, &write.pset, None)
    } else {
        find_set(index, schema, typed.iter(), write.kind, &write.pset, None)
    };
    let set = found.as_ref().map(|&(set, ..)| set);
    let record = found.and_then(|(_, _, members)| find_member(index, schema, &members, &write.prop, None));
    if record.is_some() {
        return Ok(ResolvedWrite { write, set, record, overrides: None });
    }
    if occurrence && overrides.is_none() {
        overrides = find_set(index, schema, typed.iter(), write.kind, &write.pset, None)
            .and_then(|(_, _, members)| find_member(index, schema, &members, &write.prop, None));
    }
    Ok(ResolvedWrite { write, set, record: None, overrides })
}
