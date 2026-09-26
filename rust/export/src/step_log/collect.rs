// SPDX-License-Identifier: MPL-2.0
//! The collection phase (`step-collection.ts`,
//! `step-property-set-collection.ts`, `step-property-set-index.ts`): which
//! sets to regenerate, which source records to withhold, which type objects
//! get their `HasPropertySets` repointed, and which hosts' attribute edits
//! may be counted.

use std::collections::{HashMap, HashSet};

use crate::generated::step_log_tables::TYPE_OBJECT_CLASSES;

use super::base::{BaseSets, PSet, QSet};
use super::effective::{psets_for, qsets_for};
use super::jsval::JsVal;
use super::ledger::Kind;
use super::pass::Pass;
use super::readers;
use super::record::effective_record;
use super::refs::{authored_refs, record_refs, Slot};

/// What the generation phase consumes.
#[derive(Default)]
pub(crate) struct Collected {
    pub(crate) new_psets: Vec<(u32, Vec<PSet>)>,
    pub(crate) new_qsets: Vec<(u32, Vec<QSet>)>,
}

/// `isTypeClass`.
pub(crate) fn is_type_class(upper: &str) -> bool {
    TYPE_OBJECT_CLASSES.binary_search(&upper).is_ok()
}

/// `(set name, entity)` groupings off the replayed history, entities and
/// names each in first-seen order.
fn groups(pass: &Pass<'_, '_>, quantity: bool) -> Vec<(u32, Vec<String>)> {
    let mut out: Vec<(u32, Vec<String>)> = Vec::new();
    let mut at: HashMap<u32, usize> = HashMap::new();
    for t in pass.overlay.history.iter().filter(|t| t.quantity == quantity) {
        let slot = *at.entry(t.entity).or_insert_with(|| {
            out.push((t.entity, Vec::new()));
            out.len() - 1
        });
        if !out[slot].1.contains(&t.set_name) {
            out[slot].1.push(t.set_name.clone());
        }
    }
    out
}

/// entity -> `(relationship, set)` pairs.
type RelsByEntity = HashMap<u32, Vec<(u32, u32)>>;

/// `buildRelDefinesByPropertiesIndex`: entity -> (rel, set) pairs, and each
/// rel's related entities.
fn rel_index(pass: &Pass<'_, '_>) -> (RelsByEntity, Vec<(u32, Vec<u32>)>) {
    let mut by_entity: HashMap<u32, Vec<(u32, u32)>> = HashMap::new();
    let mut related_by_rel = Vec::new();
    for rel in pass.of_type("IFCRELDEFINESBYPROPERTIES") {
        let edited = pass.is_overlay_created(rel)
            || pass.attribute_edits(rel).is_some()
            || !pass.overlay.positionals(rel).is_empty();
        let (set, related) = if edited {
            let Some(record) = effective_record(pass, rel) else { continue };
            let (Some(related), Some(set)) = (record.named("RelatedObjects"), record.named("RelatingPropertyDefinition")) else {
                continue;
            };
            (record_refs(set).first().copied(), record_refs(related))
        } else {
            let Some(line) = pass.src.line(rel) else { continue };
            (readers::related_property_set(&line), readers::related_entities(&line))
        };
        let Some(set) = set else { continue };
        for &entity in &related {
            by_entity.entry(entity).or_default().push((rel, set));
        }
        related_by_rel.push((rel, related));
    }
    (by_entity, related_by_rel)
}

/// Withhold a source set and its members; `retain_shared_atoms` gives back
/// any member another kept set still names.
fn skip_set(pass: &mut Pass<'_, '_>, rel: u32, set: u32) {
    pass.skip.insert(rel);
    pass.skip.insert(set);
    if let Some(line) = pass.src.line(set) {
        for member in readers::property_ids_in_set(&line) {
            pass.skip.insert(member);
        }
    }
}

pub(crate) fn collect(pass: &mut Pass<'_, '_>, base: &mut BaseSets<'_, '_>) -> Collected {
    let mut out = Collected::default();
    let attributes: Vec<(u32, Vec<(String, String)>)> =
        pass.overlay.attribute_order.iter().map(|e| (*e, pass.overlay.attributes[e].clone())).collect();
    for (entity, edits) in &attributes {
        pass.queue_attributes(*entity, edits);
    }

    let prop_groups = groups(pass, false);
    let quant_groups = groups(pass, true);
    let (rels, related_by_rel) = rel_index(pass);
    for (rel, related) in related_by_rel {
        if !related.is_empty() && related.iter().all(|&id| pass.is_deleted(id)) {
            pass.skip.insert(rel);
        }
    }

    for (entity, names) in prop_groups {
        if pass.is_deleted(entity) {
            continue;
        }
        if !pass.is_overlay_created(entity) && pass.has_emittable_host_bytes(entity) {
            pass.ledger.nominate(entity, Kind::PropertySet);
        }
        let relevant: Vec<PSet> =
            psets_for(&pass.overlay, base, entity).into_iter().filter(|s| names.contains(&s.name)).collect();
        if !relevant.is_empty() {
            out.new_psets.push((entity, relevant));
        }
        let mut rel_defined: HashSet<String> = HashSet::new();
        for &(rel, set) in rels.get(&entity).map(Vec::as_slice).unwrap_or(&[]) {
            let name = pass.src.line(set).and_then(|l| readers::property_set_name(&l));
            let Some(name) = name.filter(|n| !n.is_empty()) else { continue };
            rel_defined.insert(name.clone());
            if names.contains(&name) {
                skip_set(pass, rel, set);
                pass.ledger.record_withheld(entity, Kind::PropertySet);
            }
        }
        if pass.type_of(entity).is_some_and(|t| is_type_class(&t)) {
            let owned = type_owned_ids(pass, entity);
            let mut affected: Vec<String> = Vec::new();
            for &set in &owned {
                let name = pass.src.line(set).and_then(|l| readers::property_set_name(&l));
                let Some(name) = name.filter(|n| !n.is_empty()) else { continue };
                if !names.contains(&name) {
                    continue;
                }
                if !affected.contains(&name) {
                    affected.push(name);
                }
                pass.skip.insert(set);
                if let Some(line) = pass.src.line(set) {
                    pass.skip.extend(readers::property_ids_in_set(&line));
                }
            }
            for name in &names {
                if !rel_defined.contains(name) && !affected.contains(name) {
                    affected.push(name.clone());
                }
            }
            if !affected.is_empty() {
                pass.type_owned_names.push((entity, affected));
                pass.type_owned_ids.insert(entity, owned);
                pass.rewritten.insert(entity);
            }
        }
    }

    for (entity, names) in quant_groups {
        if pass.is_deleted(entity) {
            continue;
        }
        if !pass.is_overlay_created(entity) && pass.has_emittable_host_bytes(entity) {
            pass.ledger.nominate(entity, Kind::QuantitySet);
        }
        let relevant: Vec<QSet> =
            qsets_for(&pass.overlay, base, entity).into_iter().filter(|s| names.contains(&s.name)).collect();
        let regenerated: HashSet<String> = relevant.iter().map(|s| s.name.clone()).collect();
        if !relevant.is_empty() {
            out.new_qsets.push((entity, relevant));
        }
        for &(rel, set) in rels.get(&entity).map(Vec::as_slice).unwrap_or(&[]) {
            let Some(name) = pass.src.line(set).and_then(|l| readers::element_quantity_name(&l)) else { continue };
            let deleted = pass.overlay.deleted_qsets.contains(&(entity, name.clone()));
            if !name.is_empty() && (regenerated.contains(&name) || deleted) {
                skip_set(pass, rel, set);
                pass.ledger.record_withheld(entity, Kind::QuantitySet);
            }
        }
    }

    for (entity, _) in &attributes {
        if pass.is_overlay_created(*entity) || !pass.has_emittable_host_bytes(*entity) {
            continue;
        }
        pass.nominees.attribute.insert(*entity);
    }
    out
}

/// `getTypeOwnedHasPropertySetIds`: the numeric members of slot 5, or a
/// created type object's authored (and positionally overridden) slot 5.
fn type_owned_ids(pass: &Pass<'_, '_>, entity: u32) -> Vec<u32> {
    if let Some(created) = pass.overlay.created(entity) {
        let authored = created.attributes.get(5).cloned().unwrap_or(serde_json::Value::Null);
        return authored_refs(&pass.overlay_slot(entity, 5, authored));
    }
    let Some((_, attrs)) = pass.src.entity(entity) else { return Vec::new() };
    match attrs.get(5) {
        Some(JsVal::Arr(items)) => items.iter().filter_map(|v| v.as_num().map(|n| n as u32)).collect(),
        _ => Vec::new(),
    }
}

/// The members a KEPT container names, as `retainSharedAtoms`' `memberIds`
/// reads them: a created container's effective record, a source container's
/// positional or named override of its member slot, else its own line.
fn member_ids(pass: &Pass<'_, '_>, container: u32, ty: &str) -> Vec<u32> {
    let (name, slot) = if ty == "IFCPROPERTYSET" { ("HasProperties", 4) } else { ("Quantities", 5) };
    if pass.is_overlay_created(container) {
        let Some(record) = effective_record(pass, container) else { return Vec::new() };
        return match record.named(name) {
            Some(Slot::Authored(v)) => authored_refs(v),
            _ => Vec::new(),
        };
    }
    if let Some((_, v)) = pass.overlay.positionals(container).iter().find(|(i, _)| *i == slot) {
        return authored_refs(v);
    }
    if let Some((_, v)) = pass.attribute_edits(container).unwrap_or(&[]).iter().rev().find(|(n, _)| n == name) {
        return readers::authored_entity_refs(v);
    }
    if pass.src.type_of(container).as_deref() != Some(ty) {
        return Vec::new();
    }
    pass.src.line(container).map(|l| readers::property_ids_in_set(&l)).unwrap_or_default()
}

/// `retainSharedAtoms`: a withheld member that a KEPT property set or
/// quantity set still names is written after all.
pub(crate) fn retain_shared_atoms(pass: &mut Pass<'_, '_>) {
    if pass.skip.is_empty() {
        return;
    }
    let mut keep = Vec::new();
    for ty in ["IFCPROPERTYSET", "IFCELEMENTQUANTITY"] {
        for container in pass.of_type(ty) {
            if pass.skip.contains(&container) {
                continue;
            }
            keep.extend(member_ids(pass, container, ty));
        }
    }
    for id in keep {
        pass.skip.remove(&id);
    }
}
