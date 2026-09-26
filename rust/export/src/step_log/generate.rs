// SPDX-License-Identifier: MPL-2.0
//! The generation phase (`step-property-set-generators.ts`,
//! `step-property-sets.ts`): the regenerated property and quantity sets, and
//! the type-object lines whose `HasPropertySets` is repointed at them.
//!
//! GlobalIds of the generated roots are the one place the two writers differ
//! by design: the TypeScript side draws them from a random source unless the
//! caller seeds one, and a native host has no such source to share. They are
//! minted here from the host and the new record's id with
//! [`crate::deterministic_global_id`], so a re-export is byte-reproducible.

use std::collections::HashSet;

use crate::deterministic_global_id;
use crate::step_text::escape;

use super::base::{qty, PSet, QSet};
use super::collect::Collected;
use super::jsval::{to_step_real, JsVal};
use super::ledger::Kind;
use super::nominal::serialize_nominal_value;
use super::pass::Pass;
use super::readers;
use super::units::{find_length_unit_reference, normalize_map_unit_name};
use super::values::Unwritable;

/// `HAS_PROPERTY_SETS_SLOT`.
const HAS_PROPERTY_SETS_SLOT: usize = 5;

fn quantity_entity(ty: u8) -> &'static str {
    match ty {
        qty::LENGTH => "IFCQUANTITYLENGTH",
        qty::AREA => "IFCQUANTITYAREA",
        qty::VOLUME => "IFCQUANTITYVOLUME",
        qty::WEIGHT => "IFCQUANTITYWEIGHT",
        qty::TIME => "IFCQUANTITYTIME",
        qty::NUMBER => "IFCQUANTITYNUMBER",
        _ => "IFCQUANTITYCOUNT",
    }
}

/// A GlobalId for a record this export generates for `host`.
fn global_id(pass: &Pass<'_, '_>, host: u32, id: u32) -> String {
    let host_guid = pass
        .src
        .entity(host)
        .and_then(|(_, attrs)| attrs.first().and_then(JsVal::as_str).map(str::to_string))
        .unwrap_or_else(|| format!("#{host}"));
    deterministic_global_id(&format!("ifc-lite/step-log/{host_guid}/{id}"))
}

/// `findUnitId`.
fn unit_token(pass: &Pass<'_, '_>, unit: Option<&str>) -> String {
    let Some(unit) = unit.filter(|u| !u.is_empty()) else { return "$".to_string() };
    let preferred = normalize_map_unit_name(unit);
    find_length_unit_reference(&preferred, pass.src, &|id| pass.is_deleted(id))
        .map_or_else(|| "$".to_string(), |id| format!("#{id}"))
}

/// `generatePropertySetEntities`: the lines, and the ids of the sets written
/// for a type object's own (`HasPropertySets`) names.
fn pset_lines(pass: &mut Pass<'_, '_>, host: u32, psets: &[PSet], type_owned: &[String]) -> (Vec<String>, Vec<(String, u32)>) {
    let mut lines = Vec::new();
    let mut owned_ids: Vec<(String, u32)> = Vec::new();
    let owner = pass.owner_history_token(host);
    for pset in psets {
        if pset.properties.is_empty() {
            continue;
        }
        let mut refs = Vec::new();
        for prop in &pset.properties {
            let id = pass.allocate();
            let value = serialize_nominal_value(&prop.value, prop.ty, prop.data_type.as_deref());
            let unit = unit_token(pass, prop.unit.as_deref());
            lines.push(format!("#{id}=IFCPROPERTYSINGLEVALUE('{}',$,{value},{unit});", escape(&prop.name)));
            refs.push(format!("#{id}"));
        }
        let set_id = pass.allocate();
        let guid = global_id(pass, host, set_id);
        lines.push(format!(
            "#{set_id}=IFCPROPERTYSET('{guid}',{owner},'{}',$,({}));",
            escape(&pset.name),
            refs.join(",")
        ));
        if type_owned.contains(&pset.name) {
            match owned_ids.iter_mut().find(|(n, _)| *n == pset.name) {
                Some(entry) => entry.1 = set_id,
                None => owned_ids.push((pset.name.clone(), set_id)),
            }
        } else {
            let rel_id = pass.allocate();
            let guid = global_id(pass, host, rel_id);
            lines.push(format!("#{rel_id}=IFCRELDEFINESBYPROPERTIES('{guid}',{owner},$,$,(#{host}),#{set_id});"));
        }
    }
    (lines, owned_ids)
}

/// `generateQuantitySetEntities`.
fn qset_lines(pass: &mut Pass<'_, '_>, host: u32, qsets: &[QSet]) -> Vec<String> {
    let mut lines = Vec::new();
    let owner = pass.owner_history_token(host);
    for qset in qsets {
        if qset.quantities.is_empty() {
            continue;
        }
        let mut refs = Vec::new();
        for q in &qset.quantities {
            let id = pass.allocate();
            lines.push(format!(
                "#{id}={}('{}',$,$,{},$);",
                quantity_entity(q.ty),
                escape(&q.name),
                to_step_real(q.value)
            ));
            refs.push(format!("#{id}"));
        }
        let set_id = pass.allocate();
        let guid = global_id(pass, host, set_id);
        lines.push(format!(
            "#{set_id}=IFCELEMENTQUANTITY('{guid}',{owner},'{}',$,$,({}));",
            escape(&qset.name),
            refs.join(",")
        ));
        let rel_id = pass.allocate();
        let guid = global_id(pass, host, rel_id);
        lines.push(format!("#{rel_id}=IFCRELDEFINESBYPROPERTIES('{guid}',{owner},$,$,(#{host}),#{set_id});"));
    }
    lines
}

/// `resolveTypeOwnedPsetIds`.
fn resolve_owned(pass: &Pass<'_, '_>, original: &[u32], affected: &[String], replacements: &[(String, u32)]) -> Vec<u32> {
    let mut resolved = Vec::new();
    let mut used: HashSet<&str> = HashSet::new();
    for &set in original {
        let name = pass.src.line(set).and_then(|l| readers::property_set_name(&l)).filter(|n| !n.is_empty());
        if let Some(name) = name.filter(|n| affected.contains(n)) {
            if let Some((n, id)) = replacements.iter().find(|(n, _)| *n == name) {
                resolved.push(*id);
                used.insert(n.as_str());
            }
            continue;
        }
        resolved.push(set);
    }
    for (name, id) in replacements {
        if !used.contains(name.as_str()) {
            resolved.push(*id);
        }
    }
    resolved
}

pub(crate) fn generate(pass: &mut Pass<'_, '_>, collected: Collected) -> Result<(), Unwritable> {
    let mut owned_by_host: Vec<(u32, Vec<(String, u32)>)> = Vec::new();
    for (host, psets) in &collected.new_psets {
        if !pass.will_be_emitted(*host) {
            continue;
        }
        let owned_names =
            pass.type_owned_names.iter().find(|(e, _)| e == host).map(|(_, n)| n.clone()).unwrap_or_default();
        let (lines, owned) = pset_lines(pass, *host, psets, &owned_names);
        if !lines.is_empty() {
            pass.ledger.record_emitted(*host, Kind::PropertySet);
        }
        pass.new_entity_count += lines.len();
        pass.generated.extend(lines);
        owned_by_host.push((*host, owned));
    }

    for (host, names) in pass.type_owned_names.clone() {
        if !pass.will_be_emitted(host) {
            continue;
        }
        let replacements = owned_by_host.iter().rev().find(|(h, _)| *h == host).map(|(_, r)| r.clone()).unwrap_or_default();
        let original = pass.type_owned_ids.get(&host).cloned().unwrap_or_default();
        let resolved = resolve_owned(pass, &original, &names, &replacements);
        if pass.is_overlay_created(host) {
            let value = if resolved.is_empty() {
                serde_json::Value::Null
            } else {
                serde_json::Value::Array(resolved.iter().map(|id| serde_json::Value::String(format!("#{id}"))).collect())
            };
            match pass.overlay_type_owned.iter_mut().find(|(e, _)| *e == host) {
                Some(entry) => entry.1 = value,
                None => pass.overlay_type_owned.push((host, value)),
            }
            continue;
        }
        let Some(source_line) = pass.src.line(host).map(|l| l.into_owned()) else {
            pass.warnings.push(format!(
                "Type object #{host}: no source bytes were available to rewrite, so its property-set change was not applied and no line was written for it."
            ));
            continue;
        };
        let (mutated, delivery) = pass.mutate_line(host, &source_line)?;
        let token = if resolved.is_empty() {
            "$".to_string()
        } else {
            format!("({})", resolved.iter().map(|id| format!("#{id}")).collect::<Vec<_>>().join(","))
        };
        let (line, repointed) = match super::lines::replace_argument(&mutated, HAS_PROPERTY_SETS_SLOT, &token) {
            Some(line) => (line, true),
            None => (mutated, false),
        };
        let changed = line != source_line;
        if !repointed {
            pass.warnings.push(format!(
                "Type object #{host}: its source line does not parse as a STEP record with a HasPropertySets slot (slot {HAS_PROPERTY_SETS_SLOT}), so its property-set change was not applied. The line was kept as it stands, carrying the session's other edits, rather than dropped — but any replacement property set this export generated for it is unreferenced. Repair the record in the source file and export again."
            ));
        }
        pass.rewritten_lines.push((host, line));
        if changed {
            if repointed {
                pass.ledger.record_emitted(host, Kind::PropertySet);
            }
            pass.ledger.record_line(host, &delivery);
            pass.nominees.nominate_delivered(&mut pass.ledger, host, &delivery);
        }
    }

    for (host, qsets) in &collected.new_qsets {
        if !pass.will_be_emitted(*host) {
            continue;
        }
        let lines = qset_lines(pass, *host, qsets);
        if !lines.is_empty() {
            pass.ledger.record_emitted(*host, Kind::QuantitySet);
        }
        pass.new_entity_count += lines.len();
        pass.generated.extend(lines);
    }
    Ok(())
}
