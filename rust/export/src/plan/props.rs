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
    container_names, find_member, find_set, leaf_is_shared, list_attr, occurrence_rels, scalar_attr, sharing_fanout, type_rel,
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
        PsetKind::Property => format!("{}({})", write.measure_type, write.literal),
        PsetKind::Quantity => write.literal.clone(),
    }
}

/// The slot edits that overwrite an existing, unshared value record: its
/// value, and its unit when the caller named one.
/// Refused when the record has no such value slot (an enumerated, list or
/// bounded property value), rather than reporting a write that changed
/// nothing.
fn in_place_edits(index: &FileIndex, schema: &str, member_id: u32, write: &PropWrite) -> Result<Vec<(u32, usize, String)>, String> {
    let value_type = index.type_of(member_id).unwrap_or_default();
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
    group.retain(|&write| match props_synth::value_entity(write) {
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
            let shared = rel_fanout > 1 || sharing_fanout(index, schema, pset_id, &["RelatingPropertyDefinition"]) > 1;
            if !shared {
                write_unshared_set(index, schema, &group, (pset_id, member_idx, &members), ids, &mut result);
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
            match props_synth::copy_on_write_occurrence_set(
                schema,
                container_type,
                member_attr,
                object_id,
                &group,
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
            Some((pset_id, member_idx, members)) if sharing_fanout(index, schema, pset_id, &["HasPropertySets"]) <= 1 => {
                write_unshared_set(index, schema, &group, (pset_id, member_idx, &members), ids, &mut result);
            }
            _ => refuse_all(&mut result, "type-scoped property write would need to touch a set shared by another type; refusing"),
        }
        return result;
    }

    // 3. Nothing usable found: append a brand-new occurrence-only set
    // carrying these values, with its own IfcRelDefinesByProperties naming
    // only this object. Also the landing spot for a value the related TYPE
    // owns (never edited directly).
    match props_synth::append_new_occurrence_set(schema, container_type, member_attr, object_id, &group, ids, owner_history) {
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
    group: &[&'w PropWrite],
    (pset_id, member_idx, members): (u32, usize, &[Option<u32>]),
    ids: &mut IdAllocator,
    result: &mut SetWrites<'w>,
) {
    for &write in group {
        let (container_type, _) = container_names(write.kind);
        let outcome = match find_member(index, schema, members, &write.prop) {
            Some(member_id) if leaf_is_shared(index, container_type, member_idx, member_id, pset_id) => {
                props_synth::leaf_copy_on_write(schema, write, ids, pset_id, member_idx, member_id)
            }
            Some(member_id) => in_place_edits(index, schema, member_id, write).map(PropOutcome::InPlace),
            None => props_synth::fold_new_value(schema, write, ids, pset_id, member_idx),
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
