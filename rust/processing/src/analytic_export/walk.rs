// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! One bounded body-representation walk for flattened and reusable analytics.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use ifc_lite_core::{build_entity_index, has_geometry_by_name, DecodedEntity, EntityDecoder,
    EntityScanner, IfcType, MAX_MAPPED_ITEM_DEPTH};
use ifc_lite_geometry::{analytic::{extract_swept_disk, AnalyticStatus, AnalyticSweptDisk},
    meshed_representations, GeometryRouter};
use nalgebra::Matrix4;

use super::definitions::{source_matrix, SweptDiskDefinition, SweptDiskDefinitions, SweptDiskInstance,
    SweptDiskSourceContext, SweptDiskSourceKey};
use super::{SweptDiskDescriptions, SweptDiskOccurrence,
    MAX_ITEM_DEPTH, MAX_VISITED_ITEMS};
use super::mapped::resolve_mapped_item;
use super::operands::{is_boolean_operand, is_csg_select};
use super::placement::validate_placement_chain;
use super::transform::materialize_disk;

struct WalkItem {
    item: DecodedEntity,
    transform: Matrix4<f64>,
    path: Vec<u32>,
    map_path: Vec<u32>,
    representation_id: u32,
    ancestors: Vec<u32>,
    source_modified: bool,
}

pub(super) struct ExtractResult {
    pub descriptions: SweptDiskDescriptions,
    pub definitions: Option<SweptDiskDefinitions>,
}

const MAX_CACHED_SEGMENTS: usize = 100_000;
const MAX_TOTAL_INSTANCES: usize = 100_000;

/// Extract exact swept-disk definitions for product occurrences, optionally
/// restricted to a set of product STEP IDs. An empty set returns no products.
/// Unsupported directrices are reported in each record's `status`; malformed
/// representation walks are reported in `diagnostics` and omitted atomically
/// for the affected product.
pub(super) fn extract(
    content: &[u8],
    ids: Option<&HashSet<u32>>,
    collect_definitions: bool,
) -> ExtractResult {
    let mut result = SweptDiskDescriptions::default();
    if !collect_definitions && ids.is_some_and(HashSet::is_empty) {
        return ExtractResult { descriptions: result, definitions: None };
    }
    let index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, index);
    let unit_scale = decoder.length_unit_scale();
    let mut definitions = collect_definitions.then(|| SweptDiskDefinitions::new(content, unit_scale));
    if ids.is_some_and(HashSet::is_empty) {
        return ExtractResult { descriptions: result, definitions };
    }
    let router = GeometryRouter::with_scale(unit_scale);
    let mut scanner = EntityScanner::new(content);
    let mut cache = HashMap::<u32, AnalyticSweptDisk>::new();
    let mut cached_segments = 0usize;
    let mut known_sources = BTreeSet::<SweptDiskSourceKey>::new();
    let mut total_instances = 0usize;
    let mut total_source_segments = 0usize;

    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if !has_geometry_by_name(type_name) || ids.is_some_and(|wanted| !wanted.contains(&id)) {
            continue;
        }
        let element = match decoder.decode_at_uncached(start, end) {
            Ok(element) if element.ifc_type.is_subtype_of(IfcType::IfcProduct) => element,
            Ok(_) => continue,
            Err(error) => {
                result
                    .diagnostics
                    .push(format!("product #{id}: decode: {error}"));
                continue;
            }
        };
        let Some(rep_attr) = element.get(6) else {
            result
                .diagnostics
                .push(format!("product #{id}: missing Representation attribute"));
            continue;
        };
        if rep_attr.is_null() {
            continue;
        }
        let Some(rep_id) = rep_attr.as_entity_ref() else {
            result.diagnostics.push(format!(
                "product #{id}: Representation is not an entity reference"
            ));
            continue;
        };
        let representation = match decoder.decode_by_id(rep_id) {
            Ok(representation) => representation,
            Err(error) => {
                result.diagnostics.push(format!(
                    "product #{id}: Representation #{rep_id}: {error}"
                ));
                continue;
            }
        };
        if representation.ifc_type != IfcType::IfcProductDefinitionShape {
            result.diagnostics.push(format!(
                "product #{id}: Representation #{rep_id} is not IfcProductDefinitionShape"
            ));
            continue;
        }
        let Some(reps_attr) = representation.get(2) else {
            result.diagnostics.push(format!(
                "product #{id}: IfcProductDefinitionShape #{rep_id} has no Representations attribute"
            ));
            continue;
        };
        if reps_attr
            .as_list()
            .is_none_or(|items| items.is_empty() || items.iter().any(|item| item.as_entity_ref().is_none()))
        {
            result.diagnostics.push(format!(
                "product #{id}: IfcProductDefinitionShape #{rep_id} has malformed Representations list"
            ));
            continue;
        }
        if reps_attr.as_list().is_some_and(|items| items.len() > MAX_VISITED_ITEMS) {
            result.diagnostics.push(format!("product #{id}: Representations list exceeds work budget"));
            continue;
        }
        let reps = match decoder.resolve_ref_list(reps_attr) {
            Ok(reps) => reps,
            Err(error) => {
                result.diagnostics.push(format!(
                    "product #{id}: IfcProductDefinitionShape #{rep_id} Representations: {error}"
                ));
                continue;
            }
        };
        if let Err(error) = validate_placement_chain(&element, &mut decoder) {
            result.diagnostics.push(format!("product #{id}: placement: {error}"));
            continue;
        }
        let transform = match router.resolve_scaled_placement_strict(&element, &mut decoder) {
            Ok(matrix) => Matrix4::from_column_slice(&matrix),
            Err(error) => {
                result.diagnostics.push(format!("product #{id}: placement: {error}"));
                continue;
            }
        };
        let mut stack = Vec::new();
        let mut failed = false;
        for rep in meshed_representations(&element, &reps) {
            let Some(items_attr) = rep.get(3) else {
                result.diagnostics.push(format!("product #{id}: representation #{} is missing Items", rep.id));
                failed = true;
                break;
            };
            let Some(item_refs) = items_attr.as_list() else {
                result.diagnostics.push(format!("product #{id}: representation #{} has malformed Items", rep.id));
                failed = true;
                break;
            };
            if item_refs.is_empty() || item_refs.iter().any(|item| item.as_entity_ref().is_none()) {
                result.diagnostics.push(format!("product #{id}: representation #{} has malformed Items", rep.id));
                failed = true;
                break;
            }
            if stack.len().saturating_add(item_refs.len()) > MAX_VISITED_ITEMS {
                result.diagnostics.push(format!("product #{id}: representation items exceed work budget"));
                failed = true;
                break;
            }
            match decoder.resolve_ref_list(items_attr) {
                Ok(items) => stack.extend(items.into_iter().rev().map(|item| WalkItem {
                    item, transform, path: Vec::new(), map_path: Vec::new(),
                    representation_id: rep.id, ancestors: Vec::new(), source_modified: false,
                })),
                Err(error) => {
                    result.diagnostics.push(format!("product #{id}: items: {error}"));
                    failed = true;
                    break;
                }
            }
        }
        let mut descriptions = Vec::new();
        let mut pending_sources = BTreeMap::<SweptDiskSourceKey, SweptDiskDefinition>::new();
        let mut pending_instances = Vec::<SweptDiskInstance>::new();
        let mut visited = 0;
        let mut emitted_segments = 0usize;
        if stack.len() > MAX_VISITED_ITEMS {
            failed = true;
            result.diagnostics.push(format!("product #{id}: too many representation items"));
        }
        while !failed {
            let Some(node) = stack.pop() else { break };
            visited += 1;
            if visited > MAX_VISITED_ITEMS || node.ancestors.len() >= MAX_ITEM_DEPTH
                || node.ancestors.contains(&node.item.id)
            {
                result.diagnostics.push(format!("product #{id}: representation walk exceeded bound or encountered a cycle at #{}", node.item.id));
                failed = true;
                break;
            }
            let item_id = node.item.id;
            let mut ancestors = node.ancestors;
            ancestors.push(item_id);
            match node.item.ifc_type {
                IfcType::IfcSweptDiskSolid => {
                    let raw = if let Some(disk) = cache.get(&item_id) {
                        Ok(disk.clone())
                    } else {
                        extract_swept_disk(&node.item, &mut decoder).inspect(|disk| {
                            if cache.len() < MAX_VISITED_ITEMS
                                && disk.segments.len() <= MAX_CACHED_SEGMENTS.saturating_sub(cached_segments) {
                                cached_segments += disk.segments.len();
                                cache.insert(item_id, disk.clone());
                            }
                        })
                    };
                    match raw {
                        Ok(mut disk) => {
                            // A mapped representation can reuse the same bounded
                            // directrix many times. Bound the aggregate output too.
                            if disk.segments.len() > MAX_VISITED_ITEMS - emitted_segments {
                                result.diagnostics.push(format!("product #{id}: directrix output exceeds work budget"));
                                failed = true;
                                break;
                            }
                            emitted_segments += disk.segments.len();
                            if let Some(view) = &definitions {
                                let context = if node.map_path.is_empty() {
                                    SweptDiskSourceContext::Direct { representation_id: node.representation_id }
                                } else {
                                    SweptDiskSourceContext::Mapped { representation_map_path: node.map_path.clone() }
                                };
                                let key = view.key(context, item_id);
                                pending_sources.entry(key.clone())
                                    .or_insert_with(|| SweptDiskDefinition::from_disk(key.clone(), &disk));
                                let world_from_source = source_matrix(&node.transform, unit_scale);
                                let status = if world_from_source.is_none() {
                                    AnalyticStatus::Unsupported("occurrence transform has non-finite coordinates".into())
                                } else { disk.status.clone() };
                                pending_instances.push(SweptDiskInstance {
                                    ordinal: descriptions.len(), source: key, product_id: id,
                                    solid_id: item_id, mapping_path: node.path.clone(),
                                    source_modified: node.source_modified, world_from_source, status,
                                });
                            }
                            materialize_disk(&mut disk, &node.transform, unit_scale);
                            if let Some(instance) = pending_instances.last_mut() {
                                instance.status = disk.status.clone();
                            }
                            descriptions.push(SweptDiskOccurrence {
                                solid_id: item_id,
                                directrix_id: disk.directrix_id,
                                mapping_path: node.path,
                                source_modified: node.source_modified,
                                radius: disk.radius,
                                inner_radius: disk.inner_radius,
                                directrix: disk.segments,
                                status: disk.status,
                            });
                        }
                        Err(error) => {
                            result.diagnostics.push(format!("product #{id}, solid #{item_id}: {error}"));
                            failed = true;
                            break;
                        }
                    }
                }
                IfcType::IfcMappedItem => {
                    if node.path.len() >= MAX_MAPPED_ITEM_DEPTH as usize {
                        result.diagnostics.push(format!("product #{id}: mapped item #{item_id} exceeded maximum nesting depth"));
                        failed = true;
                        break;
                    }
                    match resolve_mapped_item(&node.item, &router, &mut decoder) {
                        Ok(mapped) => {
                            let transform = mapped.transform.map_or(node.transform, |m| node.transform * Matrix4::from_column_slice(&m));
                            let mut path = node.path;
                            path.push(item_id);
                            let mut map_path = node.map_path;
                            map_path.push(mapped.representation_map_id);
                            if stack.len().saturating_add(mapped.items.len()) > MAX_VISITED_ITEMS {
                                result.diagnostics.push(format!("product #{id}: mapped item #{item_id} exceeds work budget"));
                                failed = true;
                                break;
                            }
                            stack.extend(mapped.items.into_iter().rev().map(|item| WalkItem {
                                item, transform, path: path.clone(), map_path: map_path.clone(),
                                representation_id: node.representation_id,
                                ancestors: ancestors.clone(), source_modified: node.source_modified,
                            }));
                        }
                        Err(reason) => {
                            result.diagnostics.push(format!("product #{id}: mapped item #{item_id}: {reason}"));
                            failed = true;
                            break;
                        }
                    }
                }
                IfcType::IfcBooleanResult | IfcType::IfcBooleanClippingResult => {
                    for index in [2, 1] {
                        let Some(operand_id) = node.item.get_ref(index) else {
                            let name = if index == 1 { "FirstOperand" } else { "SecondOperand" };
                            result.diagnostics.push(format!(
                                "product #{id}: boolean item #{item_id} has missing or invalid {name}"
                            ));
                            failed = true;
                            break;
                        };
                        match decoder.decode_by_id(operand_id) {
                            Ok(operand) if is_boolean_operand(&operand.ifc_type) => stack.push(WalkItem {
                                item: operand, transform: node.transform, path: node.path.clone(),
                                map_path: node.map_path.clone(), representation_id: node.representation_id,
                                ancestors: ancestors.clone(), source_modified: true,
                            }),
                            Ok(operand) => {
                                result.diagnostics.push(format!("product #{id}: boolean operand #{operand_id} has invalid IfcBooleanOperand type {}", operand.ifc_type.name()));
                                failed = true;
                                break;
                            }
                            Err(error) => {
                                result.diagnostics.push(format!("product #{id}: boolean operand #{operand_id}: {error}"));
                                failed = true;
                                break;
                            }
                        }
                    }
                }
                IfcType::IfcCsgSolid => {
                    let Some(root_id) = node.item.get_ref(0) else {
                        result.diagnostics.push(format!(
                            "product #{id}: CSG solid #{item_id} has missing or invalid TreeRootExpression"
                        ));
                        failed = true;
                        break;
                    };
                    match decoder.decode_by_id(root_id) {
                        Ok(root) if is_csg_select(&root.ifc_type) => stack.push(WalkItem {
                            item: root, transform: node.transform, path: node.path,
                            map_path: node.map_path, representation_id: node.representation_id,
                            ancestors, source_modified: true,
                        }),
                        Ok(root) => {
                            result.diagnostics.push(format!("product #{id}: CSG root #{root_id} has invalid IfcCsgSelect type {}", root.ifc_type.name()));
                            failed = true;
                        }
                        Err(error) => {
                            result.diagnostics.push(format!("product #{id}: CSG root #{root_id}: {error}"));
                            failed = true;
                        }
                    }
                }
                _ => {}
            }
        }
        if !failed && !descriptions.is_empty() {
            if let Some(view) = &mut definitions {
                let new_segments: usize = pending_sources.iter()
                    .filter(|(key, _)| !known_sources.contains(*key))
                    .map(|(_, source)| source.directrix.len()).sum();
                if pending_instances.len() > MAX_TOTAL_INSTANCES.saturating_sub(total_instances) {
                    view.diagnostics.push(format!("product #{id}: source instances exceed total output budget"));
                } else if new_segments > MAX_CACHED_SEGMENTS.saturating_sub(total_source_segments) {
                    view.diagnostics.push(format!("product #{id}: source segments exceed total output budget"));
                } else {
                    for (key, source) in pending_sources {
                        if known_sources.insert(key) {
                            view.sources.push(source);
                        }
                    }
                    total_source_segments += new_segments;
                    total_instances += pending_instances.len();
                    view.instances.insert(id, pending_instances);
                }
            }
            if !collect_definitions {
                result.elements.insert(id, descriptions);
            }
        }
    }
    if let Some(view) = &mut definitions {
        view.diagnostics.extend(result.diagnostics.iter().cloned());
    }
    ExtractResult { descriptions: result, definitions }
}
