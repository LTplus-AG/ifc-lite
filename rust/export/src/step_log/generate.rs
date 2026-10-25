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
use super::cow::SourceMembers;
use super::jsval::{to_step_real, JsVal};
use super::nominal::MeasureNumber;
use super::ledger::Kind;
use super::nominal::serialize_nominal_value;
use super::pass::Pass;
use super::readers;
use super::units::{find_length_unit_reference, normalize_map_unit_name};
use super::values::Unwritable;

/// A generated record: its id (for the converter) and its line.
type Line = (u32, String);

/// The generated property-set lines, and the ids of the sets written for a
/// type object's own names.
type PsetLines = (Vec<Line>, Vec<(String, u32)>);

/// `HAS_PROPERTY_SETS_SLOT`.
const HAS_PROPERTY_SETS_SLOT: usize = 5;

fn quantity_entity(ty: u8) -> (&'static str, &'static str) {
    match ty {
        qty::LENGTH => ("IFCQUANTITYLENGTH", "IfcLengthMeasure"),
        qty::AREA => ("IFCQUANTITYAREA", "IfcAreaMeasure"),
        qty::VOLUME => ("IFCQUANTITYVOLUME", "IfcVolumeMeasure"),
        qty::WEIGHT => ("IFCQUANTITYWEIGHT", "IfcMassMeasure"),
        qty::TIME => ("IFCQUANTITYTIME", "IfcTimeMeasure"),
        qty::NUMBER => ("IFCQUANTITYNUMBER", "IfcNumericMeasure"),
        _ => ("IFCQUANTITYCOUNT", "IfcCountMeasure"),
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
fn pset_lines(
    pass: &mut Pass<'_, '_>,
    host: u32,
    psets: &[PSet],
    type_owned: &[String],
    source_members: &SourceMembers,
) -> Result<PsetLines, Unwritable> {
    let mut lines = Vec::new();
    let mut owned_ids: Vec<(String, u32)> = Vec::new();
    let owner = pass.owner_history_token(host);
    for pset in psets {
        if pset.properties.is_empty() {
            continue;
        }
        let mut refs = Vec::new();
        let members = source_members.get(&pset.name);
        for prop in &pset.properties {
            // An unedited property keeps its source atom, and with it its IFC
            // class, when that atom is written (#5794).
            let reused = members.and_then(|m| m.get(&prop.name)).copied();
            if let Some(atom) = reused.filter(|&a| pass.will_be_emitted(a) && !pass.skip.contains(&a)) {
                refs.push(format!("#{atom}"));
                continue;
            }
            let id = pass.allocate()?;
            let value = serialize_nominal_value(super::values::step_log_family(pass.schema), &prop.value, prop.ty, prop.data_type.as_deref());
            let unit = unit_token(pass, prop.unit.as_deref());
            // A list value is an `IfcPropertyListValue`; `()` is `$` (#5794).
            let (entity, value) = match value.as_str() {
                "()" => ("IFCPROPERTYLISTVALUE", "$".to_string()),
                v if v.starts_with('(') => ("IFCPROPERTYLISTVALUE", value),
                _ => ("IFCPROPERTYSINGLEVALUE", value),
            };
            lines.push((id, format!("#{id}={entity}('{}',$,{value},{unit});", escape(&prop.name))));
            refs.push(format!("#{id}"));
        }
        let set_id = pass.allocate()?;
        let guid = global_id(pass, host, set_id);
        lines.push((
            set_id,
            format!("#{set_id}=IFCPROPERTYSET('{guid}',{owner},'{}',$,({}));", escape(&pset.name), refs.join(",")),
        ));
        if type_owned.contains(&pset.name) {
            match owned_ids.iter_mut().find(|(n, _)| *n == pset.name) {
                Some(entry) => entry.1 = set_id,
                None => owned_ids.push((pset.name.clone(), set_id)),
            }
        } else {
            let rel_id = pass.allocate()?;
            let guid = global_id(pass, host, rel_id);
            lines.push((rel_id, format!("#{rel_id}=IFCRELDEFINESBYPROPERTIES('{guid}',{owner},$,$,(#{host}),#{set_id});")));
        }
    }
    Ok((lines, owned_ids))
}

/// `generateQuantitySetEntities`. Written in the SOURCE schema's layout
/// (`Formula` only where the source schema declares it); the writer converts
/// them to the target with every other record (#7378, #7682).
fn qset_lines(pass: &mut Pass<'_, '_>, host: u32, qsets: &[QSet]) -> Result<Vec<Line>, Unwritable> {
    let mut lines = Vec::new();
    let owner = pass.owner_history_token(host);
    let family = super::values::step_log_family(pass.schema);
    for qset in qsets {
        let mut refs = Vec::new();
        for q in &qset.quantities {
            // The value of the quantity's measure, in the source schema's base
            // (`IfcCountMeasure` is INTEGER in IFC4X3). A value that does not
            // fit: an untouched source value is left a real, as it came; an
            // edit is refused alone, with where it was. A non-finite value is
            // refused by `to_step_real`, as every writer refuses it.
            let (entity, measure) = quantity_entity(q.ty);
            let number = match super::nominal::measure_number(family, measure, q.value) {
                Ok(number) => number,
                Err(reason) if q.value.is_finite() && pass.overlay.edits_quantity(host, &qset.name, &q.name) => {
                    pass.warnings.push(format!("#{host} {}.{}: {reason}; the edit is not written", qset.name, q.name));
                    continue;
                }
                Err(_) => MeasureNumber::Real,
            };
            let value = match number {
                MeasureNumber::Integer(i) => i.to_string(),
                MeasureNumber::Real => to_step_real(q.value)?,
            };
            let id = pass.allocate()?;
            // Formula was added in IFC4; the canonical schema registry also
            // drives the TypeScript writer (#7378).
            let formula = if ifc_lite_core::attribute_names_for_schema(pass.schema, entity)
                .unwrap_or_else(|| ifc_lite_core::IfcType::from_str(entity).attribute_names())
                .contains(&"Formula")
            {
                ",$"
            } else {
                ""
            };
            lines.push((id, format!("#{id}={entity}('{}',$,$,{value}{formula});", escape(&q.name))));
            refs.push(format!("#{id}"));
        }
        // `Quantities` is `SET [1:?]`: a set with nothing left is not written.
        if refs.is_empty() {
            continue;
        }
        let set_id = pass.allocate()?;
        let guid = global_id(pass, host, set_id);
        lines.push((
            set_id,
            format!("#{set_id}=IFCELEMENTQUANTITY('{guid}',{owner},'{}',$,$,({}));", escape(&qset.name), refs.join(",")),
        ));
        let rel_id = pass.allocate()?;
        let guid = global_id(pass, host, rel_id);
        lines.push((rel_id, format!("#{rel_id}=IFCRELDEFINESBYPROPERTIES('{guid}',{owner},$,$,(#{host}),#{set_id});")));
    }
    Ok(lines)
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
    for (host, psets, source_members) in &collected.new_psets {
        if !pass.will_be_emitted(*host) {
            continue;
        }
        let owned_names =
            pass.type_owned_names.iter().find(|(e, _)| e == host).map(|(_, n)| n.clone()).unwrap_or_default();
        let (lines, owned) = pset_lines(pass, *host, psets, &owned_names, source_members)?;
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
        let lines = qset_lines(pass, *host, qsets)?;
        if !lines.is_empty() {
            pass.ledger.record_emitted(*host, Kind::QuantitySet);
        }
        pass.new_entity_count += lines.len();
        pass.generated.extend(lines);
    }
    Ok(())
}
