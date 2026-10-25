// SPDX-License-Identifier: MPL-2.0
//! Typed property/quantity writes.
//!
//! Three shapes come out of one write, chosen by what the file already has:
//!
//! - the value exists, belongs to this occurrence alone, and nothing else
//!   shares its set: edited in place (one `AttrMutation`-shaped edit on the
//!   `IfcPropertySingleValue`/`IfcQuantity*` record itself, keeping its
//!   measure wrapper and unit unless the caller overwrote them);
//! - the value exists but its set is shared (by another occurrence, or —
//!   [`PropScope::Occurrence`] finding a value the related TYPE owns) — an
//!   occurrence-only `IfcPropertySet`/`IfcElementQuantity` carrying just this
//!   one value is appended and attached with its own
//!   `IfcRelDefinesByProperties`, and the shared record is never touched;
//! - the value does not exist at all: same append, a fresh set (or a fresh
//!   member folded into an existing UNSHARED set of the right name).
//!
//! Every attribute this module writes is looked up by name through
//! [`super::attrs::attribute_index`] rather than hardcoded, so a schema that
//! orders `IfcQuantityLength` or `IfcPropertySingleValue` differently (IFC4X3
//! renamed `Description` to `Specification` there — see `attrs.rs`'s tests)
//! is handled the same way a same-order schema is.

use crate::step_ids::IdAllocator;

use super::attrs::attribute_index;
use super::index::FileIndex;
use super::props_lookup::{
    container_names, find_member, find_set, leaf_is_shared, list_attr, occurrence_rels, pset_owners, pset_reaches_only, scalar_attr, type_rel,
};
use super::props_synth;
use super::types::{PropScope, PropWrite, PsetKind};

/// How a resolved existing value should be changed, or how a new one should
/// be appended.
#[derive(Debug)]
pub(crate) enum PropOutcome {
    /// Edit these (express_id, attribute index, new value text) slots on an
    /// existing, unshared record.
    InPlace(Vec<(u32, usize, String)>),
    /// Append these new records (id, STEP text): a fresh set and the
    /// relationship attaching it. Used only when the value comes from the
    /// related TYPE (an occurrence override) or no set of that name exists
    /// on this object at all; never for a SHARED occurrence set, which is
    /// [`PropOutcome::CopyOnWrite`] instead.
    Append { new_records: Vec<(u32, String)> },
    /// A new value record folded into an existing, unshared set. The member
    /// is named (`(set, member-list attribute index, new value)`) rather than
    /// rendered into the list here, so every change the plan makes to that
    /// list lands in one rewrite.
    Fold { new_records: Vec<(u32, String)>, append: (u32, usize, u32) },
    /// A shared occurrence set: clone it (only the one diverging member is a
    /// new record; every other member id is reused, still shared, unedited),
    /// and relate the clone to this object with a new relationship. No other
    /// occurrence sharing the old set is touched directly.
    ///
    /// Detaching this object from the OLD relationship's `RelatedObjects` is
    /// named here (`detach`) rather than performed here: another disposition
    /// in the same plan (a delete cascading through the same relationship,
    /// or another patch cloning the same shared set) can name a strip on the
    /// exact same `(relationship, attribute)` slot, and only
    /// [`super::delete::resolve_deletes`] — called once, after every
    /// disposition has been resolved — accumulates every such strip before
    /// rendering the final list text and deciding whether the relationship's
    /// mandatory member set went empty.
    CopyOnWrite {
        new_records: Vec<(u32, String)>,
        /// `(relationship, RelatedObjects attribute index, this object)`.
        detach: (u32, usize, u32),
    },
    /// The value found is correct and its SET is unshared, but the leaf
    /// record itself is shared with at least one other set — an exporter
    /// deduplicating identical property/quantity values across sets that
    /// happen to agree, even though the containing set's own fan-out looks
    /// like exactly one owner (see [`leaf_is_shared`]). Editing it in place
    /// would silently change every other set that names it, so a new leaf
    /// is minted instead, and only this set's member-list slot is asked to
    /// repoint at it.
    ///
    /// The repoint is named here, not rendered, for the same reason a
    /// [`CopyOnWrite`](Self::CopyOnWrite)'s detach is: two properties of the
    /// SAME set patched by the same plan would otherwise each compute the
    /// member list from the untouched source and clobber the other's
    /// repoint. `resolve`'s list-edit accumulator applies every
    /// repoint on a given set's member-list slot together, once.
    LeafCopyOnWrite {
        new_records: Vec<(u32, String)>,
        /// `(set, member-list attribute index, old leaf, new leaf)`.
        replace: (u32, usize, u32, u32),
    },
}

/// The text an in-place edit writes into a value slot. See
/// `props_synth::build_value_record` for why a quantity's value is bare.
fn in_place_value(write: &PropWrite) -> String {
    match write.kind {
        PsetKind::Property => format!("{}({})", write.measure_type, crate::step_log::canonical_literal(&write.measure_type, &write.literal)),
        PsetKind::Quantity => crate::step_log::canonical_literal(&write.measure_type, &write.literal),
    }
}

/// Refuse replacing value record `old` with a copy of another kind: an
/// enumerated, list or bounded value is not rewritten as a single value, as
/// an in-place edit refuses too.
fn other_kind(index: &FileIndex, write: &PropWrite, old: u32) -> Result<(), String> {
    let (Some(old_type), Ok(new_type)) = (index.type_of(old), props_synth::value_entity(write)) else { return Ok(()) };
    if old_type == new_type {
        Ok(())
    } else {
        Err(format!("existing value #{old} is {old_type}, which this write cannot replace with {new_type}"))
    }
}

/// `write`, carrying the unit of the value record it replaces when the caller
/// named none: a copy keeps the unit the original had, as an in-place edit
/// keeps its slot. Only from a value of the same measure (the same quantity entity, or
/// a property of the same measure type), so a length never takes an area's
/// unit.
fn keeping_old_unit(index: &FileIndex, schema: &str, write: &PropWrite, old: Option<u32>) -> PropWrite {
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
fn type_owned_member(index: &FileIndex, schema: &str, object_id: u32, write: &PropWrite) -> Option<u32> {
    let (_, type_id) = type_rel(index, schema, object_id)?;
    let type_psets = list_attr(index, schema, type_id, &index.type_of(type_id)?, "HasPropertySets")?;
    let (_, _, members) = find_set(index, schema, type_psets.iter(), write.kind, &write.pset)?;
    find_member(index, schema, &members, &write.prop)
}

/// The slot edits that overwrite an existing, unshared value record: its
/// value, and its unit when the caller named one.
/// Refused when the record has no such value slot (an enumerated, list or
/// bounded property value), rather than reporting a write that changed
/// nothing.
fn in_place_edits(index: &FileIndex, schema: &str, member_id: u32, write: &PropWrite) -> Result<Vec<(u32, usize, String)>, String> {
    let value_type = index.type_of(member_id).unwrap_or_default();
    if write.kind == PsetKind::Quantity {
        let wanted = props_synth::value_entity(write)?;
        if wanted != value_type {
            return Err(format!("existing quantity #{member_id} is {value_type}, but the write's measure makes it {wanted}"));
        }
    }
    let value_slot = match write.kind {
        PsetKind::Property => "NominalValue",
        PsetKind::Quantity => props_synth::value_slot_name(&value_type),
    };
    let i = attribute_index(schema, &value_type, value_slot)
        .ok_or_else(|| format!("existing value #{member_id} is {value_type}, which has no {value_slot} to write"))?;
    let mut edits = vec![(member_id, i, in_place_value(write))];
    if let Some(unit) = &write.unit {
        if let Some(i) = attribute_index(schema, &value_type, "Unit") {
            edits.push((member_id, i, unit.clone()));
        }
    }
    Ok(edits)
}

/// What resolving the writes to one set produced: the outcomes to apply,
/// and each write refused, with its reason.
#[derive(Debug, Default)]
pub(crate) struct SetWrites<'w> {
    pub(crate) outcomes: Vec<PropOutcome>,
    pub(crate) refused: Vec<(&'w PropWrite, String)>,
}

/// Resolve one [`PropWrite`] against `object_id`.
#[cfg(test)]
pub(crate) fn resolve_prop_write(
    index: &FileIndex,
    schema: &str,
    object_id: u32,
    write: &PropWrite,
    ids: &mut IdAllocator,
    owner_history: Option<u32>,
) -> Result<PropOutcome, String> {
    let mut result = resolve_set_writes(index, schema, object_id, &[write], ids, owner_history);
    match result.refused.pop() {
        Some((_, reason)) => Err(reason),
        None => Ok(result.outcomes.pop().expect("one write resolves to one outcome")),
    }
}

/// Resolve every write one patch makes to one set (same `pset`, `kind` and
/// `scope`) against `object_id` together, so the set is cloned, folded into
/// or created once with all of them, rather than once per write with each
/// result missing the others. A later write to the same property wins.
pub(crate) fn resolve_set_writes<'w>(
    index: &FileIndex,
    schema: &str,
    object_id: u32,
    writes: &[&'w PropWrite],
    ids: &mut IdAllocator,
    owner_history: Option<u32>,
) -> SetWrites<'w> {
    let mut result = SetWrites::default();
    // Last write per property, in the order the properties were first named.
    let mut group: Vec<&'w PropWrite> = Vec::new();
    for &write in writes {
        match group.iter_mut().find(|w| w.prop == write.prop) {
            Some(slot) => *slot = write,
            None => group.push(write),
        }
    }
    group.retain(|&write| match props_synth::check_value(schema, write) {
        Ok(_) => true,
        Err(reason) => {
            result.refused.push((write, reason));
            false
        }
    });
    let Some(&first) = group.first() else { return result };
    let refuse_all = |result: &mut SetWrites<'w>, reason: &str| {
        result.refused.extend(group.iter().map(|&w| (w, reason.to_string())));
    };
    let (container_type, member_attr) = container_names(first.kind);

    // 1. Occurrence-owned sets this object is directly related to. Only for
    // PropScope::Occurrence: a Type-scoped write must never even LOOK at an
    // occurrence override, or it would find one before ever reaching the
    // type's own set below.
    if matches!(first.scope, PropScope::Occurrence) {
        let rels = occurrence_rels(index, schema, object_id);
        let occurrence_psets: Vec<u32> = rels
            .iter()
            .filter_map(|&rel| scalar_attr(index, schema, rel, "IFCRELDEFINESBYPROPERTIES", "RelatingPropertyDefinition"))
            .collect();
        if let Some((pset_id, member_idx, members)) = find_set(index, schema, occurrence_psets.iter(), first.kind, &first.pset) {
            let owning_rel = rels
                .iter()
                .copied()
                .find(|&rel| scalar_attr(index, schema, rel, "IFCRELDEFINESBYPROPERTIES", "RelatingPropertyDefinition") == Some(pset_id));
            let rel_fanout = owning_rel
                .and_then(|rel| list_attr(index, schema, rel, "IFCRELDEFINESBYPROPERTIES", "RelatedObjects"))
                .map(|v| v.len())
                .unwrap_or(1);
            // A set a type also lists in HasPropertySets is the type's too:
            // editing it in place would change every occurrence of the type.
            let shared = rel_fanout > 1 || pset_owners(index, schema, pset_id).len() > 1;
            if !shared {
                write_unshared_set(index, schema, object_id, &group, (pset_id, member_idx, &members), ids, &mut result);
                return result;
            }

            // Shared: an occurrence-level set with more than one occurrence
            // (or pset) behind it. Appending a second same-named set here
            // would leave this object carrying two sets called e.g.
            // `Pset_WallCommon`, with no way for a reader to say which is
            // current. Clone the set instead: only the members that diverge
            // become new records, every other member id is reused (still
            // shared, still correct for whoever else uses this set), and
            // this object is detached from the OLD relationship rather than
            // left pointing at both.
            let Some(owning_rel) = owning_rel else {
                refuse_all(&mut result, "shared occurrence set has no owning IfcRelDefinesByProperties to detach from");
                return result;
            };
            let replaced: Vec<Option<u32>> = group.iter().map(|w| find_member(index, schema, &members, &w.prop)).collect();
            // A copy replaces a member only with one of its own kind, as an
            // in-place edit would refuse to rewrite an enumerated, list or
            // bounded value.
            let mismatch = group.iter().zip(&replaced).find_map(|(w, old)| other_kind(index, w, (*old)?).err());
            if let Some(reason) = mismatch {
                refuse_all(&mut result, &reason);
                return result;
            }
            let writes: Vec<PropWrite> = group.iter().zip(&replaced).map(|(w, old)| keeping_old_unit(index, schema, w, old.or_else(|| type_owned_member(index, schema, object_id, w)))).collect();
            let writes: Vec<&PropWrite> = writes.iter().collect();
            match props_synth::copy_on_write_occurrence_set(
                schema,
                container_type,
                member_attr,
                object_id,
                &writes,
                ids,
                owner_history,
                &members,
                &replaced,
                owning_rel,
            ) {
                Ok(outcome) => result.outcomes.push(outcome),
                Err(reason) => refuse_all(&mut result, &reason),
            }
            return result;
        }
    }

    // 2. Type-owned: only for PropScope::Type writes. An occurrence write
    // NEVER edits the type; it always appends an occurrence-only override
    // below.
    if matches!(first.scope, PropScope::Type) {
        let Some((_, type_id)) = type_rel(index, schema, object_id) else {
            refuse_all(&mut result, "object has no related type to patch");
            return result;
        };
        let type_psets = list_attr(index, schema, type_id, &index.type_of(type_id).unwrap_or_default(), "HasPropertySets").unwrap_or_default();
        match find_set(index, schema, type_psets.iter(), first.kind, &first.pset) {
            // A set another type lists, or that a relationship relates to
            // anything but this type, is not the type's alone: editing it
            // would reach those objects too.
            Some((pset_id, member_idx, members)) if pset_reaches_only(index, schema, pset_id, type_id) => {
                write_unshared_set(index, schema, object_id, &group, (pset_id, member_idx, &members), ids, &mut result);
            }
            Some(_) => refuse_all(&mut result, "type-scoped property write would need to touch a set shared with another type or object; refusing"),
            None => refuse_all(&mut result, "the related type has no set of this name; a type-scoped write never creates one"),
        }
        return result;
    }

    // 3. Nothing usable found: append a brand-new occurrence-only set
    // carrying these values, with its own IfcRelDefinesByProperties naming
    // only this object. Also the landing spot for a value the related TYPE
    // owns (never edited directly).
    let inherited: Vec<PropWrite> = group.iter().map(|w| keeping_old_unit(index, schema, w, type_owned_member(index, schema, object_id, w))).collect();
    let inherited: Vec<&PropWrite> = inherited.iter().collect();
    match props_synth::append_new_occurrence_set(schema, container_type, member_attr, object_id, &inherited, ids, owner_history) {
        Ok(outcome) => result.outcomes.push(outcome),
        Err(reason) => refuse_all(&mut result, &reason),
    }
    result
}

/// Every write of `group` into an existing set nothing else shares: an
/// existing value is edited in place (or, when another set also names that
/// value record, replaced by a fresh one), and a missing one is folded in.
fn write_unshared_set<'w>(
    index: &FileIndex,
    schema: &str,
    object_id: u32,
    group: &[&'w PropWrite],
    (pset_id, member_idx, members): (u32, usize, &[Option<u32>]),
    ids: &mut IdAllocator,
    result: &mut SetWrites<'w>,
) {
    for &write in group {
        let (container_type, _) = container_names(write.kind);
        let outcome = match find_member(index, schema, members, &write.prop) {
            Some(member_id) if leaf_is_shared(index, container_type, member_idx, member_id, pset_id) => {
                let write = keeping_old_unit(index, schema, write, Some(member_id));
                other_kind(index, &write, member_id).and_then(|()| props_synth::leaf_copy_on_write(schema, &write, ids, pset_id, member_idx, member_id))
            }
            Some(member_id) => in_place_edits(index, schema, member_id, write).map(PropOutcome::InPlace),
            None => {
                let inherited = match write.scope {
                    PropScope::Occurrence => keeping_old_unit(index, schema, write, type_owned_member(index, schema, object_id, write)),
                    PropScope::Type => write.clone(),
                };
                props_synth::fold_new_value(schema, &inherited, ids, pset_id, member_idx)
            }
        };
        match outcome {
            Ok(outcome) => result.outcomes.push(outcome),
            Err(reason) => result.refused.push((write, reason)),
        }
    }
}

#[cfg(test)]
#[path = "props_tests.rs"]
mod tests;
