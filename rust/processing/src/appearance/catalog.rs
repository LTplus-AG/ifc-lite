// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Domain scope metadata from the same effective snapshot used by the planner.
use super::source::Source;
use ifc_lite_core::{AttributeValue as A, IfcType};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppearanceCatalogRequest {
    pub schema: String,
    pub source_revision: String,
    pub product_ids: Vec<u32>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceCatalogProduct {
    pub product_id: u32,
    pub ifc_class: String,
    pub type_ids: Vec<u32>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceCatalogType {
    pub type_id: u32,
    pub ifc_class: String,
    /// Exact IFC EXPRESS attribute name on the wire, not a display-label alias.
    #[serde(rename = "Name")]
    pub name: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceCatalog {
    pub source_revision: String,
    pub products: Vec<AppearanceCatalogProduct>,
    pub types: Vec<AppearanceCatalogType>,
    /// Missing/deleted IDs and non-IfcProduct owners are explicitly ineligible.
    pub missing_product_ids: Vec<u32>,
}

/// Build class/type selectors without geometry or a TypeScript overlay policy.
/// Input must already contain effective host edits. All IDs are model-local.
/// A refusal returns no partial catalogue; caller validates sourceRevision.
pub fn catalog_appearance(bytes: &[u8], request: &AppearanceCatalogRequest) -> Result<AppearanceCatalog, String> {
    if request.schema != "IFC4" && request.schema != "IFC4X3" {
        return Err("Appearance catalog requires IFC4 or IFC4X3".into());
    }
    if request.product_ids.len() > 10_000 || request.product_ids.contains(&0) || request.source_revision.len() > 4096 {
        return Err("Appearance catalog request exceeds its owner/revision budget".into());
    }
    // Shared canonical parse and its 128MiB/200k-entity/8m-value bounds. No
    // geometry jobs, texture decode, or second source/overlay parser is added.
    let mut source = Source::new(bytes)?;
    let mut products = BTreeMap::<u32, (IfcType, BTreeSet<u32>)>::new();
    let mut missing = BTreeSet::new();
    for &id in &request.product_ids {
        match source.types.get(&id).copied() {
            Some(class) if class.is_subtype_of(IfcType::IfcProduct) => { products.entry(id).or_insert((class, BTreeSet::new())); }
            _ => { missing.insert(id); }
        }
    }
    let relation_ids: Vec<u32> = source.types.iter().filter_map(|(&id, class)|
        (*class == IfcType::IfcRelDefinesByType).then_some(id)).collect();
    let mut types = BTreeMap::new();
    let mut memberships = 0usize;
    let mut label_bytes = 0usize;
    for id in relation_ids {
        let relation = source.entity(id)?;
        let related = relation.get(4).and_then(A::as_list)
            .ok_or_else(|| format!("Invalid IfcRelDefinesByType #{id} RelatedObjects"))?;
        let mut owners = BTreeSet::new();
        for member in related {
            let owner = member.as_entity_ref().ok_or_else(|| format!("Invalid IfcRelDefinesByType #{id} member"))?;
            if products.contains_key(&owner) { owners.insert(owner); }
        }
        if owners.is_empty() { continue; }
        let type_id = relation.get_ref(5).ok_or_else(|| format!("Missing IfcRelDefinesByType #{id} RelatingType"))?;
        let class = source.types.get(&type_id).copied().filter(|class| class.is_subtype_of(IfcType::IfcTypeObject))
            .ok_or_else(|| format!("Invalid IfcRelDefinesByType #{id} RelatingType #{type_id}"))?;
        if let std::collections::btree_map::Entry::Vacant(entry) = types.entry(type_id) {
            let entity = source.entity(type_id)?;
            let name = match entity.get(2) {
                None | Some(A::Null) => None,
                Some(value) => Some(value.as_string().ok_or("Invalid IFC type Name")?),
            };
            label_bytes += name.map_or(0, str::len);
            if label_bytes > 4 * 1024 * 1024 { return Err("Appearance catalog type names exceed 4 MiB metadata budget".into()); }
            entry.insert(AppearanceCatalogType { type_id, ifc_class: class.name().into(), name: name.map(str::to_owned) });
        }
        for owner in owners {
            if products.get_mut(&owner).expect("owner was selected above").1.insert(type_id) {
                memberships += 1;
                if memberships > 200_000 { return Err("Appearance catalog exceeds 200000 type memberships".into()); }
            }
        }
    }
    Ok(AppearanceCatalog {
        source_revision: request.source_revision.clone(),
        products: products.into_iter().map(|(product_id, (class, ids))| AppearanceCatalogProduct {
            product_id, ifc_class: class.name().into(), type_ids: ids.into_iter().collect(),
        }).collect(),
        types: types.into_values().collect(), missing_product_ids: missing.into_iter().collect(),
    })
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;
