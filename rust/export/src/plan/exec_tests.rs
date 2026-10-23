// SPDX-License-Identifier: MPL-2.0
use std::collections::HashMap;

use ifc_lite_core::EntityScanner;

use super::execute;
use super::test_fixtures::{gid, two_walls_sharing_a_pset, two_walls_sharing_a_pset_plus_a_third_sharing_the_leaf, wall_with_own_pset};
use super::types::*;

fn entity_lines(content: &[u8]) -> HashMap<u32, String> {
    let mut out = HashMap::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, _type, s, e)) = scanner.next_entity() {
        out.insert(id, String::from_utf8_lossy(&content[s..e]).trim_end().to_string());
    }
    out
}

#[test]
fn all_preserve_plan_changes_zero_records() {
    for schema in ["IFC2X3", "IFC4", "IFC4X3"] {
        let content = wall_with_own_pset(schema);
        let plan = ExportPlan {
            dispositions: vec![(ObjectRef::Id(10), Disposition::Preserve)],
            context: PlanContext::default(),
        };
        let mut out = Vec::new();
        let report = execute(&content, &plan, &mut out).expect(schema);

        assert_eq!(report.deleted, 0, "{schema}");
        assert!(report.refusals.is_empty(), "{schema}: {:?}", report.refusals);
        assert!(report.findings.is_empty(), "{schema}: {:?}", report.findings);

        let before = entity_lines(&content);
        let after = entity_lines(&out);
        for (id, line) in &before {
            assert_eq!(after.get(id), Some(line), "{schema}: #{id} changed under an all-Preserve plan");
        }
        assert_eq!(before.len(), after.len(), "{schema}: no record appeared or disappeared");
    }
}

#[test]
fn same_plan_produces_byte_identical_output_twice() {
    let content = wall_with_own_pset("IFC4");
    let plan = ExportPlan {
        dispositions: vec![
            (ObjectRef::Id(10), Disposition::Patch(Patch { name: Some("Renamed".into()), ..Default::default() })),
        ],
        context: PlanContext { author: Some("tester".into()), organization: None, time_stamp: Some("123".into()) },
    };
    let mut out1 = Vec::new();
    let mut out2 = Vec::new();
    execute(&content, &plan, &mut out1).unwrap();
    execute(&content, &plan, &mut out2).unwrap();
    assert_eq!(out1, out2);
}

#[test]
fn name_patch_resolves_by_globalid_and_updates_only_that_slot() {
    let schema = "IFC4";
    let content = wall_with_own_pset(schema);
    let plan = ExportPlan {
        dispositions: vec![(
            ObjectRef::Guid(gid(10)),
            Disposition::Patch(Patch { name: Some("New Wall Name".into()), ..Default::default() }),
        )],
        context: PlanContext::default(),
    };
    let mut out = Vec::new();
    let report = execute(&content, &plan, &mut out).unwrap();
    assert_eq!(report.patched, 1);
    let after = entity_lines(&out);
    let wall = &after[&10];
    assert!(wall.contains("'New Wall Name'"), "{wall}");
    assert!(wall.contains(&format!("'{}'", gid(10))), "GlobalId untouched: {wall}");
}

#[test]
fn delete_removes_the_object_and_repairs_its_relationships() {
    let schema = "IFC4";
    let content = wall_with_own_pset(schema);
    let plan = ExportPlan {
        dispositions: vec![(ObjectRef::Id(10), Disposition::Delete)],
        context: PlanContext::default(),
    };
    let mut out = Vec::new();
    let report = execute(&content, &plan, &mut out).unwrap();
    assert!(report.deleted >= 4, "wall + rel + pset + property: {}", report.deleted);
    assert!(report.findings.is_empty(), "{:?}", report.findings);
    let after = entity_lines(&out);
    assert!(!after.contains_key(&10));
    assert!(!after.contains_key(&31), "the now-unreachable pset must not survive");
}

#[test]
fn deleting_one_of_two_sharing_walls_leaves_the_other_and_its_pset_intact() {
    let schema = "IFC4";
    let content = two_walls_sharing_a_pset(schema);
    let plan = ExportPlan {
        dispositions: vec![(ObjectRef::Id(10), Disposition::Delete)],
        context: PlanContext::default(),
    };
    let mut out = Vec::new();
    let report = execute(&content, &plan, &mut out).unwrap();
    assert!(report.findings.is_empty(), "{:?}", report.findings);
    let after = entity_lines(&out);
    assert!(!after.contains_key(&10));
    assert!(after.contains_key(&11), "the other wall survives");
    assert!(after.contains_key(&31), "the shared pset survives");
    assert!(after[&32].contains("#11"), "the rel keeps the surviving wall: {}", after[&32]);
    assert!(!after[&32].contains("#10"), "the rel drops the deleted one: {}", after[&32]);
}

#[test]
fn placement_patch_repoints_the_local_placement_and_output_still_validates() {
    let schema = "IFC4";
    let content = wall_with_own_pset(schema);
    let plan = ExportPlan {
        dispositions: vec![(
            ObjectRef::Id(10),
            Disposition::Patch(Patch {
                placement: Some(PlacementPatch {
                    matrix: [[1.0, 0.0, 0.0, 3.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]],
                }),
                ..Default::default()
            }),
        )],
        context: PlanContext::default(),
    };
    let mut out = Vec::new();
    let report = execute(&content, &plan, &mut out).unwrap();
    assert!(report.findings.is_empty(), "{:?}", report.findings);
    let after = entity_lines(&out);
    assert!(after[&20].contains("IFCLOCALPLACEMENT"));
    assert!(!after[&20].contains("#21"), "repointed away from the old axis placement: {}", after[&20]);
    // (2) The old axis placement and its point are gone from the output,
    // not merely unreferenced.
    assert!(!after.contains_key(&21), "old axis placement pruned");
    assert!(!after.contains_key(&22), "old point pruned transitively");
    assert_eq!(report.deleted, 2, "exactly the two records this patch orphaned");
}

#[test]
fn add_disposition_is_counted_unsupported_and_changes_nothing() {
    let schema = "IFC4";
    let content = wall_with_own_pset(schema);
    let plan = ExportPlan { dispositions: vec![(ObjectRef::Id(10), Disposition::Add)], context: PlanContext::default() };
    let mut out = Vec::new();
    let report = execute(&content, &plan, &mut out).unwrap();
    assert_eq!(report.added_unsupported, 1);
    assert_eq!(report.written, report.total);
}

#[test]
fn unknown_object_ref_is_refused_not_silently_skipped() {
    let schema = "IFC4";
    let content = wall_with_own_pset(schema);
    let plan = ExportPlan {
        dispositions: vec![(ObjectRef::Id(999_999), Disposition::Delete)],
        context: PlanContext::default(),
    };
    let mut out = Vec::new();
    let report = execute(&content, &plan, &mut out).unwrap();
    assert_eq!(report.refusals.len(), 1);
    assert_eq!(report.deleted, 0);
}


/// (1a) Patching a value in a pset SHARED by another occurrence through one
/// `IfcRelDefinesByProperties` must never leave the patched object with two
/// property sets named the same. Written to fail against the pre-fix
/// "always append" behaviour, and to keep failing if it ever regresses.
#[test]
fn shared_occurrence_pset_edit_never_duplicates_the_pset_name() {
    let schema = "IFC4";
    let content = two_walls_sharing_a_pset(schema);
    let plan = ExportPlan {
        dispositions: vec![(
            ObjectRef::Id(10),
            Disposition::Patch(Patch {
                psets: vec![PropWrite {
                    pset: "Pset_WallCommon".into(),
                    prop: "FireRating".into(),
                    measure_type: "IFCLABEL".into(),
                    literal: "'2HR'".into(),
                    unit: None,
                    kind: PsetKind::Property,
                    scope: PropScope::Occurrence,
                }],
                ..Default::default()
            }),
        )],
        context: PlanContext::default(),
    };
    let mut out = Vec::new();
    let report = execute(&content, &plan, &mut out).unwrap();
    assert!(
        report.findings.iter().all(|f| !f.message.contains("carries two property/quantity sets named")),
        "{:?}",
        report.findings
    );
}

/// The duplicate-set check covers the objects a plan patched, the only
/// objects a patch can give a second set of the same name. A duplicate the
/// source already had on an object the plan never touched is not reported;
/// the same duplicate on a patched object is.
#[test]
fn duplicate_set_check_is_scoped_to_patched_objects() {
    let schema = "IFC4";
    let content = String::from_utf8(two_walls_sharing_a_pset(schema))
        .unwrap()
        .replace(
            "ENDSEC;\nEND-ISO-10303-21;",
            &format!(
                "#33=IFCPROPERTYSET('{}',$,'Pset_WallCommon',$,(#30));\n#34=IFCRELDEFINESBYPROPERTIES('{}',$,$,$,(#11),#33);\nENDSEC;\nEND-ISO-10303-21;",
                gid(33),
                gid(34)
            ),
        )
        .into_bytes();
    let rename = |id| ExportPlan {
        dispositions: vec![(ObjectRef::Id(id), Disposition::Patch(Patch { name: Some("x".into()), ..Default::default() }))],
        context: PlanContext::default(),
    };
    let duplicate = |report: &WriteReport| report.findings.iter().any(|f| f.message.contains("carries two"));

    let untouched = execute(&content, &rename(10), Vec::new()).unwrap();
    assert!(!duplicate(&untouched), "{:?}", untouched.findings);
    let patched = execute(&content, &rename(11), Vec::new()).unwrap();
    assert!(duplicate(&patched), "{:?}", patched.findings);
}

// --- A delete's reverse-reference repair and a patch's copy-on-write detach
// can both rewrite the SAME relationship's RelatedObjects. Below: a plan
// that deletes one member of a three-wall shared-pset group and patches
// another member's copy of the same pset, in every order and grouping this
// executor has to get right.

use super::attrs::attribute_index;
use super::index::parse_attrs;
use super::test_fixtures::three_walls_sharing_a_pset;

fn fire_rating_write(literal: &str) -> PropWrite {
    PropWrite {
        pset: "Pset_WallCommon".into(),
        prop: "FireRating".into(),
        measure_type: "IFCLABEL".into(),
        literal: literal.into(),
        unit: None,
        kind: PsetKind::Property,
        scope: PropScope::Occurrence,
    }
}

fn delete(id: u32) -> (ObjectRef, Disposition) {
    (ObjectRef::Id(id), Disposition::Delete)
}

fn patch_fire_rating(id: u32, literal: &str) -> (ObjectRef, Disposition) {
    (ObjectRef::Id(id), Disposition::Patch(Patch { psets: vec![fire_rating_write(literal)], ..Default::default() }))
}

/// Every `IfcRelDefinesByProperties` in `after` that names `object_id`
/// directly in its `RelatedObjects`, as `(rel id, pset name, FireRating
/// literal)`. Reads the output the same way the executor's own validator
/// does — off the raw record text, by attribute index — rather than
/// asserting on exact express ids, which a fix is free to renumber.
fn fire_rating_psets_of(schema: &str, after: &HashMap<u32, String>, object_id: u32) -> Vec<(u32, String, String)> {
    let related_idx = attribute_index(schema, "IFCRELDEFINESBYPROPERTIES", "RelatedObjects").unwrap();
    let def_idx = attribute_index(schema, "IFCRELDEFINESBYPROPERTIES", "RelatingPropertyDefinition").unwrap();
    let pset_name_idx = attribute_index(schema, "IFCPROPERTYSET", "Name").unwrap();
    let members_idx = attribute_index(schema, "IFCPROPERTYSET", "HasProperties").unwrap();
    let value_idx = attribute_index(schema, "IFCPROPERTYSINGLEVALUE", "NominalValue").unwrap();

    let mut out = Vec::new();
    for line in after.values() {
        if !line.contains("IFCRELDEFINESBYPROPERTIES") {
            continue;
        }
        let Some(attrs) = parse_attrs(line) else { continue };
        let Some(related) = attrs.get(related_idx).and_then(|a| a.list.as_ref()) else { continue };
        if !related.iter().flatten().any(|&o| o == object_id) {
            continue;
        }
        let Some(pset_id) = attrs.get(def_idx).and_then(|a| a.scalar) else { continue };
        let pset_line = &after[&pset_id];
        let name = crate::step_text::attribute_of(pset_line, pset_name_idx).unwrap();
        let name = name.trim().trim_matches('\'').to_string();
        let pset_attrs = parse_attrs(pset_line).unwrap();
        let members = pset_attrs.get(members_idx).and_then(|a| a.list.clone()).unwrap_or_default();
        let value_id = members.into_iter().flatten().next().unwrap();
        let value_line = &after[&value_id];
        let value = crate::step_text::attribute_of(value_line, value_idx).unwrap();
        out.push((pset_id, name, value));
    }
    out
}

/// The failing case this module exists for: deleting wall 1 (a member of
/// the shared-pset group) and patching wall 2's copy of the SAME pset must
/// compose into one rewrite of the group relationship, not two that each
/// discard the other's strip.
#[test]
fn delete_and_patch_on_the_same_shared_pset_group_compose() {
    let schema = "IFC4";
    let content = three_walls_sharing_a_pset(schema);
    let plan = ExportPlan { dispositions: vec![delete(10), patch_fire_rating(11, "'2HR'")], context: PlanContext::default() };
    let mut out = Vec::new();
    let report = execute(&content, &plan, &mut out).unwrap();
    assert!(report.findings.is_empty(), "{:?}", report.findings);

    let after = entity_lines(&out);
    assert!(!after.contains_key(&10), "wall 1 is deleted");
    assert!(after.contains_key(&11), "wall 2 survives, patched");
    assert!(after.contains_key(&12), "wall 3 survives, untouched");

    // Wall 2 carries exactly ONE Pset_WallCommon, holding the new value —
    // not the original (still pointing at it) plus the copy-on-write clone.
    let wall2 = fire_rating_psets_of(schema, &after, 11);
    assert_eq!(wall2.len(), 1, "wall 2 must carry exactly one Pset_WallCommon: {wall2:?}");
    assert_eq!(wall2[0].1, "Pset_WallCommon");
    assert!(wall2[0].2.contains("2HR"), "wall 2's copy holds the patched value: {wall2:?}");

    // Wall 3 is untouched: still the original set, still the original value.
    let wall3 = fire_rating_psets_of(schema, &after, 12);
    assert_eq!(wall3.len(), 1, "wall 3 must still carry exactly one Pset_WallCommon: {wall3:?}");
    assert!(wall3[0].2.contains("1HR"), "wall 3 keeps the original value: {wall3:?}");

    // The original relationship (#32) relates wall 3 alone: wall 1 was
    // deleted from it, wall 2 detached from it via copy-on-write.
    let original_rel = &after[&32];
    assert!(original_rel.contains("#12"), "the original rel still relates wall 3: {original_rel}");
    assert!(!original_rel.contains("#10"), "wall 1 is gone from it: {original_rel}");
    assert!(!original_rel.contains("#11"), "wall 2 is detached from it: {original_rel}");
}

/// Same composition, patch before delete in plan order.
#[test]
fn patch_then_delete_on_the_same_shared_pset_group_compose() {
    let schema = "IFC4";
    let content = three_walls_sharing_a_pset(schema);
    let plan = ExportPlan { dispositions: vec![patch_fire_rating(11, "'2HR'"), delete(10)], context: PlanContext::default() };
    let mut out = Vec::new();
    let report = execute(&content, &plan, &mut out).unwrap();
    assert!(report.findings.is_empty(), "{:?}", report.findings);
    let after = entity_lines(&out);
    let wall2 = fire_rating_psets_of(schema, &after, 11);
    assert_eq!(wall2.len(), 1, "{wall2:?}");
    assert!(wall2[0].2.contains("2HR"));
    let wall3 = fire_rating_psets_of(schema, &after, 12);
    assert_eq!(wall3.len(), 1, "{wall3:?}");
    assert!(wall3[0].2.contains("1HR"), "wall 3 keeps the original value: {wall3:?}");
    let original_rel = &after[&32];
    assert!(original_rel.contains("#12"), "the original rel still relates wall 3: {original_rel}");
    assert!(!original_rel.contains("#10"), "wall 1 is gone from it: {original_rel}");
    assert!(!original_rel.contains("#11"), "wall 2 is detached from it: {original_rel}");
}

/// Both the delete and the patch target a group of exactly two, so the
/// original relationship's RelatedObjects goes empty between them: it must
/// cascade away like any other mandatory list a delete alone would empty.
#[test]
fn delete_and_patch_together_emptying_the_group_cascades() {
    let schema = "IFC4";
    let content = two_walls_sharing_a_pset(schema);
    let plan = ExportPlan { dispositions: vec![delete(10), patch_fire_rating(11, "'2HR'")], context: PlanContext::default() };
    let mut out = Vec::new();
    let report = execute(&content, &plan, &mut out).unwrap();
    assert!(report.findings.is_empty(), "{:?}", report.findings);
    let after = entity_lines(&out);
    assert!(!after.contains_key(&10), "wall 1 deleted");
    assert!(after.contains_key(&11), "wall 2 survives, patched");
    assert!(!after.contains_key(&32), "the original rel is emptied by both sides and cascades away");
    assert!(!after.contains_key(&31), "the original pset is unreachable once the rel is gone");
    assert!(!after.contains_key(&30), "the original property is unreachable once the pset is gone");
    let wall2 = fire_rating_psets_of(schema, &after, 11);
    assert_eq!(wall2.len(), 1, "wall 2 still carries exactly one pset, its own clone: {wall2:?}");
    assert!(wall2[0].2.contains("2HR"));
}

/// Two patches on the same group, no delete at all: both must detach from
/// the original relationship, leaving it related to the one member neither
/// patch touched.
#[test]
fn two_patches_on_one_shared_pset_group_both_detach() {
    let schema = "IFC4";
    let content = three_walls_sharing_a_pset(schema);
    let plan =
        ExportPlan { dispositions: vec![patch_fire_rating(11, "'2HR'"), patch_fire_rating(12, "'3HR'")], context: PlanContext::default() };
    let mut out = Vec::new();
    let report = execute(&content, &plan, &mut out).unwrap();
    assert!(report.findings.is_empty(), "{:?}", report.findings);
    let after = entity_lines(&out);

    let wall2 = fire_rating_psets_of(schema, &after, 11);
    assert_eq!(wall2.len(), 1, "{wall2:?}");
    assert!(wall2[0].2.contains("2HR"));
    let wall3 = fire_rating_psets_of(schema, &after, 12);
    assert_eq!(wall3.len(), 1, "{wall3:?}");
    assert!(wall3[0].2.contains("3HR"));

    let original_rel = &after[&32];
    assert!(original_rel.contains("#10"), "wall 1 is untouched, still related: {original_rel}");
    assert!(!original_rel.contains("#11"), "wall 2 detached: {original_rel}");
    assert!(!original_rel.contains("#12"), "wall 3 detached: {original_rel}");
}

/// Set-level and leaf-level sharing at once: wall 10 and wall 11 share
/// `Pset_WallCommon` through one relationship (set-level sharing), and that
/// pset's own `FireRating` leaf is ALSO referenced by wall 12's unrelated
/// `Pset_Other` (leaf-level sharing). Patching wall 10 must go through the
/// set-level copy-on-write (which always mints a fresh leaf regardless of
/// the old leaf's own sharing) and never touch wall 12's copy.
#[test]
fn leaf_sharing_composes_with_set_level_copy_on_write() {
    let schema = "IFC4";
    let content = two_walls_sharing_a_pset_plus_a_third_sharing_the_leaf(schema);
    let plan = ExportPlan { dispositions: vec![patch_fire_rating(10, "'2HR'")], context: PlanContext::default() };
    let mut out = Vec::new();
    let report = execute(&content, &plan, &mut out).unwrap();
    assert!(report.findings.is_empty(), "{:?}", report.findings);
    let after = entity_lines(&out);

    let wall10 = fire_rating_psets_of(schema, &after, 10);
    assert_eq!(wall10.len(), 1, "{wall10:?}");
    assert!(wall10[0].2.contains("2HR"), "wall 10 holds the patched value: {wall10:?}");

    let wall11 = fire_rating_psets_of(schema, &after, 11);
    assert_eq!(wall11.len(), 1, "{wall11:?}");
    assert!(wall11[0].2.contains("1HR"), "wall 11 keeps the original shared set untouched: {wall11:?}");

    // Wall 12's own Pset_Other (unrelated to the group) still holds the
    // original leaf's value: the set-level clone minted a fresh leaf for
    // wall 10 rather than editing the one wall 12 also points at.
    let raw_leaf = &after[&30];
    assert!(raw_leaf.contains("1HR"), "the original leaf, still named by wall 12's set, must not change: {raw_leaf}");
}

/// An id declared twice is the LAST declaration, at its own position, as core
/// reads it and as the crate's other writers write it (`step_index`). The
/// earlier declaration is dropped and reported, and a GlobalId only it held
/// does not resolve.
#[test]
fn a_repeated_id_keeps_its_last_record_and_reports_the_earlier() {
    let source = b"ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCWALL('0aaaaaaaaaaaaaaaaaaaaa',$,'first',$,$,$,$,$,$);\n#2=IFCLABEL('x');\n#1=IFCWALL('1bbbbbbbbbbbbbbbbbbbbb',$,'second',$,$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n";
    let plan = ExportPlan {
        dispositions: vec![(ObjectRef::Guid("0aaaaaaaaaaaaaaaaaaaaa".into()), Disposition::Delete)],
        context: Default::default(),
    };
    let mut out = Vec::new();
    let report = crate::plan::execute(source, &plan, &mut out).unwrap();
    let text = String::from_utf8(out).unwrap();
    let data = &text[text.find("DATA;").unwrap()..];
    assert!(!data.contains("'first'"), "{data}");
    assert!(data.find("#2=").unwrap() < data.find("'second'").unwrap(), "kept at its own position: {data}");
    assert_eq!(report.refusals.len(), 1, "the GlobalId only the dropped record held is not found: {:?}", report.refusals);
    assert!(report.findings.iter().any(|f| f.express_id == Some(1) && f.message.contains("more than once")), "{:?}", report.findings);
}
