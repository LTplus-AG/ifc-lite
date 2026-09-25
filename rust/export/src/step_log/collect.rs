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
    for &rel in pass.src.of_type("IFCRELDEFINESBYPROPERTIES") {
        if pass.is_deleted(rel) {
            continue;
        }
        let edited = pass.attribute_edits(rel).is_some();
        let (set, related) = if edited {
            match effective_relation(pass, rel) {
                Some(found) => found,
                None => continue,
            }
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

/// `effectiveRelation` for a relationship with queued named edits: its
/// `RelatedObjects` and `RelatingPropertyDefinition` as the export will write
/// them.
fn effective_relation(pass: &Pass<'_, '_>, rel: u32) -> Option<(Option<u32>, Vec<u32>)> {
    let (ty, attrs) = pass.src.entity(rel)?;
    let names = super::attrs::attr_names(&ty, pass.schema);
    let mut authored: HashMap<usize, Vec<u32>> = HashMap::new();
    for (name, value) in pass.attribute_edits(rel).unwrap_or(&[]) {
        if let Some(i) = names.iter().position(|n| n == name) {
            authored.insert(i, readers::authored_entity_refs(value));
        }
    }
    let related_slot = names.iter().position(|n| *n == "RelatedObjects")?;
    let set_slot = names.iter().position(|n| *n == "RelatingPropertyDefinition")?;
    let read = |slot: usize| match authored.get(&slot) {
        Some(ids) => ids.clone(),
        None => super::base::refs(attrs.get(slot)),
    };
    Some((read(set_slot).first().copied(), read(related_slot)))
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

/// `getTypeOwnedHasPropertySetIds`: the numeric members of slot 5.
fn type_owned_ids(pass: &Pass<'_, '_>, entity: u32) -> Vec<u32> {
    let Some((_, attrs)) = pass.src.entity(entity) else { return Vec::new() };
    match attrs.get(5) {
        Some(JsVal::Arr(items)) => items.iter().filter_map(|v| v.as_num().map(|n| n as u32)).collect(),
        _ => Vec::new(),
    }
}

/// `retainSharedAtoms`: a withheld member that a KEPT property set or
/// quantity set still names is written after all.
pub(crate) fn retain_shared_atoms(pass: &mut Pass<'_, '_>) {
    if pass.skip.is_empty() {
        return;
    }
    let mut keep = Vec::new();
    for ty in ["IFCPROPERTYSET", "IFCELEMENTQUANTITY"] {
        for &container in pass.src.of_type(ty) {
            if pass.skip.contains(&container) || pass.is_deleted(container) {
                continue;
            }
            if let Some(line) = pass.src.line(container) {
                keep.extend(readers::property_ids_in_set(&line));
            }
        }
    }
    for id in keep {
        pass.skip.remove(&id);
    }
}
