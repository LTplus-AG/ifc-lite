// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::types::response::{QuickMetadataEntitySummary, QuickMetadataSpatialNode};
use std::collections::HashMap;

#[derive(Clone)]
pub(super) struct QuickSpatialNodeEntry {
    pub(super) express_id: u32,
    pub(super) type_name: String,
    pub(super) name: String,
    pub(super) elevation: Option<f64>,
    pub(super) children: Vec<u32>,
    pub(super) elements: Vec<u32>,
    pub(super) parent: Option<u32>,
}

/// Case-insensitive spatial-type check that avoids to_ascii_uppercase() allocation.
#[inline]
pub(super) fn is_quick_spatial_type_ci(type_name: &str) -> bool {
    type_name.eq_ignore_ascii_case("IFCPROJECT")
        || type_name.eq_ignore_ascii_case("IFCSITE")
        || type_name.eq_ignore_ascii_case("IFCBUILDING")
        || type_name.eq_ignore_ascii_case("IFCBUILDINGSTOREY")
        || type_name.eq_ignore_ascii_case("IFCSPACE")
        || type_name.eq_ignore_ascii_case("IFCSPATIALZONE")
        || type_name.eq_ignore_ascii_case("IFCFACILITY")
        || type_name.eq_ignore_ascii_case("IFCFACILITYPART")
        || type_name.eq_ignore_ascii_case("IFCBRIDGE")
        || type_name.eq_ignore_ascii_case("IFCBRIDGEPART")
        || type_name.eq_ignore_ascii_case("IFCROAD")
        || type_name.eq_ignore_ascii_case("IFCROADPART")
        || type_name.eq_ignore_ascii_case("IFCRAILWAY")
        || type_name.eq_ignore_ascii_case("IFCRAILWAYPART")
}

pub(super) fn parse_step_arguments(entity_bytes: &[u8]) -> Vec<&[u8]> {
    let Some(open_idx) = entity_bytes.iter().position(|byte| *byte == b'(') else {
        return Vec::new();
    };
    let Some(close_idx) = entity_bytes.iter().rposition(|byte| *byte == b')') else {
        return Vec::new();
    };
    if close_idx <= open_idx {
        return Vec::new();
    }
    let args = &entity_bytes[open_idx + 1..close_idx];
    let mut parts = Vec::new();
    let mut in_string = false;
    let mut depth = 0i32;
    let mut start = 0usize;
    let bytes = args;
    let mut index = 0usize;
    while index < bytes.len() {
        match bytes[index] {
            b'\'' => {
                if in_string && index + 1 < bytes.len() && bytes[index + 1] == b'\'' {
                    index += 1;
                } else {
                    in_string = !in_string;
                }
            }
            b'(' if !in_string => depth += 1,
            b')' if !in_string => depth -= 1,
            b',' if !in_string && depth == 0 => {
                parts.push(args[start..index].trim_ascii());
                start = index + 1;
            }
            _ => {}
        }
        index += 1;
    }
    if start <= args.len() {
        parts.push(args[start..].trim_ascii());
    }
    parts
}

fn parse_step_string(token: &[u8]) -> Option<String> {
    let trimmed = token.trim_ascii();
    if trimmed.len() < 2 || trimmed[0] != b'\'' || trimmed[trimmed.len() - 1] != b'\'' {
        return None;
    }
    let unescaped = String::from_utf8_lossy(&trimmed[1..trimmed.len() - 1]).replace("''", "'");
    // Decode STEP unicode escapes so quick-metadata names match the from_token
    // path and the TS parser (e.g. a name stored as Br\X2\00FC\X0\cke).
    Some(ifc_lite_core::decode_ifc_string(&unescaped).into_owned())
}

pub(super) fn parse_step_ref(token: &[u8]) -> Option<u32> {
    std::str::from_utf8(token.trim_ascii().strip_prefix(b"#")?)
        .ok()?
        .parse()
        .ok()
}

pub(super) fn parse_step_ref_list(token: &[u8]) -> Vec<u32> {
    let trimmed = token.trim_ascii();
    let inner = trimmed
        .strip_prefix(b"(")
        .and_then(|value| value.strip_suffix(b")"))
        .unwrap_or(trimmed);
    inner.split(|byte| *byte == b',').filter_map(parse_step_ref).collect()
}

pub(super) fn extract_name_from_args(args: &[&[u8]], fallback: &str) -> String {
    args.get(2)
        .and_then(|token| parse_step_string(token))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

pub(super) fn extract_storey_elevation_from_args(args: &[&[u8]]) -> Option<f64> {
    for index in [9usize, 8usize] {
        if let Some(value) = args
            .get(index)
            .and_then(|token| std::str::from_utf8(token.trim_ascii()).ok())
            .and_then(|token| token.parse::<f64>().ok())
        {
            return Some(value);
        }
    }
    args.iter()
        .filter_map(|token| std::str::from_utf8(token.trim_ascii()).ok())
        .filter_map(|token| token.parse::<f64>().ok())
        .find(|value| value.abs() < 10_000.0)
}

pub(super) fn build_quick_spatial_tree_node(
    express_id: u32,
    nodes: &HashMap<u32, QuickSpatialNodeEntry>,
    element_summaries: &HashMap<u32, QuickMetadataEntitySummary>,
) -> Result<QuickMetadataSpatialNode, String> {
    let node = nodes
        .get(&express_id)
        .ok_or_else(|| format!("Quick spatial node #{express_id} not found"))?;
    let mut children = Vec::with_capacity(node.children.len());
    for child_id in &node.children {
        children.push(build_quick_spatial_tree_node(
            *child_id,
            nodes,
            element_summaries,
        )?);
    }
    let elements = node
        .elements
        .iter()
        .map(|element_id| {
            element_summaries
                .get(element_id)
                .cloned()
                .unwrap_or(QuickMetadataEntitySummary {
                express_id: *element_id,
                type_name: "IfcProduct".to_string(),
                name: format!("IfcProduct #{}", element_id),
                global_id: None,
                kind: "element".to_string(),
                has_children: false,
                element_count: None,
                elevation: None,
            })
        })
        .collect();
    Ok(QuickMetadataSpatialNode {
        summary: QuickMetadataEntitySummary {
            express_id: node.express_id,
            type_name: node.type_name.clone(),
            name: node.name.clone(),
            global_id: None,
            kind: "spatial".to_string(),
            has_children: !node.children.is_empty() || !node.elements.is_empty(),
            element_count: Some(node.elements.len()),
            elevation: node.elevation,
        },
        children,
        elements,
    })
}
