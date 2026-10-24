// SPDX-License-Identifier: MPL-2.0
//! Bounded, read-only representation and context counts for candidate products.

use super::{Counts, Product};
use ifc_lite_core::{
    build_entity_index, has_geometry_by_name, EntityDecoder, EntityScanner, IfcType,
};
use ifc_lite_geometry::{meshed_representations, GeometryRouter};
use std::collections::{BTreeMap, BTreeSet};

const MAX_ITEMS_PER_PRODUCT: usize = 100_000;
const MAX_DEPTH: usize = 128;

pub(super) fn products(content: &[u8]) -> (BTreeMap<u32, Product>, Vec<String>) {
    let index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, index);
    let mut records = Vec::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, name, _, _)) = scanner.next_entity() {
        records.push((id, name.to_owned()));
    }
    let mut voids = BTreeMap::<u32, usize>::new();
    let mut layers = BTreeSet::<u32>::new();
    let mut layer_usages = BTreeMap::<u32, usize>::new();
    let mut typed_products = Vec::<(u32, u32)>::new();
    let mut styles = BTreeMap::<u32, bool>::new();
    let mut palettes = BTreeSet::<u32>::new();
    let mut diagnostics = Vec::new();
    for (id, name) in &records {
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
                if let Ok(rel) = decoder.decode_by_id(*id) {
                    if let Some(type_id) = rel.get_ref(5) {
                        typed_products.extend(
                            rel.get_refs(4)
                                .unwrap_or_default()
                                .into_iter()
                                .map(|product| (product, type_id)),
                        );
                    }
                }
            }
            "IFCSTYLEDITEM" => {
                if let Ok(item) = decoder.decode_by_id(*id) {
                    if let Some(target) = item.get_ref(0) {
                        let textured = item
                            .get_refs(1)
                            .unwrap_or_default()
                            .into_iter()
                            .any(|style| has_texture(style, &mut decoder));
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
    for (product, type_id) in typed_products {
        if layers.contains(&type_id) {
            layers.insert(product);
        }
        if let Some(count) = layer_usages.get(&type_id).copied() {
            *layer_usages.entry(product).or_default() += count;
        }
    }
    let mut result = BTreeMap::new();
    for (id, name) in records {
        if !has_geometry_by_name(&name) {
            continue;
        }
        let entity = match decoder.decode_by_id(id) {
            Ok(entity) if entity.ifc_type.is_subtype_of(IfcType::IfcProduct) => entity,
            Ok(_) => continue,
            Err(error) => {
                diagnostics.push(format!("product #{id}: decode: {error}"));
                continue;
            }
        };
        let mut product = Product {
            ifc_type: entity.ifc_type.name().to_owned(),
            representation_families: BTreeMap::new(),
            source_admission: "refused",
            verdict: "refused",
            reasons: BTreeSet::new(),
            counts: Counts::default(),
            item_ids: BTreeSet::new(),
        };
        product.counts.openings = voids.get(&id).copied().unwrap_or_default();
        product.counts.layered_products = usize::from(layers.contains(&id));
        product.counts.material_layer_usages = layer_usages.get(&id).copied().unwrap_or_default();
        scan_representations(&entity, &mut product, &mut decoder, &styles, &palettes);
        result.insert(id, product);
    }
    (result, diagnostics)
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

fn scan_representations(
    entity: &ifc_lite_core::DecodedEntity,
    product: &mut Product,
    decoder: &mut EntityDecoder,
    styles: &BTreeMap<u32, bool>,
    palettes: &BTreeSet<u32>,
) {
    let Some(shape_id) = entity.get_ref(6) else {
        product.reasons.insert("product:no_Representation".into());
        return;
    };
    let Ok(shape) = decoder.decode_by_id(shape_id) else {
        product
            .reasons
            .insert("product:unresolved_Representation".into());
        return;
    };
    if shape.ifc_type != IfcType::IfcProductDefinitionShape {
        product
            .reasons
            .insert("product:Representation_not_IfcProductDefinitionShape".into());
        return;
    }
    let Some(rep_ids) = shape.get_refs(2) else {
        product.reasons.insert("product:no_Representations".into());
        return;
    };
    let mut reps = Vec::new();
    for id in rep_ids {
        match decoder.decode_by_id(id) {
            Ok(rep) => reps.push(rep),
            Err(_) => {
                product
                    .reasons
                    .insert("product:unresolved_shape_representation".into());
            }
        }
    }
    let mut stack = Vec::new();
    for rep in meshed_representations(entity, &reps) {
        stack.extend(
            rep.get_refs(3)
                .unwrap_or_default()
                .into_iter()
                .map(|id| (id, Vec::new())),
        );
    }
    if stack.is_empty() {
        product.reasons.insert("product:no_meshed_items".into());
    }
    let mut visited = 0;
    while let Some((id, mut path)) = stack.pop() {
        visited += 1;
        if visited > MAX_ITEMS_PER_PRODUCT || path.len() >= MAX_DEPTH || path.contains(&id) {
            product
                .reasons
                .insert("product:representation_walk_bound_or_cycle".into());
            break;
        }
        path.push(id);
        let Ok(item) = decoder.decode_by_id(id) else {
            product.reasons.insert("product:unresolved_item".into());
            continue;
        };
        *product
            .representation_families
            .entry(item.ifc_type.name().to_owned())
            .or_default() += 1;
        product.item_ids.insert(id);
        if let Some(&textured) = styles.get(&id) {
            product.counts.styled_items += 1;
            product.counts.textured_items += usize::from(textured);
        }
        product.counts.palette_items += usize::from(palettes.contains(&id));
        match &item.ifc_type {
            IfcType::IfcMappedItem => {
                product.counts.mapped_items += 1;
                classify_mapping(&item, product, decoder);
                if let Some(rep_id) = item
                    .get_ref(0)
                    .and_then(|map| decoder.decode_by_id(map).ok())
                    .and_then(|map| map.get_ref(1))
                {
                    if let Ok(rep) = decoder.decode_by_id(rep_id) {
                        stack.extend(
                            rep.get_refs(3)
                                .unwrap_or_default()
                                .into_iter()
                                .map(|child| (child, path.clone())),
                        );
                    } else {
                        product
                            .reasons
                            .insert("mapping:unresolved_representation".into());
                    }
                } else {
                    product
                        .reasons
                        .insert("mapping:unresolved_source_representation".into());
                }
            }
            IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult => {
                product.counts.boolean_items += 1;
                product.counts.clipping_items +=
                    usize::from(item.ifc_type == IfcType::IfcBooleanClippingResult);
                for child in [item.get_ref(1), item.get_ref(2)].into_iter().flatten() {
                    product.counts.boolean_operands += 1;
                    stack.push((child, path.clone()));
                }
                product
                    .reasons
                    .insert("product:enclosing_boolean_not_evaluated".into());
            }
            IfcType::IfcCsgSolid => {
                if let Some(root) = item.get_ref(0) {
                    stack.push((root, path));
                }
                product
                    .reasons
                    .insert("product:csg_solid_not_evaluated".into());
            }
            IfcType::IfcExtrudedAreaSolid | IfcType::IfcSweptDiskSolid => {}
            _ => {
                product.reasons.insert(format!(
                    "product:unsupported_family/{}",
                    item.ifc_type.name()
                ));
            }
        }
    }
    if product.counts.openings > 0 {
        product
            .reasons
            .insert("product:openings_not_applied".into());
    }
    if product.counts.layered_products > 0 {
        product
            .reasons
            .insert("product:material_layers_not_applied".into());
    }
    if product.counts.styled_items > 0 || product.counts.palette_items > 0 {
        product
            .reasons
            .insert("product:appearance_not_applied".into());
    }
    if product.counts.textured_items > 0 {
        product
            .reasons
            .insert("product:textures_not_applied".into());
    }
}

fn classify_mapping(
    item: &ifc_lite_core::DecodedEntity,
    product: &mut Product,
    decoder: &mut EntityDecoder,
) {
    let Some(target) = item.get_ref(1).and_then(|id| decoder.decode_by_id(id).ok()) else {
        product.reasons.insert("mapping:unresolved_target".into());
        return;
    };
    let explicit_scales = if target
        .ifc_type
        .is_subtype_of(IfcType::IfcCartesianTransformationOperator3D)
    {
        [
            target.get_float(3),
            target.get_float(5),
            target.get_float(6),
        ]
    } else {
        [target.get_float(3), target.get_float(4), None]
    };
    if explicit_scales.into_iter().flatten().any(|s| s < 0.0) {
        product.counts.negative_scale += 1;
    }
    let Some(source) = item.get_ref(0).and_then(|id| decoder.decode_by_id(id).ok()) else {
        product.reasons.insert("mapping:unresolved_source".into());
        return;
    };
    let router = GeometryRouter::with_scale(decoder.length_unit_scale());
    let matrix = match router.resolve_scaled_mapped_item_transform(item, &source, decoder) {
        Ok(Some(matrix)) => matrix,
        Ok(None) => [
            1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
        ],
        Err(error) => {
            product
                .reasons
                .insert(format!("mapping:unqualified_transform/{error}"));
            return;
        }
    };
    let x = [matrix[0], matrix[1], matrix[2]];
    let y = [matrix[4], matrix[5], matrix[6]];
    let z = [matrix[8], matrix[9], matrix[10]];
    let dot = |a: [f64; 3], b: [f64; 3]| a.into_iter().zip(b).map(|(a, b)| a * b).sum::<f64>();
    let determinant = dot(
        x,
        [
            y[1] * z[2] - y[2] * z[1],
            y[2] * z[0] - y[0] * z[2],
            y[0] * z[1] - y[1] * z[0],
        ],
    );
    if determinant < 0.0 {
        product.counts.mapped_mirrored += 1;
    }
    if [x, y, z]
        .into_iter()
        .any(|axis| (dot(axis, axis) - 1.0).abs() > 1e-9)
    {
        product.counts.mapped_scaled += 1;
    } else if determinant > 0.0
        && (determinant - 1.0).abs() <= 1e-9
        && dot(x, y).abs() <= 1e-9
        && dot(x, z).abs() <= 1e-9
        && dot(y, z).abs() <= 1e-9
    {
        product.counts.mapped_rigid += 1;
    }
}
