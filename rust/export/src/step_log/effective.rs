// SPDX-License-Identifier: MPL-2.0
//! The merged view of an entity's sets (`MutablePropertyView.getForEntity` /
//! `getQuantitiesForEntity`): the base sets with the overlay applied, then the
//! session's new sets whose names the base did not use.
//!
//! Two base sets can share a name (a type set and an occurrence set). A
//! mutation key has no per-instance identity, so `same-name-set-claims.ts`
//! decides which instance an edit lands on: the FIRST instance that carries
//! the member claims it, and a brand-new member lands on the first instance of
//! the set name.

use std::collections::{HashMap, HashSet};

use super::base::{pvt, qty, BaseSets, PSet, Prop, QSet, Quantity};
use super::overlay::{Op, Overlay};

/// `computeSetClaims`: (set name, member name) -> claiming instance, and set
/// name -> first instance, as indices into the base list.
fn claims<'n>(sets: impl Iterator<Item = (&'n str, Vec<&'n str>)>) -> (HashMap<(String, String), usize>, HashMap<String, usize>) {
    let mut member = HashMap::new();
    let mut first = HashMap::new();
    for (i, (set, members)) in sets.enumerate() {
        first.entry(set.to_string()).or_insert(i);
        for m in members {
            member.entry((set.to_string(), m.to_string())).or_insert(i);
        }
    }
    (member, first)
}

pub(crate) fn psets_for(o: &Overlay, base: &mut BaseSets<'_, '_>, e: u32) -> Vec<PSet> {
    let base_sets = base.psets(e);
    let (member_claim, first) =
        claims(base_sets.iter().map(|s| (s.name.as_str(), s.properties.iter().map(|p| p.name.as_str()).collect())));
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for (i, set) in base_sets.iter().enumerate() {
        if o.deleted_psets.contains(&(e, set.name.clone())) {
            continue;
        }
        seen.insert(set.name.clone());
        let mut members: Vec<Prop> = Vec::new();
        for p in &set.properties {
            if member_claim.get(&(set.name.clone(), p.name.clone())) != Some(&i) {
                members.push(p.clone());
                continue;
            }
            match o.props.get(&(e, set.name.clone(), p.name.clone())) {
                Some(m) if m.op == Op::Delete => {}
                Some(m) => members.push(Prop {
                    name: p.name.clone(),
                    ty: m.value_type.unwrap_or(p.ty),
                    value: m.value.clone(),
                    unit: m.unit.clone().or_else(|| p.unit.clone()),
                    data_type: p.data_type.clone(),
                }),
                None => members.push(p.clone()),
            }
        }
        if first.get(&set.name) == Some(&i) {
            for (s, name) in o.prop_keys.get(&e).map(Vec::as_slice).unwrap_or(&[]) {
                if *s != set.name {
                    continue;
                }
                let Some(m) = o.props.get(&(e, s.clone(), name.clone())) else { continue };
                if m.op != Op::Set || member_claim.contains_key(&(set.name.clone(), name.clone())) {
                    continue;
                }
                if !members.iter().any(|x| x.name == *name) {
                    members.push(Prop {
                        name: name.clone(),
                        ty: m.value_type.unwrap_or(pvt::STRING),
                        value: m.value.clone(),
                        unit: m.unit.clone(),
                        data_type: None,
                    });
                }
            }
        }
        if !members.is_empty() {
            out.push(PSet { name: set.name.clone(), global_id: set.global_id.clone(), properties: members });
        }
    }
    for set in o.new_psets.get(&e).map(Vec::as_slice).unwrap_or(&[]) {
        if !seen.contains(&set.name) {
            out.push(set.clone());
        }
    }
    out
}

pub(crate) fn qsets_for(o: &Overlay, base: &mut BaseSets<'_, '_>, e: u32) -> Vec<QSet> {
    let base_sets = base.qsets(e);
    let (member_claim, first) =
        claims(base_sets.iter().map(|s| (s.name.as_str(), s.quantities.iter().map(|q| q.name.as_str()).collect())));
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for (i, set) in base_sets.iter().enumerate() {
        if o.deleted_qsets.contains(&(e, set.name.clone())) {
            continue;
        }
        seen.insert(set.name.clone());
        let mut members: Vec<Quantity> = Vec::new();
        for q in &set.quantities {
            if member_claim.get(&(set.name.clone(), q.name.clone())) != Some(&i) {
                members.push(q.clone());
                continue;
            }
            match o.quants.get(&(e, set.name.clone(), q.name.clone())) {
                Some(m) if m.op == Op::Delete => {}
                Some(m) => members.push(Quantity {
                    name: q.name.clone(),
                    ty: m.quantity_type.unwrap_or(q.ty),
                    value: m.value.unwrap_or(q.value),
                }),
                None => members.push(q.clone()),
            }
        }
        if first.get(&set.name) == Some(&i) {
            for (s, name) in o.quant_keys.get(&e).map(Vec::as_slice).unwrap_or(&[]) {
                if *s != set.name {
                    continue;
                }
                let Some(m) = o.quants.get(&(e, s.clone(), name.clone())) else { continue };
                if m.op != Op::Set || member_claim.contains_key(&(set.name.clone(), name.clone())) {
                    continue;
                }
                if !members.iter().any(|x| x.name == *name) {
                    members.push(Quantity {
                        name: name.clone(),
                        ty: m.quantity_type.unwrap_or(qty::COUNT),
                        value: m.value.unwrap_or(0.0),
                    });
                }
            }
        }
        if !members.is_empty() {
            out.push(QSet { name: set.name.clone(), quantities: members });
        }
    }
    for set in o.new_qsets.get(&e).map(Vec::as_slice).unwrap_or(&[]) {
        if !seen.contains(&set.name) {
            out.push(set.clone());
        }
    }
    out
}
