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

use ifc_lite_core::SchemaFamily;

use crate::step_ids::IdAllocator;

use super::attrs::attribute_index;
use super::index::FileIndex;
use super::props_lookup::{container_names, leaf_is_shared, list_attr, pset_owners, pset_reaches_only, set_members};
use super::props_synth;
use super::attribution::{Settles, Taken};
use super::props_target::{ResolvedWrite, WriteTarget};
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
fn in_place_value(family: Option<SchemaFamily>, write: &PropWrite) -> String {
    let literal = crate::step_log::canonical_literal(family, &write.measure_type, &write.literal);
    match write.kind {
        PsetKind::Property => format!("{}({literal})", write.measure_type),
        PsetKind::Quantity => literal.into_owned(),
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

/// The slot edits that overwrite an existing, unshared value record: its
/// value, and its unit when the caller named one.
/// Refused when the record has no such value slot (an enumerated, list or
/// bounded property value), rather than reporting a write that changed
/// nothing.
fn in_place_edits(target: &WriteTarget<'_>, member_id: u32, write: &PropWrite) -> Result<Vec<(u32, usize, String)>, String> {
    let (index, schema) = (target.index, target.schema);
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
    let mut edits = vec![(member_id, i, in_place_value(target.family, write))];
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
    /// The owner history a written set and relationship took, for the
    /// caller to commit.
    pub(crate) history: Option<Settles>,
}

impl SetWrites<'_> {
    /// A written set or clone, carrying the records of the history it took
    /// ahead of its own.
    fn push_with_history(&mut self, mut outcome: PropOutcome, taken: Option<Taken>) {
        if let Some(taken) = taken {
            if let PropOutcome::Append { new_records } | PropOutcome::CopyOnWrite { new_records, .. } = &mut outcome {
                new_records.splice(0..0, taken.records);
            }
            self.history = Some(taken.settles);
        }
        self.outcomes.push(outcome);
    }
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
    let target = WriteTarget::read(index, schema, object_id);
    let resolved = super::props_target::resolve_write(&target, write)?;
    let taken = |_: &mut IdAllocator| owner_history.map(Taken::existing);
    let mut result = resolve_set_writes(&target, &[resolved], ids, &taken);
    match result.refused.pop() {
        Some((_, reason)) => Err(reason),
        None => Ok(result.outcomes.pop().expect("one write resolves to one outcome")),
    }
}

/// Resolve every write one patch makes to one set (one resolved `set`, or
/// with none, one `pset`, `kind` and `scope`) against `target` together, so
/// the set is cloned, folded into or created once with all of them, rather
/// than once per write with each result missing the others. A later write
/// with the same [`ResolvedWrite::dedupe_key`] wins. `history` takes the
/// owner history a new set and relationship name, only when one is written;
/// the written set carries the records it brings, and
/// [`SetWrites::history`] what the caller commits.
pub(crate) fn resolve_set_writes<'w>(
    target: &WriteTarget<'_>,
    writes: &[ResolvedWrite<'w>],
    ids: &mut IdAllocator,
    history: &dyn Fn(&mut IdAllocator) -> Option<Taken>,
) -> SetWrites<'w> {
    let (index, schema, object_id) = (target.index, target.schema, target.object_id);
    let mut result = SetWrites::default();
    // Last write per record it reaches, in the order first reached.
    let mut group: Vec<ResolvedWrite<'w>> = Vec::new();
    for &write in writes {
        match group.iter_mut().find(|w| w.dedupe_key() == write.dedupe_key()) {
            Some(slot) => *slot = write,
            None => group.push(write),
        }
    }
    group.retain(|w| match props_synth::check_value(target.family, w.write) {
        Ok(_) => true,
        Err(reason) => {
            result.refused.push((w.write, reason));
            false
        }
    });
    let Some(first) = group.first().copied() else { return result };
    let refuse_all = |result: &mut SetWrites<'w>, reason: &str| {
        result.refused.extend(group.iter().map(|w| (w.write, reason.to_string())));
    };
    let (container_type, member_attr) = container_names(first.write.kind);
    let set = first.set.and_then(|set| Some((set, set_members(index, schema, set, first.write.kind)?)));

    match (first.write.scope, set) {
        // 1. A set this object owns. Edited in place unless it is shared.
        (PropScope::Occurrence, Some((pset_id, (member_idx, members)))) => {
            let owning_rel = target.sets.own.iter().find(|&&(_, set)| set == pset_id).map(|&(rel, _)| rel);
            let rel_fanout = owning_rel
                .and_then(|rel| list_attr(index, schema, rel, "IFCRELDEFINESBYPROPERTIES", "RelatedObjects"))
                .map(|v| v.len())
                .unwrap_or(1);
            // A set a type also lists in HasPropertySets is the type's too:
            // editing it in place would change every occurrence of the type.
            let shared = rel_fanout > 1 || pset_owners(index, schema, pset_id).len() > 1;
            if !shared {
                write_unshared_set(target, &group, (pset_id, member_idx), ids, &mut result);
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
            let replaced: Vec<Option<u32>> = group.iter().map(|w| w.record).collect();
            // A copy replaces a member only with one of its own kind, as an
            // in-place edit would refuse to rewrite an enumerated, list or
            // bounded value.
            let mismatch = group.iter().find_map(|w| other_kind(index, w.write, w.record?).err());
            if let Some(reason) = mismatch {
                refuse_all(&mut result, &reason);
                return result;
            }
            let writes: Vec<_> = group.iter().map(|w| w.for_new_record(target)).collect();
            let writes: Vec<&PropWrite> = writes.iter().map(|w| &**w).collect();
            let taken = history(ids);
            let written = props_synth::copy_on_write_occurrence_set(
                schema,
                container_type,
                member_attr,
                object_id,
                &writes,
                ids,
                taken.as_ref().map(|t| t.settles.id),
                &members,
                &replaced,
                owning_rel,
            );
            match written {
                Ok(outcome) => result.push_with_history(outcome, taken),
                Err(reason) => refuse_all(&mut result, &reason),
            }
        }
        // 2. A set the related type lists: only for PropScope::Type writes.
        // An occurrence write NEVER edits the type; it appends an
        // occurrence-only override below.
        (PropScope::Type, set) => {
            let Some(type_id) = target.sets.type_id else {
                refuse_all(&mut result, "object has no related type to patch");
                return result;
            };
            match set {
                // A set another type lists, or that a relationship relates to
                // anything but this type, is not the type's alone: editing it
                // would reach those objects too.
                Some((pset_id, (member_idx, _))) if pset_reaches_only(index, schema, pset_id, type_id) => {
                    write_unshared_set(target, &group, (pset_id, member_idx), ids, &mut result);
                }
                Some(_) => refuse_all(&mut result, "type-scoped property write would need to touch a set shared with another type or object; refusing"),
                None => refuse_all(&mut result, "the related type has no set of this name; a type-scoped write never creates one"),
            }
        }
        // 3. No set of this name on the object: append a brand-new
        // occurrence-only set carrying these values, with its own
        // IfcRelDefinesByProperties naming only this object. Also the
        // landing spot for a value the related TYPE owns (never edited
        // directly).
        (PropScope::Occurrence, None) => {
            let inherited: Vec<_> = group.iter().map(|w| w.for_new_record(target)).collect();
            let inherited: Vec<&PropWrite> = inherited.iter().map(|w| &**w).collect();
            let taken = history(ids);
            match props_synth::append_new_occurrence_set(schema, container_type, member_attr, object_id, &inherited, ids, taken.as_ref().map(|t| t.settles.id)) {
                Ok(outcome) => result.push_with_history(outcome, taken),
                Err(reason) => refuse_all(&mut result, &reason),
            }
        }
    }
    result
}

/// Every write of `group` into an existing set nothing else shares: an
/// existing value is edited in place (or, when another set also names that
/// value record, replaced by a fresh one), and a missing one is folded in.
fn write_unshared_set<'w>(
    target: &WriteTarget<'_>,
    group: &[ResolvedWrite<'w>],
    (pset_id, member_idx): (u32, usize),
    ids: &mut IdAllocator,
    result: &mut SetWrites<'w>,
) {
    let (index, schema) = (target.index, target.schema);
    for resolved in group {
        let write = resolved.write;
        let (container_type, _) = container_names(write.kind);
        let outcome = match resolved.record {
            Some(member_id) if leaf_is_shared(index, container_type, member_idx, member_id, pset_id) => {
                let write = resolved.for_new_record(target);
                other_kind(index, &write, member_id).and_then(|()| props_synth::leaf_copy_on_write(schema, &write, ids, pset_id, member_idx, member_id))
            }
            Some(member_id) => in_place_edits(target, member_id, write).map(PropOutcome::InPlace),
            None => props_synth::fold_new_value(schema, &resolved.for_new_record(target), ids, pset_id, member_idx),
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
