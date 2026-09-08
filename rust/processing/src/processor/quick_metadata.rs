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
/// uppercase first, which allocates. A linear `eq_ignore_ascii_case` sweep over
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
