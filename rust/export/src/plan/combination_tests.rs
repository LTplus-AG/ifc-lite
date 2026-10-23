// SPDX-License-Identifier: MPL-2.0
//! Plans whose dispositions meet on the same records: two writes to one set,
//! a delete and a write on one member list, a clone reusing members the
//! delete cascade would otherwise prune, and inputs the executor must refuse
//! rather than write.

use std::collections::HashMap;

use ifc_lite_core::EntityScanner;

use super::execute;
use super::test_fixtures::{two_sets_on_one_wall_sharing_a_leaf, two_walls_sharing_a_pset, wall_with_own_pset};
use super::types::*;

const SCHEMAS: [&str; 2] = ["IFC2X3", "IFC4"];

fn entity_lines(content: &[u8]) -> HashMap<u32, String> {
    let mut out = HashMap::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, _type, s, e)) = scanner.next_entity() {
        out.insert(id, String::from_utf8_lossy(&content[s..e]).trim_end().to_string());
    }
    out
}

fn prop(pset: &str, prop: &str, measure: &str, literal: &str) -> PropWrite {
    PropWrite {
        pset: pset.into(),
        prop: prop.into(),
        measure_type: measure.into(),
        literal: literal.into(),
        unit: None,
        kind: PsetKind::Property,
        scope: PropScope::Occurrence,
    }
}

fn patch(id: u32, psets: Vec<PropWrite>) -> (ObjectRef, Disposition) {
    (ObjectRef::Id(id), Disposition::Patch(Patch { psets, ..Default::default() }))
}

fn run(content: &[u8], dispositions: Vec<(ObjectRef, Disposition)>) -> (WriteReport, HashMap<u32, String>) {
    let plan = ExportPlan { dispositions, context: PlanContext::default() };
    let mut out = Vec::new();
    let report = execute(content, &plan, &mut out).unwrap();
    (report, entity_lines(&out))
}

/// The id of the one record whose text contains `needle`.
fn id_of(after: &HashMap<u32, String>, needle: &str) -> u32 {
    let found: Vec<u32> = after.iter().filter(|(_, l)| l.contains(needle)).map(|(id, _)| *id).collect();
    assert_eq!(found.len(), 1, "{needle}: {found:?}");
    found[0]
}

/// Adds a second member `#35` (`IsExternal`) to the fixture's set `#31`.
fn with_second_member(content: Vec<u8>) -> Vec<u8> {
    String::from_utf8(content)
        .unwrap()
        .replace("(#30));", "(#30,#35));")
        .replace("ENDSEC;\nEND-ISO-10303-21;", "#35=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);\nENDSEC;\nEND-ISO-10303-21;")
        .into_bytes()
}

/// Deleting one wall of a two-wall group and patching the other empties the
/// group's relationship, but the patched wall's clone still lists `#35`.
#[test]
fn a_clone_keeps_the_members_it_reuses_when_its_group_is_deleted() {
    for schema in SCHEMAS {
        let content = with_second_member(two_walls_sharing_a_pset(schema));
        let (report, after) = run(
            &content,
            vec![(ObjectRef::Id(10), Disposition::Delete), patch(11, vec![prop("Pset_WallCommon", "FireRating", "IFCLABEL", "'2HR'")])],
        );
        assert!(report.findings.is_empty(), "{schema}: {:?}", report.findings);
        assert!(after.contains_key(&35), "{schema}: the clone lists #35");
    }
}

#[test]
fn two_clones_keep_the_members_they_reuse_when_they_empty_the_group() {
    for schema in SCHEMAS {
        let content = with_second_member(two_walls_sharing_a_pset(schema));
        let (report, after) = run(
            &content,
            vec![
                patch(10, vec![prop("Pset_WallCommon", "FireRating", "IFCLABEL", "'2HR'")]),
                patch(11, vec![prop("Pset_WallCommon", "FireRating", "IFCLABEL", "'3HR'")]),
            ],
        );
        assert!(report.findings.is_empty(), "{schema}: {:?}", report.findings);
        assert!(after.contains_key(&35), "{schema}: both clones list #35");
    }
}

/// Two writes into one shared set make one clone carrying both.
#[test]
fn two_writes_into_one_shared_set_land_in_one_clone() {
    for schema in SCHEMAS {
        let content = with_second_member(two_walls_sharing_a_pset(schema));
        let (report, after) = run(
            &content,
            vec![patch(10, vec![prop("Pset_WallCommon", "FireRating", "IFCLABEL", "'2HR'"), prop("Pset_WallCommon", "IsExternal", "IFCBOOLEAN", ".F.")])],
        );
        assert!(report.findings.is_empty(), "{schema}: {:?}", report.findings);
        let clones: Vec<&String> = after.iter().filter(|(&id, l)| id > 35 && l.contains("IFCPROPERTYSET(")).map(|(_, l)| l).collect();
        assert_eq!(clones.len(), 1, "{schema}: {clones:?}");
        let fire = id_of(&after, "'2HR'");
        let external = id_of(&after, "IFCBOOLEAN(.F.)");
        assert!(clones[0].contains(&format!("(#{fire},#{external})")), "{schema}: {}", clones[0]);
    }
}

/// Two new properties folded into one unshared set both join its list.
#[test]
fn two_folds_into_one_unshared_set_both_land() {
    for schema in SCHEMAS {
        let (report, after) = run(
            &wall_with_own_pset(schema),
            vec![patch(10, vec![prop("Pset_WallCommon", "A", "IFCLABEL", "'a'"), prop("Pset_WallCommon", "B", "IFCLABEL", "'b'")])],
        );
        assert!(report.findings.is_empty(), "{schema}: {:?}", report.findings);
        let (a, b) = (id_of(&after, "'A'"), id_of(&after, "'B'"));
        assert!(after[&31].contains(&format!("(#30,#{a},#{b})")), "{schema}: {}", after[&31]);
    }
}

/// Two writes into a set the object does not have yet make one set.
#[test]
fn two_writes_into_a_new_set_make_one_set() {
    for schema in SCHEMAS {
        let (report, after) =
            run(&wall_with_own_pset(schema), vec![patch(10, vec![prop("Pset_New", "A", "IFCLABEL", "'a'"), prop("Pset_New", "B", "IFCLABEL", "'b'")])]);
        assert!(report.findings.is_empty(), "{schema}: {:?}", report.findings);
        let set = &after[&id_of(&after, "'Pset_New'")];
        let (a, b) = (id_of(&after, "'A'"), id_of(&after, "'B'"));
        assert!(set.contains(&format!("(#{a},#{b})")), "{schema}: {set}");
    }
}

/// A later write to the same property wins; the set does not carry both.
#[test]
fn a_later_write_to_the_same_property_wins() {
    let (report, after) = run(
        &wall_with_own_pset("IFC4"),
        vec![patch(10, vec![prop("Pset_WallCommon", "A", "IFCLABEL", "'first'"), prop("Pset_WallCommon", "A", "IFCLABEL", "'second'")])],
    );
    assert!(report.findings.is_empty(), "{:?}", report.findings);
    assert!(!after.values().any(|l| l.contains("'first'")));
    let a = id_of(&after, "'second'");
    assert!(after[&31].contains(&format!("(#30,#{a})")), "{}", after[&31]);
}

/// Deleting a property set removes the relationship that attached it, and
/// leaves the walls it was attached to.
#[test]
fn deleting_a_property_set_keeps_the_objects_it_was_attached_to() {
    for schema in SCHEMAS {
        let (_, after) = run(&two_walls_sharing_a_pset(schema), vec![(ObjectRef::Id(31), Disposition::Delete)]);
        assert!(after.contains_key(&10) && after.contains_key(&11), "{schema}: walls pruned");
        assert!(!after.contains_key(&31) && !after.contains_key(&32), "{schema}: the set and its relationship go");
    }
}

/// A delete's strip and a fold on the same member list compose.
#[test]
fn deleting_a_member_and_folding_a_new_one_into_the_same_set_compose() {
    for schema in SCHEMAS {
        let content = with_second_member(wall_with_own_pset(schema));
        let (report, after) =
            run(&content, vec![(ObjectRef::Id(35), Disposition::Delete), patch(10, vec![prop("Pset_WallCommon", "X", "IFCLABEL", "'x'")])]);
        assert!(report.findings.is_empty(), "{schema}: {:?}", report.findings);
        let x = id_of(&after, "'X'");
        assert!(after[&31].contains(&format!("(#30,#{x})")), "{schema}: {}", after[&31]);
    }
}

/// A delete's strip and a leaf copy-on-write's repoint on the same list
/// compose, and the deleted member does not come back.
#[test]
fn deleting_a_member_and_repointing_a_shared_leaf_in_the_same_set_compose() {
    let content = String::from_utf8(two_sets_on_one_wall_sharing_a_leaf("IFC4"))
        .unwrap()
        .replace("'Pset_A',$,(#30));", "'Pset_A',$,(#30,#35));")
        .replace("ENDSEC;\nEND-ISO-10303-21;", "#35=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);\nENDSEC;\nEND-ISO-10303-21;")
        .into_bytes();
    assert!(String::from_utf8_lossy(&content).contains("(#30,#35)"), "fixture");
    let (report, after) =
        run(&content, vec![(ObjectRef::Id(35), Disposition::Delete), patch(10, vec![prop("Pset_A", "Reference", "IFCIDENTIFIER", "'R-2'")])]);
    assert!(report.findings.is_empty(), "{:?}", report.findings);
    assert!(!after[&41].contains("#35"), "{}", after[&41]);
    assert!(!after[&41].contains("#30"), "the shared leaf is repointed: {}", after[&41]);
}

/// A write onto a value with no `NominalValue` (an enumerated value) is
/// refused rather than reported as applied with nothing changed.
#[test]
fn a_write_onto_an_enumerated_value_is_refused() {
    let content = String::from_utf8(wall_with_own_pset("IFC4"))
        .unwrap()
        .replace(
            "#30=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('1HR'),$);",
            "#30=IFCPROPERTYENUMERATEDVALUE('FireRating',$,(IFCLABEL('1HR')),$);",
        )
        .into_bytes();
    assert!(String::from_utf8_lossy(&content).contains("IFCPROPERTYENUMERATEDVALUE"), "fixture");
    let (report, _) = run(&content, vec![patch(10, vec![prop("Pset_WallCommon", "FireRating", "IFCLABEL", "'2HR'")])]);
    assert_eq!(report.refusals.len(), 1, "{:?}", report.refusals);
}

/// A placement matrix that is not a placement is refused, not written.
#[test]
fn a_degenerate_placement_matrix_is_refused() {
    let identity = [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]];
    let mut non_finite = identity;
    non_finite[0][3] = f64::INFINITY;
    let mut zero_axis = identity;
    zero_axis[2][2] = 0.0;
    let mut parallel = identity;
    (parallel[0][0], parallel[2][0]) = (0.0, 1.0);
    for matrix in [non_finite, zero_axis, parallel] {
        let placement = Patch { placement: Some(PlacementPatch { matrix }), ..Default::default() };
        let (report, after) = run(&wall_with_own_pset("IFC4"), vec![(ObjectRef::Id(10), Disposition::Patch(placement))]);
        assert_eq!(report.refusals.len(), 1, "{matrix:?}");
        assert!(!after.values().any(|l| l.contains("inf") || l.contains("IFCDIRECTION((0.,0.,0.))")), "{matrix:?}");
    }
}

