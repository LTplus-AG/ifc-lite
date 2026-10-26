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
        target: None,
    }
}

fn patch(id: u32, psets: Vec<PropWrite>) -> (ObjectRef, Disposition) {
    (ObjectRef::Id(id), Disposition::Patch(Patch { psets, ..Default::default() }))
}

fn run(content: &[u8], dispositions: Vec<(ObjectRef, Disposition)>) -> (WriteReport, HashMap<u32, String>) {
    let plan = ExportPlan { dispositions, context: PlanContext::attributed() };
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


/// Deleting the relationship that attaches a shared set while patching one
/// of its walls: the gating pass alone would prune the set's members, but the
/// patched wall's clone reuses `#35`, so it stays.
#[test]
fn a_clone_keeps_a_member_the_deleted_relationship_alone_would_have_pruned() {
    for schema in SCHEMAS {
        let content = with_second_member(two_walls_sharing_a_pset(schema));
        let (report, after) =
            run(&content, vec![(ObjectRef::Id(32), Disposition::Delete), patch(10, vec![prop("Pset_WallCommon", "FireRating", "IFCLABEL", "'2HR'")])]);
        assert!(report.findings.is_empty(), "{schema}: {:?}", report.findings);
        assert!(after.contains_key(&35), "{schema}: the clone lists #35");
    }
}

/// Deleting the set a patch edits in place loses the edit, so the patch says
/// so instead of counting it silently (#8078 review).
#[test]
fn an_in_place_write_into_a_deleted_set_is_refused() {
    for schema in SCHEMAS {
        let content = wall_with_own_pset(schema);
        let (report, _) =
            run(&content, vec![(ObjectRef::Id(31), Disposition::Delete), patch(10, vec![prop("Pset_WallCommon", "FireRating", "IFCLABEL", "'2HR'")])]);
        assert!(report.refusals.iter().any(|r| r.reason.contains("is lost")), "{schema}: {:?}", report.refusals);
        assert!(report.findings.is_empty(), "{schema}: {:?}", report.findings);
    }
}

/// A property set and a quantity set of one name on one object get distinct
/// GlobalIds (#8078 review).
#[test]
fn a_property_set_and_a_quantity_set_of_one_name_differ() {
    let content = wall_with_own_pset("IFC4");
    let mut quantity = prop("Metrics", "Length", "IFCLENGTHMEASURE", "2.");
    quantity.kind = PsetKind::Quantity;
    let (report, _) = run(&content, vec![patch(10, vec![prop("Metrics", "Length", "IFCLABEL", "'long'"), quantity])]);
    assert!(report.findings.is_empty(), "a property set and a quantity set may share a name: {:?}", report.findings);
}

/// A new member folded into a set the plan deletes is refused too (#8078
/// review).
#[test]
fn a_fold_into_a_deleted_set_is_refused() {
    for schema in SCHEMAS {
        let content = wall_with_own_pset(schema);
        let (report, after) =
            run(&content, vec![(ObjectRef::Id(31), Disposition::Delete), patch(10, vec![prop("Pset_WallCommon", "NewProp", "IFCLABEL", "'x'")])]);
        assert!(report.refusals.iter().any(|r| r.reason.contains("#31 is lost")), "{schema}: {:?}", report.refusals);
        assert!(!after.values().any(|l| l.contains("'NewProp'")), "{schema}: no orphan value is written");
    }
}

/// Two patches repointing one shared leaf: the later copy replaces the
/// earlier one, which is not written (#8078 review).
#[test]
fn a_replaced_leaf_copy_is_not_written() {
    use super::test_fixtures::two_sets_on_one_wall_sharing_a_leaf;
    for schema in SCHEMAS {
        let content = two_sets_on_one_wall_sharing_a_leaf(schema);
        let write = |v: &str| patch(10, vec![prop("Pset_A", "Reference", "IFCIDENTIFIER", v)]);
        let (report, after) = run(&content, vec![write("'R-2'"), write("'R-3'")]);
        assert!(report.findings.is_empty(), "{schema}: {:?}", report.findings);
        assert!(!after.values().any(|l| l.contains("'R-2'")), "{schema}: the replaced copy is not written");
    }
}

/// A Preserve that the plan's deletes override is reported (#8078 review).
#[test]
fn a_preserved_object_the_deletes_remove_is_refused() {
    for schema in SCHEMAS {
        let content = wall_with_own_pset(schema);
        let (report, after) = run(&content, vec![(ObjectRef::Id(20), Disposition::Delete), (ObjectRef::Id(10), Disposition::Preserve)]);
        assert!(!after.contains_key(&10), "{schema}: a wall whose placement is deleted goes");
        assert!(report.refusals.iter().any(|r| r.object == ObjectRef::Id(10) && r.reason.contains("cannot be preserved")), "{schema}: {:?}", report.refusals);
    }
}

/// A preserved opening whose host the plan deletes says why it still goes.
#[test]
fn a_preserved_opening_without_a_host_is_refused_as_unhosted() {
    use super::test_fixtures::host_with_port_type_and_body;
    for schema in SCHEMAS {
        let content = host_with_port_type_and_body(schema);
        let (report, after) = run(&content, vec![(ObjectRef::Id(10), Disposition::Delete), (ObjectRef::Id(70), Disposition::Preserve)]);
        assert!(!after.contains_key(&70), "{schema}: the opening goes with its host");
        let refusal = report.refusals.iter().find(|r| r.object == ObjectRef::Id(70)).expect("the Preserve is refused");
        assert!(refusal.reason.contains("no host relationship left"), "{schema}: {}", refusal.reason);
    }
}

/// A copy replaces an enumerated value only as an in-place edit would: not
/// at all (#8078 review).
#[test]
fn a_shared_enumerated_value_is_not_replaced_by_a_single_value() {
    for schema in SCHEMAS {
        let content = String::from_utf8(two_walls_sharing_a_pset(schema))
            .unwrap()
            .replace("#30=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('1HR'),$);", "#30=IFCPROPERTYENUMERATEDVALUE('FireRating',$,(IFCLABEL('1HR')),$);");
        assert!(content.contains("IFCPROPERTYENUMERATEDVALUE"), "{schema}: fixture");
        let (report, _) = run(content.as_bytes(), vec![patch(10, vec![prop("Pset_WallCommon", "FireRating", "IFCLABEL", "'2HR'")])]);
        assert!(report.refusals.iter().any(|r| r.reason.contains("cannot replace")), "{schema}: {:?}", report.refusals);
    }
}

/// The same holds for a shared leaf in an unshared set (#8078 review).
#[test]
fn a_shared_enumerated_leaf_is_not_replaced_by_a_single_value() {
    use super::test_fixtures::two_sets_on_one_wall_sharing_a_leaf;
    for schema in SCHEMAS {
        let source = String::from_utf8(two_sets_on_one_wall_sharing_a_leaf(schema)).unwrap();
        let start = source.find("#30=IFCPROPERTYSINGLEVALUE(").expect("fixture leaf #30");
        let end = start + source[start..].find(";\n").unwrap() + 1;
        let content = format!("{}#30=IFCPROPERTYENUMERATEDVALUE('Reference',$,(IFCLABEL('R-1')),$);{}", &source[..start], &source[end..]);
        let (report, _) = run(content.as_bytes(), vec![patch(10, vec![prop("Pset_A", "Reference", "IFCIDENTIFIER", "'R-2'")])]);
        assert!(report.refusals.iter().any(|r| r.reason.contains("cannot replace")), "{schema}: {:?}", report.refusals);
    }
}

/// The fixture with a door `#80` filling its opening `#70` through `#81`.
fn host_with_filled_opening(schema: &str) -> Vec<u8> {
    use super::test_fixtures::host_with_port_type_and_body;
    let door = super::attrs::build_record(schema, 80, "IFCDOOR", &[("GlobalId", "'0000000000000000000080'".into()), ("Name", "'Door'".into())]);
    let fills = super::attrs::build_record(
        schema,
        81,
        "IFCRELFILLSELEMENT",
        &[("GlobalId", "'0000000000000000000081'".into()), ("RelatingOpeningElement", "#70".into()), ("RelatedBuildingElement", "#80".into())],
    );
    let text = String::from_utf8(host_with_port_type_and_body(schema)).unwrap();
    text.replacen("ENDSEC;\nEND-ISO", &format!("{door}\n{fills}\nENDSEC;\nEND-ISO"), 1).into_bytes()
}

/// A patch does not keep an opening alive once its host is deleted: IFC
/// ties an opening to exactly one element, so it goes with its host, the
/// door that filled it stays, and the patch is refused saying why.
#[test]
fn a_patched_opening_goes_with_its_host_and_the_patch_is_refused() {
    for schema in SCHEMAS {
        let content = host_with_filled_opening(schema);
        let rename = (ObjectRef::Id(70), Disposition::Patch(Patch { name: Some("Renamed".into()), ..Default::default() }));
        let (report, after) = run(&content, vec![(ObjectRef::Id(10), Disposition::Delete), rename]);
        assert!(!after.contains_key(&70), "{schema}: the opening goes with its host");
        assert!(!after.contains_key(&81), "{schema}: and the fill naming it");
        assert!(after.contains_key(&80), "{schema}: the door stays");
        assert!(!after.values().any(|l| l.contains("'Renamed'")), "{schema}: the patch is not written");
        assert_eq!(report.patched, 0, "{schema}");
        let refusal = report.refusals.iter().find(|r| r.object == ObjectRef::Id(70)).expect("the patch is refused");
        assert!(refusal.reason.contains("no host relationship left"), "{schema}: {}", refusal.reason);
        assert!(report.findings.is_empty(), "{schema}: {:?}", report.findings);
    }
}

/// An Add that names the opening still keeps it.
#[test]
fn an_opening_an_add_names_stays_without_its_host() {
    use super::add_test_support::{add, gid, object};
    use super::add_types::{IfcClass, Representation};
    for schema in SCHEMAS {
        let content = host_with_filled_opening(schema);
        let mut child = object(IfcClass::BuildingElementProxy, gid(1), None, Representation::None);
        child.placement.relative_to = Some(ObjectRef::Id(70));
        let (report, after) = run(&content, vec![(ObjectRef::Id(10), Disposition::Delete), add(child)]);
        assert!(after.contains_key(&70), "{schema}: the Add needs it");
        assert_eq!(report.added, 1, "{schema}: {:?}", report.refusals);
    }
}

/// A projection follows the same rule, and so does an opening whose voids
/// relationship (not its host) the plan deletes; an opening the plan also
/// deletes outright says so.
#[test]
fn a_patched_projection_or_voidless_opening_goes_and_the_reason_fits() {
    let rename = |id| (ObjectRef::Id(id), Disposition::Patch(Patch { name: Some("Renamed".into()), ..Default::default() }));
    for schema in SCHEMAS {
        let projected = String::from_utf8(host_with_filled_opening(schema))
            .unwrap()
            .replace("IFCOPENINGELEMENT(", "IFCPROJECTIONELEMENT(")
            .replace("IFCRELVOIDSELEMENT(", "IFCRELPROJECTSELEMENT(");
        assert!(projected.contains("IFCRELPROJECTSELEMENT("), "{schema}: fixture");
        let (report, after) = run(projected.as_bytes(), vec![(ObjectRef::Id(10), Disposition::Delete), rename(70)]);
        assert!(!after.contains_key(&70), "{schema}: the projection goes with its host");
        assert!(report.refusals.iter().any(|r| r.object == ObjectRef::Id(70) && r.reason.contains("no host relationship left")), "{schema}: {:?}", report.refusals);

        let content = host_with_filled_opening(schema);
        let (report, after) = run(&content, vec![(ObjectRef::Id(71), Disposition::Delete), rename(70)]);
        assert!(after.contains_key(&10) && !after.contains_key(&70), "{schema}: the host stays, the opening goes with its voids");
        assert!(report.refusals.iter().any(|r| r.object == ObjectRef::Id(70) && r.reason.contains("no host relationship left")), "{schema}: {:?}", report.refusals);

        let (report, _) = run(&content, vec![(ObjectRef::Id(10), Disposition::Delete), (ObjectRef::Id(70), Disposition::Delete), rename(70)]);
        let refusal = report.refusals.iter().find(|r| r.object == ObjectRef::Id(70)).expect("refused");
        assert!(refusal.reason.contains("also deleted by this plan"), "{schema}: {}", refusal.reason);
        let (report, _) = run(&content, vec![(ObjectRef::Id(10), Disposition::Delete), (ObjectRef::Id(70), Disposition::Delete), (ObjectRef::Id(70), Disposition::Preserve)]);
        let refusal = report.refusals.iter().find(|r| r.object == ObjectRef::Id(70)).expect("refused");
        assert!(refusal.reason.contains("removed by this plan"), "{schema}: {}", refusal.reason);
    }
}
