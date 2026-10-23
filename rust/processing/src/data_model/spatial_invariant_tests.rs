// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for `spatial_hierarchy_consistency_violations`, split into a sibling
//! `_tests.rs` file (matching `spatial_tests.rs`'s split off `spatial.rs`) so
//! the checked-in tests live in a file the repo's own tooling recognizes as a
//! test file, not folded into the production module's line count or hidden
//! from tools that classify coverage by file name.

use super::*;

/// Builds a minimal, otherwise-valid `SpatialNode` for constructing
/// hand-crafted hierarchies - only `entity_id`, `parent_id`, `level` and
/// `children_ids` matter to this invariant.
fn node(entity_id: u32, parent_id: u32, level: u16, children_ids: &[u32]) -> SpatialNode {
    SpatialNode {
        entity_id,
        parent_id,
        level,
        path: String::new(),
        type_name: "IFCBUILDINGSTOREY".to_string(),
        name: None,
        elevation: None,
        children_ids: children_ids.to_vec(),
        element_ids: Vec::new(),
    }
}

/// The negative case: a well-formed, multi-level hierarchy (project -> site
/// and building -> storey, each `level` matching its actual depth, every
/// `children_ids`/`parent_id` pair agreeing) must report zero violations.
/// Without this, a checker that fires on every input would pass every other
/// test here just as well as a correct one - this is what tells the two
/// apart.
#[test]
fn a_well_formed_multi_level_hierarchy_reports_no_violations() {
    let project = node(1, 0, 0, &[2, 3]);
    let site = node(2, 1, 1, &[]);
    let building = node(3, 1, 1, &[4]);
    let storey = node(4, 3, 2, &[]);
    let nodes = [&project, &site, &building, &storey];
    assert_eq!(
        spatial_hierarchy_consistency_violations(&nodes),
        Vec::<String>::new(),
        "a well-formed hierarchy must not be flagged"
    );
}

/// #4022 class 1, taken verbatim from the issue: a second, fully
/// disconnected root that is internally consistent and reachable from
/// itself - documented above as out of scope, since it is
/// indistinguishable from a legitimate rescued-orphan island. This test
/// pins that scope decision so it does not regress silently.
#[test]
fn a_second_disconnected_but_internally_consistent_root_is_not_flagged() {
    let real_root = node(1, 0, 0, &[]);
    let island_root = node(100, 0, 0, &[101]);
    let island_child = node(101, 100, 1, &[]);
    let nodes = [&real_root, &island_root, &island_child];
    assert_eq!(
        spatial_hierarchy_consistency_violations(&nodes),
        Vec::<String>::new(),
        "a second self-consistent root is legitimate (see DISCONNECTED_SITE_AGGREGATES_BUILDING_IFC \
         in tests.rs) and must not be flagged"
    );
}

/// #4022 class 2, taken verbatim from the issue: a 2-node cycle isolated
/// from any root. Neither node has `parent_id == 0` anywhere in its
/// ancestry, so the reachability walk never enqueues either one.
#[test]
fn a_cycle_isolated_from_any_root_is_flagged_as_unreachable() {
    let a = node(10, 11, 0, &[11]);
    let b = node(11, 10, 0, &[10]);
    let nodes = [&a, &b];
    let violations = spatial_hierarchy_consistency_violations(&nodes);
    assert!(
        violations.iter().any(|v| v.contains("node #10") && v.contains("unreachable")),
        "expected node #10 to be reported unreachable, got: {violations:?}"
    );
    assert!(
        violations.iter().any(|v| v.contains("node #11") && v.contains("unreachable")),
        "expected node #11 to be reported unreachable, got: {violations:?}"
    );
}

/// A single node unreachable from any root - not part of a cycle, just an
/// island with no `parent_id == 0` in its ancestry at all (its `parent_id`
/// points at itself's own... no, simpler: it points nowhere reachable
/// because its only "parent" is itself, and it lists itself as its own
/// child). This isolates the reachability clause from the level clause: the
/// node's `level` is 0, matching what a root's depth would be, so if the
/// reachability check were disabled but the level check were not, this
/// shape would still slip through - it is the level check's blind spot
/// mirrored, pinning that the reachability clause is independently load-bearing.
#[test]
fn a_self_referential_node_with_no_path_to_any_root_is_flagged_as_unreachable() {
    let orphan = node(50, 50, 0, &[50]);
    let nodes = [&orphan];
    let violations = spatial_hierarchy_consistency_violations(&nodes);
    assert!(
        violations.iter().any(|v| v.contains("node #50") && v.contains("unreachable")),
        "expected node #50 to be reported unreachable, got: {violations:?}"
    );
}

/// #4022 class 3, taken verbatim from the issue: a child whose `level`
/// disagrees with its actual depth from the root.
#[test]
fn a_level_that_disagrees_with_actual_depth_is_flagged() {
    let root = node(1, 0, 0, &[2]);
    let wrong_level_child = node(2, 1, 47, &[]);
    let nodes = [&root, &wrong_level_child];
    let violations = spatial_hierarchy_consistency_violations(&nodes);
    assert!(
        violations
            .iter()
            .any(|v| v.contains("node #2") && v.contains("level 47") && v.contains("depth 1")),
        "expected node #2's level/depth mismatch to be reported, got: {violations:?}"
    );
}

/// Re-confirms the first historical #3973 shape still fires: a
/// depth-capped entity resurrected as a fake root (`parent_id: 0`) while
/// its last surviving ancestor's `children_ids` still names it - clause
/// (c) alone already catches this, and the #4022 additions must not
/// weaken that.
#[test]
fn the_depth_cap_fake_root_resurrection_shape_still_fires() {
    let ancestor = node(101, 1, 100, &[102]); // still lists the dropped child
    let root = node(1, 0, 0, &[101]);
    let fake_root = node(102, 0, 0, &[]); // resurrected at parent_id 0 instead of dropped
    let nodes = [&root, &ancestor, &fake_root];
    let violations = spatial_hierarchy_consistency_violations(&nodes);
    assert!(
        violations.iter().any(|v| v.contains("node #101") && v.contains("#102")),
        "expected the disagreeing parent_id/children_ids pair to be reported, got: {violations:?}"
    );
}

/// Re-confirms the second historical #3973 shape still fires: a rescued
/// orphan's `children_ids` populated straight from the containment map
/// with no filtering, naming a child that has no `SpatialNode` of its
/// own (clause (a)).
#[test]
fn the_rescued_orphan_dangling_child_shape_still_fires() {
    let root = node(1, 0, 0, &[]);
    // Site is rescued as a fake root (parent_id 0) but its children_ids
    // still names Building (#3), which was never given its own node.
    let rescued_site = node(2, 0, 0, &[3]);
    let nodes = [&root, &rescued_site];
    let violations = spatial_hierarchy_consistency_violations(&nodes);
    assert!(
        violations.iter().any(|v| v.contains("node #2") && v.contains("#3") && v.contains("no node")),
        "expected the dangling children_ids reference to be reported, got: {violations:?}"
    );
}
