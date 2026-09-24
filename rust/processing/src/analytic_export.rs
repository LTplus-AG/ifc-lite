// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Optional analytic descriptions of authored geometry, keyed by product occurrence.
//! This walks the same body-representation selection as the mesh router, but does
//! not produce meshes. Source operands of booleans are identified as such.

use std::collections::{BTreeMap, HashSet};

use ifc_lite_core::{build_entity_index, has_geometry_by_name, DecodedEntity, EntityDecoder, EntityScanner, IfcType, MAX_MAPPED_ITEM_DEPTH};
use ifc_lite_geometry::{analytic::{extract_swept_disk, AnalyticCurveSegment, AnalyticStatus}, meshed_representations, GeometryRouter};
use nalgebra::Matrix4;

mod transform;
use transform::transform_disk;
mod operands;
use operands::{is_boolean_operand, is_csg_select};
mod placement;
use placement::validate_placement_chain;
use serde::Serialize;

const MAX_VISITED_ITEMS: usize = 100_000;
const MAX_ITEM_DEPTH: usize = 128;

/// One authored `IfcSweptDiskSolid` in an occurrence's body representation.
#[derive(Debug, Clone, Serialize)]
pub struct SweptDiskOccurrence {
    pub solid_id: u32,
    pub directrix_id: u32,
    pub mapping_path: Vec<u32>,
    /// True when this solid is an operand of an enclosing CSG construction.
    pub source_modified: bool,
    #[serde(rename = "Radius")]
    /// Effective world radius for a complete description; source radius in
    /// metres when status is unsupported (no world circular radius is implied).
    pub radius: f64,
    #[serde(rename = "InnerRadius")]
    pub inner_radius: Option<f64>,
    #[serde(rename = "Directrix")]
    pub directrix: Vec<AnalyticCurveSegment>,
    pub status: AnalyticStatus,
}

/// Analytic swept disks in IFC Z-up, absolute-world metres.
#[derive(Debug, Clone, Serialize)]
pub struct SweptDiskDescriptions {
    pub up_axis: &'static str,
    pub units: &'static str,
    pub coordinate_space: &'static str,
    pub elements: BTreeMap<u32, Vec<SweptDiskOccurrence>>,
    pub diagnostics: Vec<String>,
}

impl Default for SweptDiskDescriptions {
    fn default() -> Self {
        Self {
            up_axis: "Z",
            units: "m",
            coordinate_space: "absolute_ifc_world",
            elements: BTreeMap::new(),
            diagnostics: Vec::new(),
        }
    }
}

struct WalkItem {
    item: DecodedEntity,
    transform: Matrix4<f64>,
    path: Vec<u32>,
    ancestors: Vec<u32>,
    source_modified: bool,
}

/// Extract exact swept-disk definitions for product occurrences, optionally
/// restricted to a set of product STEP IDs. An empty set returns no products.
/// Unsupported directrices are reported in each record's `status`; malformed
/// representation walks are reported in `diagnostics` and omitted atomically
/// for the affected product.
pub fn extract_swept_disk_descriptions(
    content: &[u8],
    ids: Option<&HashSet<u32>>,
) -> SweptDiskDescriptions {
    let mut result = SweptDiskDescriptions::default();
    if ids.is_some_and(HashSet::is_empty) {
        return result;
    }
    let index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, index);
    let unit_scale = decoder.length_unit_scale();
    let router = GeometryRouter::with_scale(unit_scale);
    let mut scanner = EntityScanner::new(content);

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
                    item, transform, path: Vec::new(), ancestors: Vec::new(), source_modified: false,
                })),
                Err(error) => {
                    result.diagnostics.push(format!("product #{id}: items: {error}"));
                    failed = true;
                    break;
                }
            }
        }
        let mut descriptions = Vec::new();
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
                    match extract_swept_disk(&node.item, &mut decoder) {
                        Ok(mut disk) => {
                            // A mapped representation can reuse the same bounded
                            // directrix many times. Bound the aggregate output too.
                            if disk.segments.len() > MAX_VISITED_ITEMS - emitted_segments {
                                result.diagnostics.push(format!("product #{id}: directrix output exceeds work budget"));
                                failed = true;
                                break;
                            }
                            emitted_segments += disk.segments.len();
                            if matches!(disk.status, AnalyticStatus::Complete) {
                                match transform_disk(&mut disk.segments, disk.radius, disk.inner_radius, &node.transform, unit_scale) {
                                    Ok((radius, inner_radius)) => {
                                        disk.radius = radius;
                                        disk.inner_radius = inner_radius;
                                    }
                                    Err(reason) => {
                                        disk.status = AnalyticStatus::Unsupported(reason);
                                        disk.segments.clear();
                                        disk.radius *= unit_scale;
                                        disk.inner_radius = disk.inner_radius.map(|r| r * unit_scale);
                                    }
                                }
                            } else {
                                disk.radius *= unit_scale;
                                disk.inner_radius = disk.inner_radius.map(|r| r * unit_scale);
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
                    let Some(target_id) = node.item.get_ref(1) else {
                        result.diagnostics.push(format!("product #{id}: mapped item #{item_id} has missing or invalid MappingTarget"));
                        failed = true;
                        break;
                    };
                    match decoder.decode_by_id(target_id) {
                        Ok(target) if target.ifc_type.is_subtype_of(IfcType::IfcCartesianTransformationOperator) => {}
                        Ok(target) => {
                            result.diagnostics.push(format!("product #{id}: mapped item #{item_id} MappingTarget #{target_id} has wrong type {}", target.ifc_type.name()));
                            failed = true;
                            break;
                        }
                        Err(error) => {
                            result.diagnostics.push(format!("product #{id}: mapped item #{item_id} MappingTarget #{target_id}: {error}"));
                            failed = true;
                            break;
                        }
                    }
                    let mapped = (|| {
                        let map = decoder.decode_by_id(node.item.get_ref(0)?) .ok()?;
                        if map.ifc_type != IfcType::IfcRepresentationMap { return None; }
                        let rep = decoder.decode_by_id(map.get_ref(1)?) .ok()?;
                        let items_attr = rep.get(3)?;
                        if items_attr.as_list().is_none_or(|items| items.is_empty() || items.len() > MAX_VISITED_ITEMS || items.iter().any(|item| item.as_entity_ref().is_none())) {
                            return None;
                        }
                        let items = decoder.resolve_ref_list(items_attr).ok()?;
                        let local = router.resolve_scaled_mapped_item_transform(&node.item, &map, &mut decoder).ok()?;
                        Some((items, local))
                    })();
                    if let Some((items, local)) = mapped {
                        let transform = local.map_or(node.transform, |m| node.transform * Matrix4::from_column_slice(&m));
                        let mut path = node.path;
                        path.push(item_id);
                        if stack.len().saturating_add(items.len()) > MAX_VISITED_ITEMS {
                            result.diagnostics.push(format!("product #{id}: mapped item #{item_id} exceeds work budget"));
                            failed = true;
                            break;
                        }
                        stack.extend(items.into_iter().rev().map(|item| WalkItem {
                            item, transform, path: path.clone(), ancestors: ancestors.clone(), source_modified: node.source_modified,
                        }));
                    } else {
                        result.diagnostics.push(format!("product #{id}: cannot resolve mapped item #{item_id}"));
                        failed = true;
                        break;
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
            result.elements.insert(id, descriptions);
        }
    }
    result
}
