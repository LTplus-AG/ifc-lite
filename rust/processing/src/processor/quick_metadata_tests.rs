// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

fn node(id: u32, children: Vec<u32>) -> QuickSpatialNodeEntry {
    QuickSpatialNodeEntry {
        express_id: id,
        type_name: "IfcSpace".to_string(),
        name: format!("#{id}"),
        elevation: None,
        children,
        contained: vec![],
        elements: vec![],
        named_as_child: false,
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

/// A node cut at the depth limit is still placed where a shorter path
/// reaches it, whichever of the two the walk meets first (#4689).
#[test]
fn depth_limited_child_is_placed_by_a_shorter_path() {
    let deep = MAX_QUICK_SPATIAL_TREE_DEPTH as u32;
    let leaf = deep + 1;
    let summaries = HashMap::new();
    for root_children in [vec![1, leaf], vec![leaf, 1]] {
        // 0 -> 1 -> ... -> deep -> leaf, and the root also names leaf.
        let mut nodes: HashMap<u32, QuickSpatialNodeEntry> =
            (1..=deep).map(|id| (id, node(id, vec![id + 1]))).collect();
        nodes.insert(0, node(0, root_children.clone()));
        nodes.insert(leaf, node(leaf, vec![]));
        let (root, pruned) = build_quick_spatial_tree_node(0, &nodes, &summaries).unwrap();
        assert!(
            root.children.iter().any(|c| c.summary.express_id == leaf),
            "root children {root_children:?}: #{leaf} is placed under the root"
        );
        assert_eq!(
            pruned.len(),
            1,
            "root children {root_children:?}: {pruned:?}"
        );
        assert_eq!(
            (pruned[0].parent_express_id, pruned[0].child_express_id),
            (deep, leaf)
        );
    }
}

/// A space whose only aggregate is an orphan's, contained both at the end of
/// a chain the depth limit cuts and by a shallow node, stays in the tree
/// through the shallow containment (#4689).
#[test]
fn fallback_containment_past_the_depth_limit_does_not_hide_a_shallow_one() {
    let last = 10 + MAX_QUICK_SPATIAL_TREE_DEPTH as u32 + 9;
    let (shallow, space, orphan) = (300, 500, 600);
    let mut nodes: HashMap<u32, QuickSpatialNodeEntry> =
        (10..last).map(|id| (id, node(id, vec![id + 1]))).collect();
    let mut deep_end = node(last, vec![]);
    deep_end.contained = vec![space];
    nodes.insert(last, deep_end);
    let mut shallow_node = node(shallow, vec![]);
    shallow_node.contained = vec![space];
    nodes.insert(shallow, shallow_node);
    nodes.insert(space, node(space, vec![]));
    nodes.insert(orphan, node(orphan, vec![space]));
    nodes.insert(0, node(0, vec![shallow, 10]));
    let (root, _) = build_quick_spatial_tree_node(0, &nodes, &HashMap::new()).unwrap();
    let shallow_node = root
        .children
        .iter()
        .find(|c| c.summary.express_id == shallow);
    assert!(
        shallow_node.is_some_and(|n| n.children.iter().any(|c| c.summary.express_id == space)),
        "#{space} is placed under #{shallow}"
    );
}

/// The same space, but its shallow containment sits below two nodes that are
/// themselves placed only through containments of orphan-aggregated nodes. It
/// still keeps that containment and stays in the tree (#4689).
#[test]
fn unsettled_space_keeps_a_shallow_containment_found_late() {
    fn contains(node: &QuickMetadataSpatialNode, id: u32) -> bool {
        node.summary.express_id == id || node.children.iter().any(|c| contains(c, id))
    }
    let last = 10 + MAX_QUICK_SPATIAL_TREE_DEPTH as u32 + 9;
    let with_contained = |id: u32, contained: Vec<u32>| QuickSpatialNodeEntry {
        contained,
        ..node(id, vec![])
    };
    let mut nodes: HashMap<u32, QuickSpatialNodeEntry> =
        (10..last).map(|id| (id, node(id, vec![id + 1]))).collect();
    nodes.insert(last, with_contained(last, vec![500]));
    nodes.insert(1, with_contained(1, vec![400]));
    nodes.insert(400, with_contained(400, vec![300]));
    nodes.insert(300, with_contained(300, vec![500]));
    nodes.insert(500, node(500, vec![]));
    nodes.insert(600, node(600, vec![400, 300]));
    nodes.insert(601, node(601, vec![500]));
    nodes.insert(0, node(0, vec![1, 10]));
    let (root, _) = build_quick_spatial_tree_node(0, &nodes, &HashMap::new()).unwrap();
    assert!(contains(&root, 500), "#500 is in the tree");
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
