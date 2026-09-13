// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::types::response::{
    QuickMetadataEntitySummary, QuickMetadataPrunedEdge, QuickMetadataPrunedEdgeKind as EdgeKind,
    QuickMetadataSpatialNode,
};
use ifc_lite_core::limits::LARGE_COORD_THRESHOLD_METERS;
use ifc_lite_core::{keyword_eq, IfcType, StepListItems, IFC_TYPES};
use std::collections::HashMap;
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

pub(super) fn build_quick_spatial_tree_node(
    express_id: u32,
    nodes: &HashMap<u32, QuickSpatialNodeEntry>,
    element_summaries: &HashMap<u32, QuickMetadataEntitySummary>,
) -> Result<(QuickMetadataSpatialNode, Vec<QuickMetadataPrunedEdge>), String> {
    let mut placed = HashMap::with_capacity(nodes.len());
    placed.insert(express_id, None);
    let mut pruned = Vec::new();
    build_subtree(express_id, nodes, element_summaries, &mut placed, &mut pruned)
        .map(|tree| (tree, pruned))
}

/// Each spatial node is emitted once, where the depth-first walk from the root
/// first reaches it. A malformed IfcRelAggregates graph can list a child twice,
/// under two parents, or as its own ancestor; all three are skipped and recorded
/// in `pruned` (#4662). `placed` spans the whole tree, not the root-to-node path
/// (k repeats per level would emit k^depth nodes): `None` while a node is still
/// being built, `Some(parent)` once it is finished.
fn build_subtree(
    express_id: u32,
    nodes: &HashMap<u32, QuickSpatialNodeEntry>,
    element_summaries: &HashMap<u32, QuickMetadataEntitySummary>,
    placed: &mut HashMap<u32, Option<u32>>,
    pruned: &mut Vec<QuickMetadataPrunedEdge>,
) -> Result<QuickMetadataSpatialNode, String> {
    let node = nodes
        .get(&express_id)
        .ok_or_else(|| format!("Quick spatial node #{express_id} not found"))?;
    let mut children = Vec::with_capacity(node.children.len());
    for &child_id in &node.children {
        if let Some(&seen) = placed.get(&child_id) {
            let kind = match seen {
                None => EdgeKind::BackEdge,
                Some(parent) if parent == express_id => EdgeKind::SiblingRepeat,
                Some(_) => EdgeKind::SecondParent,
            };
            pruned.push(QuickMetadataPrunedEdge {
                parent_express_id: express_id,
                child_express_id: child_id,
                kind,
            });
            continue;
        }
        placed.insert(child_id, None);
        children.push(build_subtree(child_id, nodes, element_summaries, placed, pruned)?);
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

    // A malformed IfcRelAggregates graph making two nodes each other's child would
    // recurse forever (stack-overflow abort). The back-edge child is skipped and
    // the rest of the tree still builds.
    #[test]
    fn cyclic_aggregate_graph_does_not_stack_overflow() {
        let mut nodes = HashMap::new();
        nodes.insert(1, node(1, vec![2]));
        nodes.insert(2, node(2, vec![1]));
        let summaries = HashMap::new();
        let tree = build_quick_spatial_tree_node(1, &nodes, &summaries);
        assert!(tree.is_ok(), "cyclic tree should build (cycle pruned), got {tree:?}");
        // #2 lists only the pruned back-edge, so it must not advertise children
        // it does not carry (its report is pinned in quick_metadata_aggregate_dedupe.rs).
        let two = &tree.unwrap().0.children[0];
        assert!(two.children.is_empty() && !two.summary.has_children);
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

    /// DRIFT GUARD. `is_quick_spatial_type_ci` decides which entities become
    /// nodes of the quick-metadata spatial tree. Since #3275 the name list is no
    /// longer written by hand — it is derived from the rule below against the
    /// GENERATED schema: `IfcProject`, plus everything in the `IfcSpatialElement`
    /// branch except the external-spatial (air volume) sub-branch, which is not
    /// part of the containment hierarchy. This test therefore no longer catches a
    /// typo in a list; it catches the derivation being rewritten back into one,
    /// and it is the place the rule itself is stated in reviewable form.
    ///
    /// Checked in BOTH directions over every generated `IfcType`: a name the rule
    /// admits and the predicate rejects severs that subtree from the tree; a name
    /// the predicate admits and the rule rejects invents a spatial node.
    #[test]
    fn quick_spatial_predicate_matches_the_generated_spatial_branch() {
        use ifc_lite_core::{IfcType, IFC_TYPES};

        fn rule(ty: IfcType) -> bool {
            ty == IfcType::IfcProject
                || (ty.is_subtype_of(IfcType::IfcSpatialElement)
                    && !ty.is_subtype_of(IfcType::IfcExternalSpatialStructureElement))
        }

        let mut expected_true = 0usize;
        let mut missing = Vec::new();
        let mut extra = Vec::new();
        for ty in IFC_TYPES {
            let name = ty.as_str();
            let want = rule(*ty);
            if want {
                expected_true += 1;
            }
            let got = is_quick_spatial_type_ci(name);
            if want && !got {
                missing.push(name);
            }
            if !want && got {
                extra.push(name);
            }
        }

        // Anti-vacuity: the enumeration really ran over the whole schema, and the
        // rule really selects a non-trivial slice of it. A `IFC_TYPES` that came
        // back empty, or a rule that matched nothing, would otherwise pass.
        assert!(
            IFC_TYPES.len() > 800,
            "generated IFC_TYPES looks truncated: {} entries",
            IFC_TYPES.len()
        );
        assert!(
            expected_true >= 17,
            "the spatial branch should cover at least 17 types, got {expected_true}"
        );

        assert!(
            missing.is_empty() && extra.is_empty(),
            "quick-metadata spatial predicate has drifted from the generated schema\n  \
             missing (severed from the spatial tree): {missing:?}\n  \
             extra (invented spatial nodes): {extra:?}"
        );
    }

    /// #4687: a comment is trivia for the attribute split. A comma in one
    /// shifted every later attribute, an apostrophe in one opened a string
    /// for the rest of the record, and one inside a ref list hid the ref.
    #[test]
    fn issue_4687_step_arguments_treat_comments_as_trivia() {
        for record in [
            &b"#50=IFCRELAGGREGATES('0YvctVUKr0kugbFTf53O9L',$,$,/* a, b */$,#1,(#2,#3));"[..],
            b"#50=IFCRELAGGREGATES('0YvctVUKr0kugbFTf53O9L',$,$,/* it's */$,#1,(#2,#3));",
            b"#50=IFCRELAGGREGATES('0YvctVUKr0kugbFTf53O9L',$,$,$,#1 /* x */,(#2, /* door */ #3));",
        ] {
            let args = parse_step_arguments(record);
            let text = String::from_utf8_lossy(record);
            assert_eq!(args.len(), 6, "{text}");
            assert_eq!(args.get(4).and_then(|token| parse_step_ref(token)), Some(1), "{text}");
            assert_eq!(parse_step_ref_list(args[5]), [2, 3], "{text}");
        }
    }

    /// Control fixture for the drift guard above. A regression that made the
    /// predicate answer `true` for everything, or that dropped its
    /// case-insensitivity, would still satisfy a one-directional check.
    #[test]
    fn quick_spatial_predicate_controls() {
        // Non-spatial products and relationships are NOT tree nodes.
        for name in ["IFCWALL", "IFCRELAGGREGATES", "IFCPROJECTLIBRARY", "IFCZONE"] {
            assert!(!is_quick_spatial_type_ci(name), "{name} must not be a spatial node");
        }
        // External spatial elements are air volumes, deliberately excluded.
        for name in ["IFCEXTERNALSPATIALELEMENT", "IFCEXTERNALSPATIALSTRUCTUREELEMENT"] {
            assert!(!is_quick_spatial_type_ci(name), "{name} must not be a spatial node");
        }
        // Both spellings a STEP file may use resolve identically.
        for name in ["IfcMarineFacility", "IFCMARINEFACILITY", "ifcmarinefacility"] {
            assert!(is_quick_spatial_type_ci(name), "{name} must be a spatial node");
        }
    }
}
