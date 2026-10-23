// SPDX-License-Identifier: MPL-2.0
use std::collections::HashSet;

use crate::plan::index::FileIndex;
use super::resolve_deletes;
use crate::plan::test_fixtures::{project_aggregates_one_building, wall_with_own_pset};

#[test]
fn deleting_a_wall_removes_its_unshared_pset_via_the_rel() {
    for schema in ["IFC2X3", "IFC4", "IFC4X3"] {
        let content = wall_with_own_pset(schema);
        let index = FileIndex::complete(&content);
        let requested: HashSet<u32> = [10].into_iter().collect();
        let result = resolve_deletes(&index, schema, &requested, &[], &HashSet::new());

        assert!(result.removed.contains(&10), "{schema}: the wall itself");
        // The rel's RelatedObjects held only #10: emptying it takes the rel
        // out (mandatory SET), which then leaves the pset with no referrer.
        assert!(result.removed.contains(&32), "{schema}: the now-empty rel");
        assert!(result.removed.contains(&31), "{schema}: the pset, unreachable once the rel is gone");
        assert!(result.removed.contains(&30), "{schema}: the property, unreachable once the pset is gone");
        // Everything upstream of the wall (project, units, context) survives.
        assert!(!result.removed.contains(&1), "{schema}: the project root is protected");
        assert!(!result.removed.contains(&50), "{schema}: the unit assignment is untouched");
    }
}

#[test]
fn deleting_one_of_two_walls_sharing_a_pset_keeps_the_pset_and_shrinks_the_rel() {
    use crate::plan::test_fixtures::two_walls_sharing_a_pset;
    let schema = "IFC4";
    let content = two_walls_sharing_a_pset(schema);
    let index = FileIndex::complete(&content);
    let requested: HashSet<u32> = [10].into_iter().collect();
    let result = resolve_deletes(&index, schema, &requested, &[], &HashSet::new());

    assert!(result.removed.contains(&10));
    assert!(!result.removed.contains(&32), "the rel survives: it still relates #11");
    assert!(!result.removed.contains(&31), "the shared pset survives");
    assert!(!result.removed.contains(&30), "the shared property survives");
    let stripped = result.stripped.get(&(32, 4)).expect("RelatedObjects was rewritten");
    assert_eq!(stripped, &[10].into_iter().collect());
}

#[test]
fn deleting_the_aggregated_building_drops_the_now_empty_aggregation() {
    let schema = "IFC4";
    let content = project_aggregates_one_building(schema);
    let index = FileIndex::complete(&content);
    let requested: HashSet<u32> = [60].into_iter().collect();
    let result = resolve_deletes(&index, schema, &requested, &[], &HashSet::new());

    assert!(result.removed.contains(&60));
    assert!(result.removed.contains(&61), "RelatedObjects would go empty, so the rel goes too");
    assert!(!result.removed.contains(&1), "the project is a protected root, not merely unreferenced");
}

/// Fail the guard on purpose: an entity type this rule does not recognise as
/// carrying a mandatory members set survives with an EMPTY list rather than
/// being cascaded, proving `is_mandatory_members_attr` is doing real work and
/// not defaulting to "always cascade".
#[test]
fn a_non_rel_list_attribute_is_stripped_but_never_cascades() {
    // IfcUnitAssignment.Units is a list on a non-IFCREL entity: deleting its
    // one member must strip it from the list, never remove the assignment.
    let schema = "IFC4";
    let content = wall_with_own_pset(schema);
    let index = FileIndex::complete(&content);
    let requested: HashSet<u32> = [51].into_iter().collect();
    let result = resolve_deletes(&index, schema, &requested, &[], &HashSet::new());

    assert!(result.removed.contains(&51));
    assert!(!result.removed.contains(&50), "IfcUnitAssignment is not an IFCREL* entity, so it never cascades");
    let stripped = result.stripped.get(&(50, 0)).expect("Units was rewritten");
    assert_eq!(stripped, &[51].into_iter().collect());
}

#[test]
fn deleting_the_only_covering_drops_the_now_empty_covers_relationship() {
    use crate::plan::test_fixtures::wall_with_one_covering;
    for schema in ["IFC2X3", "IFC4", "IFC4X3"] {
        let content = wall_with_one_covering(schema);
        let index = FileIndex::complete(&content);
        let requested: HashSet<u32> = [12].into_iter().collect();
        let result = resolve_deletes(&index, schema, &requested, &[], &HashSet::new());
        assert!(result.removed.contains(&13), "{schema}: RelatedCoverings is SET [1:?], so the rel goes");
    }
}

/// A presentation layer's `AssignedItems` is `SET [1:?]`: stripping its last
/// entry takes the layer out rather than writing `()`. One that keeps an
/// entry is rewritten.
#[test]
fn a_layer_whose_last_item_is_stripped_goes() {
    use crate::plan::test_fixtures::products_with_geometry;
    for schema in ["IFC2X3", "IFC4", "IFC4X3"] {
        let content = products_with_geometry(schema);
        let index = FileIndex::complete(&content);
        let idx = crate::plan::attrs::attribute_index(schema, "IFCPRESENTATIONLAYERASSIGNMENT", "AssignedItems").unwrap();
        let detach = [(83, idx, 62), (80, idx, 62)];
        let result = resolve_deletes(&index, schema, &HashSet::new(), &detach, &HashSet::new());
        assert!(result.removed.contains(&83), "{schema}: the emptied layer");
        assert!(!result.removed.contains(&80), "{schema}: the layer with items left");
        assert_eq!(result.stripped.get(&(80, idx)), Some(&[62].into_iter().collect()), "{schema}");
    }
}
