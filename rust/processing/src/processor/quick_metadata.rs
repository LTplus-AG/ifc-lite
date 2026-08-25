// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::types::response::{QuickMetadataEntitySummary, QuickMetadataSpatialNode};
use ifc_lite_core::{IfcType, IFC_TYPES};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

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

/// Which types the schema calls members of the spatial *structure* hierarchy.
///
/// `IfcProject` is the tree root and is an `IfcObject`, not a spatial element
/// at all. `IfcSpatialZone` is an `IfcSpatialElement` but NOT an
/// `IfcSpatialStructureElement`; it is carried deliberately since #1075 (Revit
/// / Dynamo GFA volumes attached with `IfcRelContainedInSpatialStructure`).
/// Everything else is exactly the `IfcSpatialStructureElement` closure -- the
/// branch whose `WR41` rule requires membership in the `IfcRelAggregates`
/// decomposition this tree is built from.
///
/// `IfcExternalSpatialElement` is deliberately NOT here even though it is an
/// `IfcSpatialElement`: it descends from `IfcExternalSpatialStructureElement`,
/// carries no `WR41`, and models a space *boundary* volume (external air,
/// ground) rather than a container. Admitting it would put a permanently
/// parentless node in the tree. The TypeScript half excludes it for the same
/// reason.
fn is_quick_spatial_type(ifc_type: IfcType) -> bool {
    matches!(ifc_type, IfcType::IfcProject | IfcType::IfcSpatialZone)
        || ifc_type.is_subtype_of(IfcType::IfcSpatialStructureElement)
}

/// The uppercase STEP keywords [`is_quick_spatial_type`] accepts, derived once
/// from the generated schema catalog.
///
/// This used to be fourteen names typed out by hand, and it was missing
/// `IfcMarineFacility`, `IfcMarinePart` and `IfcFacilityPartCommon` -- an IFC4.3
/// harbour lost its entire branch from the tree shown during load, while the
/// TypeScript builder (working from its own, differently-wrong hand list) kept
/// part of it, so the panel visibly gained a branch part-way through (#3275).
/// A hand list can only ever be as complete as whoever last audited the schema,
/// and `rooted_type.rs` made exactly this move for `IfcRoot` for exactly this
/// reason (#3015).
///
/// Materialised as a name slice rather than resolved per call: the gate runs
/// once for every entity in the scan loop, and `IfcType::from_str` normalises
/// to uppercase first, which allocates. A linear `eq_ignore_ascii_case` sweep
/// over ~17 short names is what the hand-written chain already cost, so the
/// derivation is free at the call site.
static QUICK_SPATIAL_TYPE_NAMES: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    IFC_TYPES
        .iter()
        .filter(|ifc_type| is_quick_spatial_type(**ifc_type))
        .map(|ifc_type| ifc_type.as_str())
        .collect()
});

/// Case-insensitive spatial-type check that avoids to_ascii_uppercase() allocation.
#[inline]
pub fn is_quick_spatial_type_ci(type_name: &str) -> bool {
    QUICK_SPATIAL_TYPE_NAMES
        .iter()
        .any(|candidate| type_name.eq_ignore_ascii_case(candidate))
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
    let mut ancestors = HashSet::new();
    build_quick_spatial_tree_node_inner(express_id, nodes, element_summaries, &mut ancestors)
}

/// A malformed IfcRelAggregates graph can make a spatial node its own
/// descendant; the recursion would then overflow the stack, an uncatchable
/// abort. `ancestors` holds the current root-to-node path, so a child already on
/// it is a back-edge: skip just that child and keep building the rest of the tree.
fn build_quick_spatial_tree_node_inner(
    express_id: u32,
    nodes: &HashMap<u32, QuickSpatialNodeEntry>,
    element_summaries: &HashMap<u32, QuickMetadataEntitySummary>,
    ancestors: &mut HashSet<u32>,
) -> Result<QuickMetadataSpatialNode, String> {
    let node = nodes
        .get(&express_id)
        .ok_or_else(|| format!("Quick spatial node #{express_id} not found"))?;
    ancestors.insert(express_id);
    let mut children = Vec::with_capacity(node.children.len());
    for child_id in &node.children {
        if ancestors.contains(child_id) {
            // Cyclic aggregate edge: skip this back-edge child, keep the rest.
            continue;
        }
        children.push(build_quick_spatial_tree_node_inner(
            *child_id,
            nodes,
            element_summaries,
            ancestors,
        )?);
    }
    ancestors.remove(&express_id);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: u32, children: Vec<u32>) -> QuickSpatialNodeEntry {
        QuickSpatialNodeEntry {
            express_id: id,
            type_name: "IfcSpace".to_string(),
            name: format!("#{id}"),
            elevation: None,
            children,
            elements: vec![],
            parent: None,
        }
    }

    // A malformed IfcRelAggregates graph making two nodes each other's child would
    // recurse forever (stack-overflow abort). The back-edge child is skipped and
    // the rest of the tree still builds.
    /// #2323 double-collapse guard. This module un-doubles `''` on its OWN
    /// raw-byte path (it never builds a `Token`, so `AttributeValue::from_token`
    /// never runs over the same bytes). Exactly ONE un-doubling pass must
    /// happen here: `''''` is two literal apostrophes, not one.
    #[test]
    fn parse_step_string_un_doubles_exactly_once() {
        assert_eq!(parse_step_string(b"'O''Brien'").as_deref(), Some("O'Brien"));
        assert_eq!(parse_step_string(b"''''''").as_deref(), Some("''"));
        // The decoder now collapses the doubled reverse solidus too, and this
        // path picks that up for free rather than needing its own pass.
        assert_eq!(parse_step_string(br"'C:\\temp'").as_deref(), Some(r"C:\temp"));
        // Unicode escapes still decode, and plain text is untouched.
        assert_eq!(parse_step_string(br"'caf\X2\00E9\X0\'").as_deref(), Some("caf\u{e9}"));
        assert_eq!(parse_step_string(b"'Plain Name'").as_deref(), Some("Plain Name"));
    }

    #[test]
    fn cyclic_aggregate_graph_does_not_stack_overflow() {
        let mut nodes = HashMap::new();
        nodes.insert(1, node(1, vec![2]));
        nodes.insert(2, node(2, vec![1]));
        let summaries = HashMap::new();
        let tree = build_quick_spatial_tree_node(1, &nodes, &summaries);
        assert!(tree.is_ok(), "cyclic tree should build (cycle pruned), got {tree:?}");
    }

    /// `IfcBuildingStorey`'s `Elevation` attribute sits at index 9 in the IFC4
    /// attribute layout this parser targets; index 8 is only a fallback (e.g. an
    /// off-by-one attribute count from a schema variant). Indices 8 and 9 hold
    /// DIFFERENT numeric values here specifically so a priority swap (checking 8
    /// before 9) is observable — equal values would let a `[9, 8]` -> `[8, 9]`
    /// swap pass silently.
    #[test]
    fn storey_elevation_prefers_index_9_over_index_8() {
        let args: Vec<&[u8]> = vec![
            b"$", b"$", b"$", b"$", b"$", b"$", b"$", b"$", b"3.5", b"7.25",
        ];
        assert_eq!(
            extract_storey_elevation_from_args(&args),
            Some(7.25),
            "index 9 (the real Elevation attribute) must win over index 8"
        );
    }
}
