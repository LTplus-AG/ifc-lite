// SPDX-License-Identifier: MPL-2.0
//! Bounded, read-only representation and context counts for all products.

use super::{denominator, representations, Product};
use ifc_lite_core::{EntityDecoder, IfcType, SchemaVersion};
use ifc_lite_geometry::GeometryRouter;
use std::collections::{BTreeMap, BTreeSet};

pub(super) struct Scan {
    pub products: BTreeMap<u32, Product>,
    pub type_definitions: BTreeMap<u32, String>,
    pub unclassified_entities: BTreeMap<u32, String>,
    pub enumeration_complete: bool,
    pub diagnostics: Vec<String>,
}

pub(super) fn products(content: &[u8], record_limit: usize) -> Scan {
    let inventory = denominator::inventory(content, record_limit);
    let schema = inventory.schema;
    let records = inventory.records;
    let mut decoder = EntityDecoder::with_index(content, inventory.index);
    let context = super::context::collect(&records, &mut decoder, schema);
    let mut diagnostics = inventory.diagnostics;
    diagnostics.extend(context.diagnostics);
    let mut result = Scan {
        products: BTreeMap::new(),
        type_definitions: BTreeMap::new(),
        unclassified_entities: BTreeMap::new(),
        enumeration_complete: true,
        diagnostics: Vec::new(),
    };
    for (id, name) in records {
        let Some(info) = schema.entity_info(&name) else {
            result.unclassified_entities.insert(id, name);
            diagnostics.push(format!("enumeration:unknown_entity/{id}"));
            continue;
        };
        if schema.is_subtype_of(&name, "IfcTypeProduct") {
            result.type_definitions.insert(id, info.name.to_owned());
            continue;
        }
        if !schema.is_subtype_of(&name, "IfcProduct") {
            continue;
        }
        let mut product = denominator::product(info.name);
        product.counts.openings = context.voids.get(&id).copied().unwrap_or_default();
        product.counts.layered_products = usize::from(context.layers.contains(&id));
        product.counts.material_layer_usages =
            context.layer_usages.get(&id).copied().unwrap_or_default();
        match decoder.decode_by_id(id) {
            Ok(entity) => scan_representations(
                &entity,
                &mut product,
                &mut decoder,
                &context.styles,
                &context.palettes,
                schema,
            ),
            Err(_) => denominator::fail(&mut product, "product:decode_failed"),
        }
        if product.representation_state == "absent" {
            for type_id in context.type_assignments.get(&id).into_iter().flatten() {
                representations::check_type_absence(*type_id, &mut product, &mut decoder, schema);
            }
        }
        result.enumeration_complete &= product.enumeration_complete;
        result.products.insert(id, product);
    }
    result.enumeration_complete &= diagnostics.is_empty();
    result.diagnostics = diagnostics;
    result
}

fn scan_representations(
    entity: &ifc_lite_core::DecodedEntity,
    product: &mut Product,
    decoder: &mut EntityDecoder,
    styles: &BTreeMap<u32, bool>,
    palettes: &BTreeSet<u32>,
    schema: SchemaVersion,
) {
    let mut stack: Vec<_> = representations::roots(entity, product, decoder, schema)
        .into_iter()
        .map(|id| (id, Vec::new()))
        .collect();
    let mut visited = 0;
    while let Some((id, mut path)) = stack.pop() {
        visited += 1;
        if visited > representations::MAX_ITEMS
            || path.len() >= representations::MAX_DEPTH
            || path.contains(&id)
        {
            denominator::fail(product, "product:representation_walk_bound_or_cycle");
            break;
        }
        path.push(id);
        let Ok(item) = decoder.decode_by_id(id) else {
            denominator::fail(product, "product:unresolved_item");
            continue;
        };
        if !schema.is_subtype_of(item.ifc_type.name(), "IfcRepresentationItem")
            && !schema.is_subtype_of(item.ifc_type.name(), "IfcGridAxis")
        {
            denominator::fail(product, "product:invalid_or_unknown_item_type");
        }
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
                let rep_id = denominator::attribute(&item, schema, "MappingSource")
                    .and_then(|v| v.as_entity_ref())
                    .and_then(|id| decoder.decode_by_id(id).ok())
                    .filter(|map| schema.is_subtype_of(map.ifc_type.name(), "IfcRepresentationMap"))
                    .and_then(|map| {
                        denominator::attribute(&map, schema, "MappedRepresentation")
                            .and_then(|v| v.as_entity_ref())
                    });
                if let Some(rep_id) = rep_id {
                    let children =
                        representations::representation_items(rep_id, product, decoder, schema);
                    if stack
                        .len()
                        .saturating_add(children.len())
                        .saturating_add(visited)
                        > representations::MAX_ITEMS
                    {
                        denominator::fail(product, "product:representation_walk_bound_or_cycle");
                        break;
                    }
                    stack.extend(children.into_iter().map(|child| (child, path.clone())));
                } else {
                    denominator::fail(product, "mapping:unresolved_source_representation");
                }
            }

            IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult => {
                product.counts.boolean_items += 1;
                product.counts.clipping_items +=
                    usize::from(item.ifc_type == IfcType::IfcBooleanClippingResult);
                for name in ["FirstOperand", "SecondOperand"] {
                    if let Some(child) =
                        denominator::attribute(&item, schema, name).and_then(|v| v.as_entity_ref())
                    {
                        product.counts.boolean_operands += 1;
                        stack.push((child, path.clone()));
                    } else {
                        denominator::fail(product, "product:malformed_boolean_operand");
                    }
                }
                product
                    .reasons
                    .insert("product:enclosing_boolean_not_evaluated".into());
            }
            IfcType::IfcCsgSolid => {
                if let Some(root) = denominator::attribute(&item, schema, "TreeRootExpression")
                    .and_then(|v| v.as_entity_ref())
                {
                    stack.push((root, path));
                } else {
                    denominator::fail(product, "product:malformed_csg_root");
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
