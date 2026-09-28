// SPDX-License-Identifier: MPL-2.0
//! Bounded relationship scan for selected authored quantity products.

use std::collections::{BTreeMap, HashMap, HashSet};
use ifc_lite_core::{AttributeValue, EntityDecoder, EntityScanner, IfcType};
use super::{Diagnostics, ProductQuantities, MAX_REF_RECORD_BYTES, MAX_REL_MEMBERS, report_once};

pub(super) struct SourceRelationships {
    pub direct: HashMap<u32, Vec<u32>>,
    pub typed: HashMap<u32, u32>,
}

fn property_definition_refs(value: &AttributeValue) -> Result<Vec<u32>, &'static str> {
    if let Some(id) = value.as_entity_ref() { return Ok(vec![id]); }
    let Some(items) = value.as_list() else { return Err("malformed RelatingPropertyDefinition"); };
    // The core decoder represents a STEP typed value as [type name, args...].
    // IFC4's IfcPropertySetDefinitionSet has exactly one SET argument.
    let refs = if matches!(items.first().and_then(AttributeValue::as_string),
        Some("IFCPROPERTYSETDEFINITIONSET")) {
        if items.len() != 2 { return Err("malformed RelatingPropertyDefinition"); }
        items[1].as_list().ok_or("malformed RelatingPropertyDefinition")?
    } else { items };
    if refs.is_empty() || refs.len() > MAX_REL_MEMBERS {
        return Err("RelatingPropertyDefinition exceeds work budget or is empty");
    }
    let mut ids = Vec::with_capacity(refs.len());
    for item in refs {
        ids.push(item.as_entity_ref().ok_or("malformed RelatingPropertyDefinition")?);
    }
    Ok(ids)
}

pub(super) fn collect_relationships(
    content: &[u8], decoder: &mut EntityDecoder,
    products: &BTreeMap<u32, ProductQuantities>, link_budget: usize,
    diagnostics: &mut Diagnostics,
) -> SourceRelationships {
    let mut direct: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut typed: HashMap<u32, u32> = HashMap::new();
    let mut conflicting_types = HashSet::new();
    let mut remaining_links = link_budget;
    let mut scan = EntityScanner::new(content);
    while let Some((id, name, start, end)) = scan.next_entity() {
        if !ifc_lite_core::keyword_eq(name, "IFCRELDEFINESBYPROPERTIES") &&
           !ifc_lite_core::keyword_eq(name, "IFCRELDEFINESBYTYPE") { continue; }
        if remaining_links == 0 {
            report_once(diagnostics, "quantity relationship links exceed work budget");
            continue;
        }
        if end.saturating_sub(start) > MAX_REF_RECORD_BYTES {
            diagnostics.push(format!("relationship #{id}: record exceeds work budget"));
            continue;
        }
        let rel = match decoder.decode_at_uncached(start, end) {
            Ok(rel) => rel,
            Err(_) => {
                diagnostics.push(format!("relationship #{id}: cannot decode"));
                continue;
            }
        };
        let targets = if rel.ifc_type == IfcType::IfcRelDefinesByProperties {
            match rel.get(5).ok_or("missing RelatingPropertyDefinition")
                .and_then(property_definition_refs) {
                Ok(refs) => refs,
                Err(reason) => {
                    diagnostics.push(format!("relationship #{id}: {reason}"));
                    continue;
                }
            }
        } else {
            let Some(target_id) = rel.get_ref(5) else {
                diagnostics.push(format!("relationship #{id}: missing or invalid RelatingType"));
                continue;
            };
            vec![target_id]
        };
        let Some(members) = rel.get(4).and_then(|a| a.as_list()) else {
            diagnostics.push(format!("relationship #{id}: malformed RelatedObjects"));
            continue;
        };
        if members.is_empty() || members.len() > MAX_REL_MEMBERS {
            diagnostics.push(format!("relationship #{id}: RelatedObjects is empty or exceeds work budget"));
            continue;
        }
        let mut reported_invalid_member = false;
        for member in members {
            let Some(product_id) = member.as_entity_ref() else {
                if !reported_invalid_member {
                    diagnostics.push(format!("relationship #{id}: malformed RelatedObjects member"));
                    reported_invalid_member = true;
                }
                continue;
            };
            if !products.contains_key(&product_id) { continue; }
            let cost = if rel.ifc_type == IfcType::IfcRelDefinesByProperties { targets.len() } else { 1 };
            if cost > remaining_links {
                report_once(diagnostics, "expanded quantity links exceed work budget");
                break;
            }
            remaining_links -= cost;
            if rel.ifc_type == IfcType::IfcRelDefinesByProperties {
                direct.entry(product_id).or_default().extend_from_slice(&targets);
            } else {
                if conflicting_types.contains(&product_id) { continue; }
                match typed.get(&product_id) {
                    Some(&first) if first != targets[0] => {
                        typed.remove(&product_id);
                        conflicting_types.insert(product_id);
                        diagnostics.push(format!(
                            "product #{product_id}: conflicting IfcRelDefinesByType assignments"));
                    }
                    Some(_) => {}
                    None => { typed.insert(product_id, targets[0]); }
                }
            }
        }
    }
    SourceRelationships { direct, typed }
}
