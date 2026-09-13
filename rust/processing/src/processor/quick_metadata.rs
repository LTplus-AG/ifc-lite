// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::types::response::{
    QuickMetadataEntitySummary, QuickMetadataPrunedEdge, QuickMetadataPrunedEdgeKind as EdgeKind,
    QuickMetadataSpatialNode,
};
use ifc_lite_core::limits::LARGE_COORD_THRESHOLD_METERS;
use ifc_lite_core::{keyword_eq, IfcType, StepListItems, IFC_TYPES};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

#[derive(Clone)]
pub(super) struct QuickSpatialNodeEntry {
    pub(super) express_id: u32,
    pub(super) type_name: String,
    pub(super) name: String,
    pub(super) elevation: Option<f64>,
    /// `IfcRelAggregates` children.
    pub(super) children: Vec<u32>,
    /// Spatial elements an `IfcRelContainedInSpatialStructure` names, promoted
    /// to child nodes (#1075). Kept apart from `children`: they are not
    /// aggregate edges, and an aggregate that places the same node wins.
    pub(super) contained: Vec<u32>,
    pub(super) elements: Vec<u32>,
    /// Some aggregate or spatial containment edge lists this node as a child.
    /// Read only to pick a root when the file has no `IfcProject`.
    pub(super) named_as_child: bool,
}

/// Which types the schema calls nodes of the quick-metadata spatial tree.
///
/// `IfcProject` is the tree root and is an `IfcObject`, not a spatial element at
/// all. Everything else is the whole `IfcSpatialElement` branch EXCEPT the
/// external-spatial sub-branch (`IfcExternalSpatialElement` and friends), which
/// models a space *boundary* volume -- external air, ground -- rather than a
/// container, carries no `WR41`, and would sit permanently parentless in a tree
/// built from `IfcRelAggregates`. The TypeScript half excludes it for the same
/// reason. `IfcSpatialZone` is inside the branch and outside
/// `IfcSpatialStructureElement`; it is carried deliberately since #1075 (Revit /
/// Dynamo GFA volumes attached with `IfcRelContainedInSpatialStructure`).
fn is_quick_spatial_type(ifc_type: IfcType) -> bool {
    ifc_type == IfcType::IfcProject
        || (ifc_type.is_subtype_of(IfcType::IfcSpatialElement)
            && !ifc_type.is_subtype_of(IfcType::IfcExternalSpatialStructureElement))
}

/// The uppercase STEP keywords [`is_quick_spatial_type`] accepts, derived once
/// from the generated schema catalog.
///
/// This used to be a name list typed out by hand, and it had already been caught
/// missing `IfcMarineFacility`, `IfcMarinePart` and `IfcFacilityPartCommon`
/// (#3245): an IFC4.3 harbour lost its entire branch from the tree shown during
/// load. A hand list can only ever be as complete as whoever last audited the
/// schema, so the list is no longer written down -- it is derived from the rule,
/// the same move `rooted_type.rs` made for `IfcRoot` for the same reason (#3015).
///
/// Materialised as a name slice rather than resolved per call: the gate runs
/// once for every entity in the scan loop, and `IfcType::from_str` normalises to
/// uppercase first, which allocates. A linear `keyword_eq` sweep over
/// ~18 short names is what the hand-written chain already cost, so the
/// derivation is free at the call site.
static QUICK_SPATIAL_TYPE_NAMES: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    IFC_TYPES
        .iter()
        .filter(|ifc_type| is_quick_spatial_type(**ifc_type))
        .map(|ifc_type| ifc_type.as_str())
        .collect()
});

/// Is this STEP keyword a node of the quick-metadata spatial tree?
///
/// Case-insensitive without allocating an uppercase copy. A name this predicate
/// misses is not just skipped -- every `IfcRelAggregates` edge into or out of it
/// is dropped too, so its entire subtree is severed from the tree.
#[inline]
pub fn is_quick_spatial_type_ci(type_name: &str) -> bool {
    QUICK_SPATIAL_TYPE_NAMES
        .iter()
        .any(|candidate| keyword_eq(type_name, candidate))
}

/// A record's top-level attributes, trimmed of STEP trivia. The split is
/// core's [`StepListItems`], so a comment is trivia here too (#4687).
pub(super) fn parse_step_arguments(entity_bytes: &[u8]) -> Vec<&[u8]> {
    StepListItems::of_record(entity_bytes).map(Iterator::collect).unwrap_or_default()
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
    match StepListItems::of_list(token) {
        Some(items) => items.filter_map(parse_step_ref).collect(),
        None => parse_step_ref(token).into_iter().collect(),
    }
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
    // A storey elevation is a local coordinate: the first numeric attribute
    // inside the large-coordinate threshold is taken, anything beyond it is a
    // world coordinate (a georeferenced placement, not an elevation).
    args.iter()
        .filter_map(|token| std::str::from_utf8(token.trim_ascii()).ok())
        .filter_map(|token| token.parse::<f64>().ok())
        .find(|value| value.abs() < LARGE_COORD_THRESHOLD_METERS)
}

/// Deepest level of the quick-metadata spatial tree; the root is level 0. The
/// builder and the derived `Clone`, `Serialize` and `Drop` of
/// [`QuickMetadataSpatialNode`] each recurse once per level, so an acyclic
/// aggregate chain of 100 000 nodes overflowed the stack and aborted (#4689);
/// making the builder iterative alone would leave the other three. A child of a
/// node at this level is left out and reported as a depth-limit edge.
///
/// Not the server's and viewer's `MAX_SPATIAL_TREE_DEPTH` of 100: their tree is
/// flat on the wire, while this one nests two JSON levels (node, `children`)
/// per tree level, and `serde_json` refuses input nested deeper than 128. At 60
/// the bootstrap still reads back through its own `Deserialize` with room for
/// an envelope; `quick_metadata_deep_chain.rs` pins that round trip.
const MAX_QUICK_SPATIAL_TREE_DEPTH: usize = 60;

pub(super) fn build_quick_spatial_tree_node(
    express_id: u32,
    nodes: &HashMap<u32, QuickSpatialNodeEntry>,
    element_summaries: &HashMap<u32, QuickMetadataEntitySummary>,
) -> Result<(QuickMetadataSpatialNode, Vec<QuickMetadataPrunedEdge>), String> {
    let mut placed = HashMap::with_capacity(nodes.len());
    placed.insert(express_id, None);
    let mut pruned = Vec::new();
    let containment = ContainmentPlan::new(express_id, nodes);
    build_subtree(
        express_id,
        0,
        nodes,
        element_summaries,
        &containment,
        &mut placed,
        &mut pruned,
    )
    .map(|tree| (tree, pruned))
}

/// Which promoted containment edges the tree walk follows (#4689).
///
/// A containment of a node no `IfcRelAggregates` names is always followed. A
/// containment of an aggregated node is followed unless the node is settled:
/// reached from the root through aggregates and those always-followed
/// containments alone. So an aggregate from a settled parent, including one
/// placed by an ordinary containment, places the node, while a node whose
/// aggregates come only from orphans, from its own descendants, or from other
/// unsettled nodes keeps every containment, and the walk's order picks among
/// them. Not depth-aware: a containment of a settled node is not followed even
/// when the depth limit cuts the aggregate path. One pass, each node and edge
/// visited once.
struct ContainmentPlan {
    settled: HashSet<u32>,
}

impl ContainmentPlan {
    fn new(root: u32, nodes: &HashMap<u32, QuickSpatialNodeEntry>) -> Self {
        let aggregated: HashSet<u32> = nodes
            .values()
            .flat_map(|n| n.children.iter().copied())
            .collect();
        let mut reached = HashSet::from([root]);
        let mut stack = vec![root];
        while let Some(id) = stack.pop() {
            let Some(node) = nodes.get(&id) else { continue };
            let contained = node.contained.iter().filter(|c| !aggregated.contains(c));
            for &child in node.children.iter().chain(contained) {
                if reached.insert(child) {
                    stack.push(child);
                }
            }
        }
        reached.retain(|id| aggregated.contains(id));
        Self { settled: reached }
    }

    fn follows(&self, child: u32) -> bool {
        !self.settled.contains(&child)
    }
}

/// Each spatial node is emitted once, where the depth-first walk from the root
/// first reaches it, aggregate children before the contained ones `containment`
/// follows; a skipped containment is not recorded (it is not an aggregate
/// edge). A
/// malformed IfcRelAggregates graph can list a child twice,
/// under two parents, or as its own ancestor; all three are skipped and recorded
/// in `pruned` (#4662). `placed` spans the whole tree, not the root-to-node path
/// (k repeats per level would emit k^depth nodes): `None` while a node is still
/// being built, `Some(parent)` once it is finished. With each node built once,
/// the walk visits every child edge at most once, so `depth` is the only bound
/// it still needs.
fn build_subtree(
    express_id: u32,
    depth: usize,
    nodes: &HashMap<u32, QuickSpatialNodeEntry>,
    element_summaries: &HashMap<u32, QuickMetadataEntitySummary>,
    containment: &ContainmentPlan,
    placed: &mut HashMap<u32, Option<u32>>,
    pruned: &mut Vec<QuickMetadataPrunedEdge>,
) -> Result<QuickMetadataSpatialNode, String> {
    let node = nodes
        .get(&express_id)
        .ok_or_else(|| format!("Quick spatial node #{express_id} not found"))?;
    let mut children = Vec::with_capacity(node.children.len() + node.contained.len());
    let aggregated = node.children.iter().map(|&id| (id, true));
    let contained = node.contained.iter().map(|&id| (id, false));
    for (child_id, via_aggregate) in aggregated.chain(contained) {
        if !via_aggregate && (placed.contains_key(&child_id) || !containment.follows(child_id)) {
            continue;
        }
        let skipped = match placed.get(&child_id) {
            Some(None) => Some(EdgeKind::BackEdge),
            Some(Some(parent)) if *parent == express_id => Some(EdgeKind::SiblingRepeat),
            Some(Some(_)) => Some(EdgeKind::SecondParent),
            // Not marked placed: a shorter path met later may still place it.
            None if depth == MAX_QUICK_SPATIAL_TREE_DEPTH => Some(EdgeKind::DepthLimit),
            None => None,
        };
        if let Some(kind) = skipped {
            pruned.push(QuickMetadataPrunedEdge {
                parent_express_id: express_id,
                child_express_id: child_id,
                kind,
            });
            continue;
        }
        placed.insert(child_id, None);
        children.push(build_subtree(
            child_id,
            depth + 1,
            nodes,
            element_summaries,
            containment,
            placed,
            pruned,
        )?);
        placed.insert(child_id, Some(express_id));
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
            has_children: !children.is_empty() || !node.elements.is_empty(),
            element_count: Some(node.elements.len()),
            elevation: node.elevation,
        },
        children,
        elements,
    })
}

#[cfg(test)]
#[path = "quick_metadata_tests.rs"]
mod tests;
