// SPDX-License-Identifier: MPL-2.0
//! Flat product/relationship inventory; geometry traversal stays canonical.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use ifc_lite_core::{build_entity_index, has_geometry_by_name, EntityDecoder, EntityScanner, IfcType};
use ifc_lite_core::slot;

pub(super) struct Inventory {
    pub products: BTreeSet<u32>,
    pub openings: BTreeMap<u32, Vec<(u32, u32)>>,
    pub opening_relationships_verified: bool,
    pub diagnostics: Vec<String>,
}

pub(super) fn inventory(content: &[u8], ids: Option<&HashSet<u32>>) -> Inventory {
    let mut decoder = EntityDecoder::with_index(content, build_entity_index(content));
    inventory_decoder(&mut decoder, ids)
}

pub(super) fn inventory_decoder(decoder: &mut EntityDecoder<'_>, ids: Option<&HashSet<u32>>) -> Inventory {
    let content = decoder.content;
    let mut result = Inventory { products: BTreeSet::new(), openings: BTreeMap::new(),
        opening_relationships_verified: true, diagnostics: Vec::new() };
    let mut scanner = EntityScanner::new(content);
    let mut visited = BTreeSet::new();
    while let Some((id, type_name, _start, _end)) = scanner.next_entity() {
        let relationship = type_name.eq_ignore_ascii_case("IFCRELVOIDSELEMENT");
        let product = has_geometry_by_name(type_name)
            && ids.is_none_or(|wanted| wanted.contains(&id));
        if (!relationship && !product) || !visited.insert(id) { continue; }
        match decoder.decode_by_id(id) {
            Ok(entity) if relationship => {
                match (entity.ref_at(slot::IfcRelVoidsElement::RELATING_BUILDING_ELEMENT),
                    entity.ref_at(slot::IfcRelVoidsElement::RELATED_OPENING_ELEMENT)) {
                    (Some(host), Some(opening)) if ids.is_none_or(|wanted| wanted.contains(&host)) => {
                        result.openings.entry(host).or_default().push((id, opening));
                    }
                    (Some(_), Some(_)) => {}
                    _ => {
                        result.opening_relationships_verified = false;
                        result.diagnostics.push(format!("IfcRelVoidsElement #{id} has invalid RelatingBuildingElement or RelatedOpeningElement"));
                    }
                }
            }
            Ok(entity) if entity.ifc_type.is_subtype_of(IfcType::IfcProduct) => {
                result.products.insert(id);
            }
            Ok(_) => {}
            Err(error) => {
                if relationship { result.opening_relationships_verified = false; }
                result.diagnostics.push(format!("authored inventory #{id}: {error}"));
            }
        }
    }
    for links in result.openings.values_mut() { links.sort_unstable(); }
    result
}
