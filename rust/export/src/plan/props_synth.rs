// SPDX-License-Identifier: MPL-2.0
//! Record synthesis for [`super::props`]: building a fresh
//! property/quantity value record, and either appending a brand-new
//! occurrence-only set + relationship for it, or cloning a SHARED
//! occurrence set so only this object sees the edit. Split out of
//! `props.rs` for the module-size ratchet — this half never reads the
//! file's SHARING state (that is `resolve_set_writes`'s job), it only
//! writes new records from values already decided on.

use ifc_lite_core::SchemaFamily;

use crate::step_text::escape;
use crate::step_ids::IdAllocator;
use crate::step_slot::is_step_value;

use super::attrs::{attribute_index, build_record};
use super::props::PropOutcome;
use super::types::{PropWrite, PsetKind};

/// The value records a property or quantity set lists and a write edits or
/// writes: `(entity, value slot, measures it carries)`. The one table
/// [`quantity_entity_for_measure`], [`value_slot_name`] and
/// [`is_value_entity`] read, so they cannot drift. Quantities are typed by
/// their CONTAINING entity (`IfcQuantityLength` carries an
/// `IfcLengthMeasure`); a property stays `IfcPropertySingleValue` whatever
/// its measure, so its row names none.
const VALUE_RECORDS: [(&str, &str, &[&str]); 7] = [
    ("IFCPROPERTYSINGLEVALUE", "NominalValue", &[]),
    ("IFCQUANTITYLENGTH", "LengthValue", &["IFCLENGTHMEASURE", "IFCPOSITIVELENGTHMEASURE"]),
    ("IFCQUANTITYAREA", "AreaValue", &["IFCAREAMEASURE"]),
    ("IFCQUANTITYVOLUME", "VolumeValue", &["IFCVOLUMEMEASURE"]),
    ("IFCQUANTITYCOUNT", "CountValue", &["IFCCOUNTMEASURE"]),
    ("IFCQUANTITYTIME", "TimeValue", &["IFCTIMEMEASURE"]),
    ("IFCQUANTITYWEIGHT", "WeightValue", &["IFCMASSMEASURE"]),
];

/// The `IfcQuantity*` entity for a measure type, when this executor knows
/// one ([`VALUE_RECORDS`]).
pub(crate) fn quantity_entity_for_measure(measure_type: &str) -> Option<&'static str> {
    VALUE_RECORDS.iter().find(|(_, _, measures)| measures.contains(&measure_type)).map(|&(entity, _, _)| entity)
}

/// Whether `entity` is a value record a set lists ([`VALUE_RECORDS`]).
pub(crate) fn is_value_entity(entity: &str) -> bool {
    VALUE_RECORDS.iter().any(|&(e, _, _)| e == entity)
}

/// Build a fresh property/quantity value record generically from the
/// schema's own attribute order: `Name` gets the property/quantity name,
/// `NominalValue` (property) gets the measure-typed value, the slot ending
/// in `Value` (quantity) gets the bare literal, `Unit` gets the caller's
/// unit or `$`, everything else stays `$`.
///
/// The two value slots are encoded differently because their EXPRESS types
/// differ: `NominalValue` is `IfcValue`, a SELECT, so STEP names the chosen
/// type (`IFCLABEL('x')`); `IfcQuantityLength.LengthValue` is the defined
/// type `IfcLengthMeasure` itself, so STEP writes only the number (`5.`).
pub(crate) fn build_value_record(schema: &str, id: u32, entity_type: &str, name: &str, measure_type: &str, literal: &str, unit: Option<&str>) -> String {
    let names = ifc_lite_core::attribute_names_for_schema(schema, entity_type).unwrap_or(&[]);
    let mut slots = vec!["$".to_string(); names.len()];
    for (i, n) in names.iter().enumerate() {
        match *n {
            "Name" => slots[i] = format!("'{}'", escape(name)),
            "NominalValue" => slots[i] = format!("{measure_type}({literal})"),
            "Unit" => slots[i] = unit.unwrap_or("$").to_string(),
            n if n.ends_with("Value") => slots[i] = literal.to_string(),
            _ => {}
        }
    }
    format!("#{id}={entity_type}({});", slots.join(","))
}

/// The slot a value record carries its value in ([`VALUE_RECORDS`]);
/// `NominalValue` for anything else.
pub(crate) fn value_slot_name(value_type: &str) -> &'static str {
    VALUE_RECORDS.iter().find(|&&(entity, _, _)| entity == value_type).map_or("NominalValue", |&(_, slot, _)| slot)
}

pub(crate) fn value_entity(write: &PropWrite) -> Result<&'static str, String> {
    check_caller_text(write)?;
    match write.kind {
        PsetKind::Property => Ok("IFCPROPERTYSINGLEVALUE"),
        PsetKind::Quantity => quantity_entity_for_measure(&write.measure_type)
            .ok_or_else(|| format!("no IfcQuantity* entity known for measure {}", write.measure_type)),
    }
}

/// The one check of a write's value against its measure type, run before any
/// record is built: the value must be a literal of that type in `schema`
/// (`'abc'` is not an `IfcLengthMeasure`), within its WHERE rule, and a
/// quantity must not be negative. Also the shape rules of
/// [`check_caller_text`]. Every property and quantity write passes through it.
pub(crate) fn check_value(family: Option<SchemaFamily>, write: &PropWrite) -> Result<&'static str, String> {
    let entity = value_entity(write)?;
    crate::step_log::check_literal_measure(family, &write.measure_type, &write.literal, write.kind == PsetKind::Property)?;
    if write.kind == PsetKind::Quantity && write.literal.trim_start().starts_with('-') {
        return Err("a quantity cannot be negative".to_string());
    }
    Ok(entity)
}

/// A write's measure type, value and unit are STEP text the caller
/// serialized, and are written as given. They are held to the rule every STEP
/// writer in this crate holds a caller's values to (#7715): the measure type
/// is an entity-shaped name, and the value and unit are each one STEP value
/// with no comment (`step_slot::is_step_value`). Anything else could shift
/// the record's slots, end it early, or open a comment that swallows what
/// follows, so the write is refused instead.
fn check_caller_text(write: &PropWrite) -> Result<(), String> {
    if !crate::step_log::is_entity_name(&write.measure_type) {
        return Err(format!("measure type {:?} is not a type name", write.measure_type));
    }
    if !is_step_value(&write.literal) {
        return Err(format!("value {:?} is not one STEP value", write.literal));
    }
    if let Some(unit) = write.unit.as_deref().filter(|u| !is_step_value(u)) {
        return Err(format!("unit {unit:?} is not one STEP value"));
    }
    Ok(())
}

/// A fresh `IfcPropertySet`/`IfcElementQuantity` whose member list is
/// `member_ids` (verbatim — the caller decides which are new and which are
/// reused), plus the `IfcRelDefinesByProperties` naming only `object_id`.
/// `seed` distinguishes the deterministic GlobalIds of an append from a
/// copy-on-write clone that otherwise share every other input.
#[allow(clippy::too_many_arguments, clippy::type_complexity)]
fn build_set_and_rel(
    schema: &str,
    container_type: &str,
    member_attr: &str,
    object_id: u32,
    write: &PropWrite,
    ids: &mut IdAllocator,
    owner_history: Option<u32>,
    member_ids: &[u32],
    seed: &str,
) -> Result<((u32, String), (u32, String)), String> {
    // A quantity set and a property set of one name are two sets.
    let kind = if write.kind == PsetKind::Quantity { ":qto" } else { "" };
    let set_guid = crate::merged::deterministic_global_id(&format!("plan-pset{kind}:{seed}:{object_id}:{}:{}", write.pset, write.prop));
    let rel_guid = crate::merged::deterministic_global_id(&format!("plan-rel{kind}:{seed}:{object_id}:{}:{}", write.pset, write.prop));
    let pset_id = ids.allocate().ok_or("id space exhausted")?;
    let pset_record = set_record(schema, container_type, member_attr, pset_id, &set_guid, owner_history, &write.pset, member_ids);
    let rel_id = ids.allocate().ok_or("id space exhausted")?;
    let rel_record = defines_by_properties_record(schema, rel_id, &rel_guid, owner_history, &[object_id], pset_id);
    Ok(((pset_id, pset_record), (rel_id, rel_record)))
}

/// One `IfcPropertySet`/`IfcElementQuantity` record named `name` over
/// `member_ids`, with `global_id` already encoded.
#[allow(clippy::too_many_arguments)]
pub(crate) fn set_record(
    schema: &str,
    container_type: &str,
    member_attr: &str,
    id: u32,
    global_id: &str,
    owner_history: Option<u32>,
    name: &str,
    member_ids: &[u32],
) -> String {
    build_record(
        schema,
        id,
        container_type,
        &[
            ("GlobalId", format!("'{global_id}'")),
            ("OwnerHistory", ref_or_unset(owner_history)),
            ("Name", format!("'{}'", escape(name))),
            (member_attr, ref_list(member_ids)),
        ],
    )
}

/// One `IfcRelDefinesByProperties` attaching `set_id` to every id in `related`.
pub(crate) fn defines_by_properties_record(
    schema: &str,
    id: u32,
    global_id: &str,
    owner_history: Option<u32>,
    related: &[u32],
    set_id: u32,
) -> String {
    build_record(
        schema,
        id,
        "IFCRELDEFINESBYPROPERTIES",
        &[
            ("GlobalId", format!("'{global_id}'")),
            ("OwnerHistory", ref_or_unset(owner_history)),
            ("RelatedObjects", ref_list(related)),
            ("RelatingPropertyDefinition", format!("#{set_id}")),
        ],
    )
}

/// `#id`, or `$` when there is none.
pub(crate) fn ref_or_unset(id: Option<u32>) -> String {
    id.map(|id| format!("#{id}")).unwrap_or_else(|| "$".into())
}

/// `(#a,#b,...)` in the order given.
pub(crate) fn ref_list(ids: &[u32]) -> String {
    format!("({})", ids.iter().map(|id| format!("#{id}")).collect::<Vec<_>>().join(","))
}

/// A fresh value record carrying `write` (its literal already canonical:
/// [`super::props_target::ResolvedWrite::for_new_record`]), as `(id, STEP text)`.
fn new_value(schema: &str, write: &PropWrite, ids: &mut IdAllocator) -> Result<(u32, String), String> {
    let value_type = value_entity(write)?;
    let value_id = ids.allocate().ok_or("id space exhausted")?;
    let record = build_value_record(schema, value_id, value_type, &write.prop, &write.measure_type, &write.literal, write.unit.as_deref());
    Ok((value_id, record))
}

/// A brand-new occurrence-only set holding one fresh value per write, and
/// the relationship attaching it to `object_id`. `writes` is non-empty and
/// shares one set name; the first write seeds the GlobalIds.
#[allow(clippy::too_many_arguments)]
pub(crate) fn append_new_occurrence_set(
    schema: &str,
    container_type: &str,
    member_attr: &str,
    object_id: u32,
    writes: &[&PropWrite],
    ids: &mut IdAllocator,
    owner_history: Option<u32>,
) -> Result<PropOutcome, String> {
    let mut new_records = writes.iter().map(|w| new_value(schema, w, ids)).collect::<Result<Vec<_>, _>>()?;
    let member_ids: Vec<u32> = new_records.iter().map(|(id, _)| *id).collect();
    let (pset, rel) = build_set_and_rel(schema, container_type, member_attr, object_id, writes[0], ids, owner_history, &member_ids, "new")?;
    new_records.extend([pset, rel]);
    Ok(PropOutcome::Append { new_records })
}

/// A fresh value record carrying `write`, to be appended to `pset_id`'s
/// member list (an existing set nothing else shares).
pub(crate) fn fold_new_value(schema: &str, write: &PropWrite, ids: &mut IdAllocator, pset_id: u32, member_idx: usize) -> Result<PropOutcome, String> {
    let (value_id, record) = new_value(schema, write, ids)?;
    Ok(PropOutcome::Fold { new_records: vec![(value_id, record)], append: (pset_id, member_idx, value_id) })
}

/// Clone just a leaf value found shared with another set (see
/// [`super::props::leaf_is_shared`]): a fresh value record carrying the
/// write, named for `pset_id`'s member-list slot to repoint at. The actual
/// repoint is left for [`super::resolve`], the same way
/// [`copy_on_write_occurrence_set`] leaves its detach for
/// [`super::delete::resolve_deletes`].
pub(crate) fn leaf_copy_on_write(
    schema: &str,
    write: &PropWrite,
    ids: &mut IdAllocator,
    pset_id: u32,
    member_idx: usize,
    old_leaf: u32,
) -> Result<PropOutcome, String> {
    let (value_id, record) = new_value(schema, write, ids)?;
    Ok(PropOutcome::LeafCopyOnWrite { new_records: vec![(value_id, record)], replace: (pset_id, member_idx, old_leaf, value_id) })
}

/// Clone a SHARED occurrence set: each write gets a new value record, which
/// replaces the member `replaced` names for it or is appended when it names
/// none; every other member id is reused verbatim (still shared, still
/// correct for whoever else uses the original). Names the detach of
/// `object_id` from `owning_rel`'s `RelatedObjects` (left for
/// [`super::delete::resolve_deletes`] to apply, alongside whatever else the
/// same plan strips from that relationship; see
/// [`PropOutcome::CopyOnWrite`]), and relates the clone to `object_id` with
/// a new relationship.
#[allow(clippy::too_many_arguments)]
pub(crate) fn copy_on_write_occurrence_set(
    schema: &str,
    container_type: &str,
    member_attr: &str,
    object_id: u32,
    writes: &[&PropWrite],
    ids: &mut IdAllocator,
    owner_history: Option<u32>,
    members: &[Option<u32>],
    replaced: &[Option<u32>],
    owning_rel: u32,
) -> Result<PropOutcome, String> {
    let mut new_records = Vec::new();
    let mut new_members: Vec<u32> = members.iter().flatten().copied().collect();
    for (write, old) in writes.iter().zip(replaced) {
        let (value_id, record) = new_value(schema, write, ids)?;
        new_records.push((value_id, record));
        match old {
            Some(old) => new_members.iter_mut().filter(|m| **m == *old).for_each(|m| *m = value_id),
            None => new_members.push(value_id),
        }
    }

    let (pset, rel) = build_set_and_rel(schema, container_type, member_attr, object_id, writes[0], ids, owner_history, &new_members, "cow")?;
    new_records.extend([pset, rel]);

    let related_idx = attribute_index(schema, "IFCRELDEFINESBYPROPERTIES", "RelatedObjects")
        .ok_or("IFCRELDEFINESBYPROPERTIES has no RelatedObjects attribute in this schema")?;

    Ok(PropOutcome::CopyOnWrite { new_records, detach: (owning_rel, related_idx, object_id) })
}

#[cfg(test)]
mod value_records_tests {
    /// A measure names one quantity entity: the table lookup takes the first match.
    #[test]
    fn each_measure_maps_to_one_quantity_entity() {
        let mut seen = std::collections::HashSet::new();
        for (_, _, measures) in super::VALUE_RECORDS {
            for measure in measures {
                assert!(seen.insert(*measure), "{measure} maps to more than one quantity entity");
            }
        }
    }
}
