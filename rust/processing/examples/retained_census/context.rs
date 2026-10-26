// SPDX-License-Identifier: MPL-2.0
//! Existing source-only modification/appearance counts and type assignments.

use super::denominator;
use ifc_lite_core::{EntityDecoder, IfcType, SchemaVersion};
use std::collections::{BTreeMap, BTreeSet};

pub(super) struct Context {
    pub voids: BTreeMap<u32, usize>,
    pub layers: BTreeSet<u32>,
    pub layer_usages: BTreeMap<u32, usize>,
    pub type_assignments: BTreeMap<u32, Vec<u32>>,
    pub styles: BTreeMap<u32, bool>,
    pub palettes: BTreeSet<u32>,
    pub diagnostics: Vec<String>,
}

pub(super) fn collect(
    records: &[(u32, String)],
    decoder: &mut EntityDecoder,
    schema: SchemaVersion,
) -> Context {
    let mut voids = BTreeMap::<u32, usize>::new();
    let mut layers = BTreeSet::<u32>::new();
    let mut layer_usages = BTreeMap::<u32, usize>::new();
    let mut typed_products = Vec::<(u32, u32)>::new();
    let mut styles = BTreeMap::<u32, bool>::new();
    let mut palettes = BTreeSet::<u32>::new();
    let mut diagnostics = Vec::new();
    for (id, name) in records {
        match name.as_str() {
            "IFCRELVOIDSELEMENT" => {
                if let Ok(rel) = decoder.decode_by_id(*id) {
                    if let Some(host) = rel.get_ref(4) {
                        *voids.entry(host).or_default() += 1;
                    }
                }
            }
            "IFCRELASSOCIATESMATERIAL" => {
                if let Ok(rel) = decoder.decode_by_id(*id) {
                    if let Some(material) = rel.get_ref(5) {
                        if let Ok(entity) = decoder.decode_by_id(material) {
                            if matches!(
                                &entity.ifc_type,
                                IfcType::IfcMaterialLayerSetUsage | IfcType::IfcMaterialLayerSet
                            ) {
                                for product in rel.get_refs(4).unwrap_or_default() {
                                    layers.insert(product);
                                    if entity.ifc_type == IfcType::IfcMaterialLayerSetUsage {
                                        *layer_usages.entry(product).or_default() += 1;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            "IFCRELDEFINESBYTYPE" => {
                let assignment = decoder.decode_by_id(*id).ok().and_then(|rel| {
                    let type_id =
                        denominator::attribute(&rel, schema, "RelatingType")?.as_entity_ref()?;
                    let objects =
                        denominator::refs(denominator::attribute(&rel, schema, "RelatedObjects"))?;
                    (!objects.is_empty()).then_some((type_id, objects))
                });
                if let Some((type_id, objects)) = assignment {
                    typed_products.extend(objects.into_iter().map(|product| (product, type_id)));
                } else {
                    diagnostics.push(format!("enumeration:malformed_type_assignment/{id}"));
                }
            }
            "IFCSTYLEDITEM" => {
                if let Ok(item) = decoder.decode_by_id(*id) {
                    if let Some(target) = item.get_ref(0) {
                        let textured = item
                            .get_refs(1)
                            .unwrap_or_default()
                            .into_iter()
                            .any(|style| has_texture(style, decoder));
                        styles
                            .entry(target)
                            .and_modify(|old| *old |= textured)
                            .or_insert(textured);
                    }
                }
            }
            "IFCINDEXEDCOLOURMAP" => {
                if let Ok(map) = decoder.decode_by_id(*id) {
                    if let Some(target) = map.get_ref(0) {
                        palettes.insert(target);
                    }
                }
            }
            _ => {}
        }
    }
    let mut type_assignments = BTreeMap::<u32, Vec<u32>>::new();
    for (product, type_id) in typed_products {
        type_assignments.entry(product).or_default().push(type_id);
        if layers.contains(&type_id) {
            layers.insert(product);
        }
        if let Some(count) = layer_usages.get(&type_id).copied() {
            *layer_usages.entry(product).or_default() += count;
        }
    }
    Context {
        voids,
        layers,
        layer_usages,
        type_assignments,
        styles,
        palettes,
        diagnostics,
    }
}

fn has_texture(id: u32, decoder: &mut EntityDecoder) -> bool {
    let mut stack = vec![id];
    let mut seen = BTreeSet::new();
    while let Some(id) = stack.pop() {
        if !seen.insert(id) || seen.len() > 1024 {
            continue;
        }
        let Ok(entity) = decoder.decode_by_id(id) else {
            continue;
        };
        if matches!(
            &entity.ifc_type,
            IfcType::IfcSurfaceStyleWithTextures
                | IfcType::IfcImageTexture
                | IfcType::IfcBlobTexture
                | IfcType::IfcPixelTexture
        ) {
            return true;
        }
        if matches!(
            &entity.ifc_type,
            IfcType::IfcSurfaceStyle | IfcType::IfcPresentationStyleAssignment
        ) {
            for attr in entity.attributes.iter() {
                if let Some(reference) = attr.as_entity_ref() {
                    stack.push(reference);
                }
                if let Some(list) = attr.as_list() {
                    stack.extend(list.iter().filter_map(|v| v.as_entity_ref()));
                }
            }
        }
    }
    false
}
