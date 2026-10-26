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
            context: PlanContext::attributed(),
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
        context: PlanContext { author: Some("tester".into()), organization: None, time_stamp: Some("123".into()), ..Default::default() },
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
        context: PlanContext::attributed(),
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
        context: PlanContext::attributed(),
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
        context: PlanContext::attributed(),
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
        context: PlanContext::attributed(),
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
fn unknown_object_ref_is_refused_not_silently_skipped() {
    let schema = "IFC4";
    let content = wall_with_own_pset(schema);
    let plan = ExportPlan {
        dispositions: vec![(ObjectRef::Id(999_999), Disposition::Delete)],
        context: PlanContext::attributed(),
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
                    target: None,
                }],
                ..Default::default()
            }),
        )],
        context: PlanContext::attributed(),
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
        context: PlanContext::attributed(),
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
        target: None,
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
    let plan = ExportPlan { dispositions: vec![delete(10), patch_fire_rating(11, "'2HR'")], context: PlanContext::attributed() };
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
    let plan = ExportPlan { dispositions: vec![patch_fire_rating(11, "'2HR'"), delete(10)], context: PlanContext::attributed() };
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
    let plan = ExportPlan { dispositions: vec![delete(10), patch_fire_rating(11, "'2HR'")], context: PlanContext::attributed() };
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
        ExportPlan { dispositions: vec![patch_fire_rating(11, "'2HR'"), patch_fire_rating(12, "'3HR'")], context: PlanContext::attributed() };
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
    let plan = ExportPlan { dispositions: vec![patch_fire_rating(10, "'2HR'")], context: PlanContext::attributed() };
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

#[test]
fn patches_of_one_object_compose_but_only_the_first_placement_applies() {
    let content = wall_with_own_pset("IFC4");
    let move_to = |x: f64| PlacementPatch {
        matrix: [[1.0, 0.0, 0.0, x], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]],
    };
    let plan = ExportPlan {
        dispositions: vec![
            (ObjectRef::Id(10), Disposition::Patch(Patch { placement: Some(move_to(1.0)), ..Default::default() })),
            (ObjectRef::Guid(gid(10)), Disposition::Patch(Patch { name: Some("Renamed".into()), placement: Some(move_to(2.0)), ..Default::default() })),
        ],
        context: PlanContext::attributed(),
    };
    let mut out = Vec::new();
    let report = execute(&content, &plan, &mut out).unwrap();
    assert_eq!(report.refusals.len(), 1, "{:?}", report.refusals);
    assert!(report.findings.is_empty(), "{:?}", report.findings);
    let after = entity_lines(&out);
    assert!(after[&10].contains("'Renamed'"), "the second patch's rename still applies");
    let points: Vec<&String> = after.values().filter(|l| l.contains("IFCCARTESIANPOINT((1.,")).collect();
    assert_eq!(points.len(), 1, "the first move is written");
    assert!(!after.values().any(|l| l.contains("IFCCARTESIANPOINT((2.,")), "the second move is not");
}

/// End to end, the export plan's delete (#8078): deleting a host writes a file that still holds its port and
/// type, names nothing it dropped, and validates clean.
#[test]
fn deleting_a_host_writes_its_port_and_type_and_validates() {
    use super::test_fixtures::host_with_port_type_and_body;
    for schema in ["IFC2X3", "IFC4", "IFC4X3"] {
        let content = host_with_port_type_and_body(schema);
        let plan = ExportPlan { dispositions: vec![(ObjectRef::Id(10), Disposition::Delete)], context: PlanContext::attributed() };
        let mut out = Vec::new();
        let report = execute(&content, &plan, &mut out).expect(schema);
        assert!(report.findings.is_empty(), "{schema}: {:?}", report.findings);
        assert!(report.refusals.is_empty(), "{schema}: {:?}", report.refusals);
        let after = entity_lines(&out);
        for id in [11, 14, 15, 20, 32, 40, 42] {
            assert!(after.contains_key(&id), "{schema}: #{id} is written");
        }
        for id in [10, 18, 43, 60, 70] {
            assert!(!after.contains_key(&id), "{schema}: #{id} is gone");
        }
        assert!(after[&32].contains("(#11)"), "{schema}: {}", after[&32]);
    }
}

fn latin1_wall_source() -> Vec<u8> {
    let mut content = two_walls_sharing_a_pset("IFC4");
    let needle = b"Wall 2";
    let at = content.windows(needle.len()).position(|w| w == needle).unwrap();
    content.splice(at..at + needle.len(), b"Gr\xF6sse".iter().copied());
    content
}

/// (#8142)
#[test]
fn untouched_non_utf8_records_are_written_byte_identical() {
    let content = latin1_wall_source();
    let plan = ExportPlan {
        dispositions: vec![(ObjectRef::Id(10), Disposition::Patch(Patch { name: Some("Renamed".into()), ..Default::default() }))],
        context: PlanContext::attributed(),
    };
    let mut out = Vec::new();
    execute(&content, &plan, &mut out).unwrap();
    assert!(out.windows(7).any(|w| w == b"Gr\xF6sse'"), "Latin-1 byte must survive");
    assert!(!out.windows(3).any(|w| w == "\u{FFFD}".as_bytes()), "no replacement character");
}

/// (#8142)
#[test]
fn edited_non_utf8_record_keeps_its_other_bytes() {
    let mut content = latin1_wall_source();
    // Make the record that gets edited carry a Latin-1 byte in a slot the edit leaves alone.
    let needle = b"Wall 1";
    let at = content.windows(needle.len()).position(|w| w == needle).unwrap();
    content.splice(at..at + needle.len(), b"Wall \xF6".iter().copied());
    let plan = ExportPlan {
        dispositions: vec![(ObjectRef::Id(10), Disposition::Patch(Patch { placement: Some(PlacementPatch::new({ let mut m = super::IDENTITY; m[0][3] = 5.0; m })), ..Default::default() }))],
        context: PlanContext::attributed(),
    };
    let mut out = Vec::new();
    execute(&content, &plan, &mut out).unwrap();
    assert!(out.windows(7).any(|w| w == b"Wall \xF6'"), "Latin-1 byte in edited record must survive");
    assert!(!out.windows(3).any(|w| w == "\u{FFFD}".as_bytes()));
}

/// A type-owned set also related to the wall, overridden on the wall, keeps a
/// Latin-1 byte in the type's value (read through the copy) and in the
/// relationship the copy edits.
/// (#8142)
#[test]
fn a_copy_on_write_keeps_latin1_bytes_in_the_original_and_the_edited_relationship() {
    use super::test_fixtures::pset_on_type_also_related_to;
    let mut content = pset_on_type_also_related_to("IFC4", "(#10,#40)");
    let swap = |content: &mut Vec<u8>, from: &[u8], to: &[u8]| {
        let at = content.windows(from.len()).position(|w| w == from).unwrap();
        content.splice(at..at + from.len(), to.iter().copied());
    };
    swap(&mut content, b"'2HR'", b"'2H\xF6'");
    let start = content.windows(4).position(|w| w == b"#44=").unwrap();
    let comma = start + content[start..].windows(7).position(|w| w == b",$,$,$,").unwrap();
    content.splice(comma..comma + 7, b",$,'Gr\xF6sse',$,".iter().copied());
    let write = PropWrite::new("Pset_WallCommon", "FireRating", "IFCLABEL", "'3HR'", PsetKind::Property, PropScope::Occurrence);
    let plan = ExportPlan {
        dispositions: vec![(ObjectRef::Id(10), Disposition::Patch(Patch { psets: vec![write], ..Default::default() }))],
        context: PlanContext::attributed(),
    };
    let mut out = Vec::new();
    let report = execute(&content, &plan, &mut out).unwrap();
    assert!(report.refusals.is_empty(), "{:?}", report.refusals);
    let has = |needle: &[u8]| out.windows(needle.len()).any(|w| w == needle);
    assert!(has(b"2H\xF6'"), "the type's own value");
    assert!(has(b"'Gr\xF6sse'"), "the relationship the copy detached the wall from");
    assert!(!has("\u{FFFD}".as_bytes()));
    assert!(has(b"'3HR'"), "the override was written");
}

/// A caller's STEP literal holding U+F7E9 is written as the caller gave it,
/// not as the single byte E9.
/// (#8142)
#[test]
fn a_caller_literal_with_a_byte_escape_character_is_written_as_given() {
    let write = PropWrite::new("Pset_X", "P", "IFCLABEL", "'a\u{F7E9}b'", PsetKind::Property, PropScope::Occurrence);
    let (out, report) = patch_one(&wall_with_own_pset("IFC4"), vec![write]);
    assert!(report.refusals.is_empty(), "{:?}", report.refusals);
    let has = |needle: &[u8]| out.windows(needle.len()).any(|w| w == needle);
    assert!(has(&[b'a', 0xEF, 0x9F, 0xA9, b'b']));
    assert!(!has(&[b'a', 0xE9, b'b']));
}

/// Valid UTF-8 that looks like an escaped byte is written back unchanged
/// when untouched, and can be edited exactly.
/// (#8142)
#[test]
fn valid_utf8_that_collides_with_the_byte_escape_is_never_corrupted() {
    let mut content = two_walls_sharing_a_pset("IFC4");
    let at = content.windows(6).position(|w| w == b"Wall 2").unwrap();
    content.splice(at..at + 6, "a\u{F7E9}b".bytes());
    let collided = "a\u{F7E9}b".as_bytes();
    let run = |id, name: &str| {
        let plan = ExportPlan {
            dispositions: vec![(ObjectRef::Id(id), Disposition::Patch(Patch { name: Some(name.into()), ..Default::default() }))],
            context: PlanContext::attributed(),
        };
        let mut out = Vec::new();
        let report = execute(&content, &plan, &mut out).unwrap();
        (out, report)
    };
    let (out, _) = run(10, "Renamed");
    assert!(out.windows(collided.len()).any(|w| w == collided), "untouched record keeps its bytes");
    let (out, report) = run(11, "Renamed");
    assert!(!out.windows(collided.len()).any(|w| w == collided), "the edit replaced the name");
    assert!(report.findings.is_empty(), "the edit applied exactly: {:?}", report.findings);
}

/// (#8142)
#[test]
fn deleting_a_storey_reports_the_elements_left_outside_the_spatial_tree() {
    use super::test_fixtures::storey_with_typed_wall;
    for schema in ["IFC2X3", "IFC4", "IFC4X3"] {
        let plan = ExportPlan { dispositions: vec![(ObjectRef::Id(70), Disposition::Delete)], context: PlanContext::attributed() };
        let mut out = Vec::new();
        let report = execute(&storey_with_typed_wall(schema), &plan, &mut out).unwrap();
        let orphan = report.findings.iter().find(|f| f.express_id == Some(10));
        assert!(orphan.is_some_and(|f| f.message.contains("spatial")), "{schema}: {:?}", report.findings);
    }
}

/// `wall_with_own_pset` plus a second `Pset_WallCommon.FireRating` on the same
/// wall (`#60`/`#61`/`#62`), so first-match lookup would pick the wrong record.
fn wall_with_two_same_named_sets() -> Vec<u8> {
    let extra = "#60=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('9HR'),$);\n\
        #61=IFCPROPERTYSET('0000000000000000000061',$,'Pset_WallCommon',$,(#60));\n\
        #62=IFCRELDEFINESBYPROPERTIES('0000000000000000000062',$,$,$,(#10),#61);\n";
    String::from_utf8(wall_with_own_pset("IFC4")).unwrap().replacen("ENDSEC;\nEND-ISO", &format!("{extra}ENDSEC;\nEND-ISO"), 1).into_bytes()
}

fn rate(target: Option<u32>) -> (u32, u32) {
    let mut write = PropWrite::new("Pset_WallCommon", "FireRating", "IFCLABEL", "'NEW'", PsetKind::Property, PropScope::Occurrence);
    if let Some(t) = target {
        write = write.with_target(t);
    }
    let plan = ExportPlan {
        dispositions: vec![(ObjectRef::Id(10), Disposition::Patch(Patch { psets: vec![write], ..Default::default() }))],
        context: PlanContext::attributed(),
    };
    let mut out = Vec::new();
    let report = execute(&wall_with_two_same_named_sets(), &plan, &mut out).unwrap();
    assert!(report.refusals.is_empty(), "{:?}", report.refusals);
    let lines = entity_lines(&out);
    let changed = |id: u32| u32::from(lines[&id].contains("'NEW'"));
    (changed(30), changed(60))
}

/// (#8142)
#[test]
fn a_property_write_can_target_the_exact_record() {
    assert_eq!(rate(None), (1, 0), "no target: first match");
    assert_eq!(rate(Some(60)), (0, 1), "target the second set's record");
    assert_eq!(rate(Some(30)), (1, 0));
}

/// (#8142)
#[test]
fn a_target_the_object_does_not_hold_is_refused() {
    let write = PropWrite::new("Pset_WallCommon", "FireRating", "IFCLABEL", "'NEW'", PsetKind::Property, PropScope::Occurrence).with_target(10);
    let plan = ExportPlan {
        dispositions: vec![(ObjectRef::Id(10), Disposition::Patch(Patch { psets: vec![write], ..Default::default() }))],
        context: PlanContext::attributed(),
    };
    let mut out = Vec::new();
    let report = execute(&wall_with_two_same_named_sets(), &plan, &mut out).unwrap();
    assert_eq!(report.refusals.len(), 1, "{:?}", report.refusals);
    assert!(report.refusals[0].reason.contains("not a member"), "{}", report.refusals[0].reason);
}

fn patch_one(content: &[u8], writes: Vec<PropWrite>) -> (Vec<u8>, WriteReport) {
    let plan = ExportPlan {
        dispositions: vec![(ObjectRef::Id(10), Disposition::Patch(Patch { psets: writes, ..Default::default() }))],
        context: PlanContext::attributed(),
    };
    let mut out = Vec::new();
    let report = execute(content, &plan, &mut out).unwrap();
    (out, report)
}

/// A targeted write to a set another wall shares clones the set: the other
/// wall keeps the original value.
/// (#8142)
#[test]
fn a_targeted_write_to_a_shared_set_is_copied_not_edited() {
    let content = two_walls_sharing_a_pset("IFC4");
    let write = PropWrite::new("Pset_WallCommon", "FireRating", "IFCLABEL", "'NEW'", PsetKind::Property, PropScope::Occurrence).with_target(30);
    let (out, report) = patch_one(&content, vec![write]);
    assert!(report.refusals.is_empty(), "{:?}", report.refusals);
    let lines = entity_lines(&out);
    assert!(lines[&30].contains("'1HR'"), "the shared record is untouched: {}", lines[&30]);
    assert!(lines.values().any(|l| l.contains("'NEW'")), "the copy carries the write");
    assert!(lines[&32].contains("#11") && !lines[&32].contains("#10"), "wall 10 left the shared relationship: {}", lines[&32]);
}

/// A targeted override of a type-owned record, on an object that already has
/// an occurrence set of that name, joins that set; a targeted and an
/// untargeted write to one set are resolved together.
/// (#8142)
#[test]
fn a_targeted_override_of_a_type_owned_record_does_not_duplicate_the_set() {
    use super::test_fixtures::wall_with_type_owned_pset;
    let extra = "#60=IFCPROPERTYSINGLEVALUE('Other',$,IFCLABEL('x'),$);\n\
        #61=IFCPROPERTYSET('0000000000000000000061',$,'Pset_WallCommon',$,(#60));\n\
        #62=IFCRELDEFINESBYPROPERTIES('0000000000000000000062',$,$,$,(#10),#61);\n";
    let content = String::from_utf8(wall_with_type_owned_pset("IFC4")).unwrap().replacen("ENDSEC;\nEND-ISO", &format!("{extra}ENDSEC;\nEND-ISO"), 1);
    let rating = |lit: &str| PropWrite::new("Pset_WallCommon", "FireRating", "IFCLABEL", lit, PsetKind::Property, PropScope::Occurrence);
    let other = PropWrite::new("Pset_WallCommon", "Other", "IFCLABEL", "'y'", PsetKind::Property, PropScope::Occurrence);
    let (out, report) = patch_one(content.as_bytes(), vec![rating("'3HR'").with_target(41), other]);
    assert!(report.refusals.is_empty(), "{:?}", report.refusals);
    assert!(report.findings.is_empty(), "no duplicate set: {:?}", report.findings);
    let text = String::from_utf8(out).unwrap();
    assert_eq!(text.matches("'Pset_WallCommon'").count(), 2, "the type's set and the wall's one: {text}");
    // Untargeted and targeted writes to the same record meet in one set too.
    let (_, report) = patch_one(content.as_bytes(), vec![rating("'3HR'").with_target(41), rating("'4HR'")]);
    assert!(report.findings.is_empty(), "{:?}", report.findings);
}

/// Text the caller supplies is never run through the source-byte encoder: a
/// name holding U+F7E9 is written as the STEP escape for that character.
/// (#8142)
#[test]
fn caller_text_with_a_byte_escape_character_is_written_as_a_step_escape() {
    use super::add_test_support::{add, gid, object};
    use super::add_types::{IfcClass, Representation};
    let name = "a\u{F7E9}b";
    let expect = b"a\\X2\\F7E9\\X0\\b";
    let content = super::test_fixtures::storey_with_typed_wall("IFC4");
    let has = |out: &[u8], needle: &[u8]| out.windows(needle.len()).any(|w| w == needle);
    let mut wall = object(IfcClass::Wall, gid(1), Some(ObjectRef::Id(70)), Representation::None);
    wall.name = Some(name.into());
    let mut out = Vec::new();
    let (key, disposition) = add(wall);
    let plan = ExportPlan { dispositions: vec![(key, disposition)], context: PlanContext::attributed() };
    execute(&content, &plan, &mut out).unwrap();
    assert!(has(&out, expect), "an Add's name");
    assert!(!has(&out, &[b'a', 0xE9, b'b']));
    let plan = ExportPlan {
        dispositions: vec![(ObjectRef::Id(10), Disposition::Patch(Patch { name: Some(name.into()), ..Default::default() }))],
        context: PlanContext::attributed(),
    };
    let mut out = Vec::new();
    execute(&content, &plan, &mut out).unwrap();
    assert!(has(&out, expect), "a renamed record");
    assert!(!has(&out, &[b'a', 0xE9, b'b']));
}

/// The type holds `Pset_A.FireRating` (`#41`) and `Pset_B.FireRating` (`#51`).
fn type_with_two_sets_of_one_property() -> String {
    let extra = "#71=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('BHR'),$);\n\
        #72=IFCPROPERTYSET('0000000000000000000052',$,'Pset_B',$,(#71));\n";
    String::from_utf8(super::test_fixtures::wall_with_type_owned_pset("IFC4"))
        .unwrap()
        .replace("'Pset_WallCommon'", "'Pset_A'")
        .replace("(#42)", "(#42,#72)")
        .replacen("ENDSEC;\nEND-ISO", &format!("{extra}ENDSEC;\nEND-ISO"), 1)
}

fn rating(pset: &str, lit: &str) -> PropWrite {
    PropWrite::new(pset, "FireRating", "IFCLABEL", lit, PsetKind::Property, PropScope::Occurrence)
}

/// A write whose named set does not list its target is refused; it neither
/// resolves the other set nor merges with an untargeted write to it.
/// (#8142)
#[test]
fn a_target_outside_the_named_set_is_refused() {
    let content = type_with_two_sets_of_one_property();
    let (out, report) = patch_one(content.as_bytes(), vec![rating("Pset_B", "'x'").with_target(41), rating("Pset_B", "'y'")]);
    assert_eq!(report.refusals.len(), 1, "{:?}", report.refusals);
    assert!(report.refusals[0].reason.contains("not a member of the named set"), "{}", report.refusals[0].reason);
    let text = String::from_utf8(out).unwrap();
    assert!(text.contains("'y'") && !text.contains("'x'"));
    // Targeting each record under its own set name overrides both sets.
    let (out, report) = patch_one(content.as_bytes(), vec![rating("Pset_A", "'x'").with_target(41), rating("Pset_B", "'y'").with_target(71)]);
    assert!(report.refusals.is_empty() && report.findings.is_empty(), "{:?} {:?}", report.refusals, report.findings);
    let text = String::from_utf8(out).unwrap();
    for name in ["'Pset_A'", "'Pset_B'"] {
        assert!(text.matches(name).count() >= 2, "{name} overridden on the wall: {text}");
    }
}

/// A targeted override of a shared occurrence set keeps that set's name.
/// (#8142)
#[test]
fn a_shared_set_copy_keeps_the_name_of_the_set_it_copies() {
    let content = String::from_utf8(two_walls_sharing_a_pset("IFC4")).unwrap().replace("'Pset_WallCommon'", "'Pset_Caf\\X2\\00E9\\X0\\'");
    let write = rating("Pset_Caf\u{E9}", "'NEW'").with_target(30);
    let (out, report) = patch_one(content.as_bytes(), vec![write]);
    assert!(report.refusals.is_empty(), "{:?}", report.refusals);
    let text = String::from_utf8(out).unwrap();
    assert_eq!(text.matches("'Pset_Caf\\X2\\00E9\\X0\\'").count(), 2, "original and copy: {text}");
}

/// IfcRelAggregates also decomposes assemblies: deleting one does not take
/// its still-contained parts out of the spatial tree, but a part with no
/// other place in the tree is still reported when its spatial parent goes.
/// (#8142)
#[test]
fn deleting_an_assembly_does_not_flag_parts_that_are_still_contained() {
    use super::test_fixtures::storey_with_typed_wall;
    let extra = "#90=IFCELEMENTASSEMBLY('0000000000000000000090',$,'Assembly',$,$,$,$,$,$);\n\
        #91=IFCRELAGGREGATES('0000000000000000000091',$,$,$,#90,(#10));\n";
    let content = String::from_utf8(storey_with_typed_wall("IFC4")).unwrap().replacen("ENDSEC;\nEND-ISO", &format!("{extra}ENDSEC;\nEND-ISO"), 1);
    let delete = |id| {
        let plan = ExportPlan { dispositions: vec![(ObjectRef::Id(id), Disposition::Delete)], context: PlanContext::attributed() };
        execute(content.as_bytes(), &plan, &mut Vec::new()).unwrap()
    };
    let report = delete(90);
    assert!(!report.findings.iter().any(|f| f.express_id == Some(10)), "{:?}", report.findings);
    // The storey goes: the wall's only containment is gone, the assembly
    // aggregation is not a place in the spatial tree.
    let report = delete(70);
    assert!(report.findings.iter().any(|f| f.express_id == Some(10) && f.message.contains("spatial")), "{:?}", report.findings);
}

/// An aggregation leaves its children outside the spatial tree only when
/// its parent was a place in it: a zone's child zone is not reported, a
/// building's storey is. Containment always placed its elements, so a wall
/// contained in a deleted zone is reported. (#8142)
#[test]
fn only_a_deleted_place_in_the_spatial_tree_reports_its_children() {
    use super::test_fixtures::storey_with_typed_wall;
    for schema in ["IFC4", "IFC4X3"] {
        let extra = "#90=IFCSPATIALZONE('0000000000000000000090',$,'Outer',$,$,$,$,$,.NOTDEFINED.);\n\
            #92=IFCSPATIALZONE('0000000000000000000092',$,'Inner',$,$,$,$,$,.NOTDEFINED.);\n\
            #93=IFCWALL('0000000000000000000093',$,'Zoned',$,$,$,$,$,$);\n\
            #91=IFCRELAGGREGATES('0000000000000000000091',$,$,$,#90,(#92));\n\
            #94=IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000094',$,$,$,(#93),#90);\n";
        let content = String::from_utf8(storey_with_typed_wall(schema)).unwrap().replacen("ENDSEC;\nEND-ISO", &format!("{extra}ENDSEC;\nEND-ISO"), 1);
        let delete = |id| {
            let plan = ExportPlan { dispositions: vec![(ObjectRef::Id(id), Disposition::Delete)], context: PlanContext::attributed() };
            execute(content.as_bytes(), &plan, &mut Vec::new()).unwrap()
        };
        let report = delete(90);
        assert!(!report.findings.iter().any(|f| f.express_id == Some(92)), "{schema}: {:?}", report.findings);
        assert!(report.findings.iter().any(|f| f.express_id == Some(93) && f.message.contains("container")), "{schema}: {:?}", report.findings);
        // The project #1 aggregates the building #60, which stays.
        let report = delete(1);
        assert!(report.findings.iter().any(|f| f.express_id == Some(60) && f.message.contains("parent")), "{schema}: {:?}", report.findings);
        // The building #60 aggregates the storey #70, which stays.
        let report = delete(60);
        assert!(report.findings.iter().any(|f| f.express_id == Some(70) && f.message.contains("spatial")), "{schema}: {:?}", report.findings);
    }
}

/// A containment that goes because it named another deleted record (here
/// its owner history) still takes its elements out of the spatial tree; the
/// finding says why instead of claiming the container was deleted. (#8142)
#[test]
fn a_containment_removed_for_another_reference_is_reported_with_its_cause() {
    use super::test_fixtures::storey_with_typed_wall;
    let base = String::from_utf8(storey_with_typed_wall("IFC4")).unwrap();
    let at = base.find("#80=").unwrap();
    let (head, rel) = base.split_at(at);
    let rel = rel.replacen(",$,", ",#96,", 1);
    let content = format!("{head}{rel}").replacen("ENDSEC;\nEND-ISO", "#96=IFCOWNERHISTORY($,$,$,.NOCHANGE.,$,$,$,0);\nENDSEC;\nEND-ISO", 1);
    let plan = ExportPlan { dispositions: vec![(ObjectRef::Id(96), Disposition::Delete)], context: PlanContext::attributed() };
    let report = execute(content.as_bytes(), &plan, &mut Vec::new()).unwrap();
    assert!(report.removed.iter().any(|r| r.express_id == 80), "{:?}", report.removed);
    let f = report.findings.iter().find(|f| f.express_id == Some(10)).expect("wall reported");
    assert!(f.message.contains("referenced a deleted record") && !f.message.contains("was deleted"), "{}", f.message);
}

/// Deleting a containment relationship itself takes its elements out of the
/// spatial tree too. (#8142)
#[test]
fn deleting_a_containment_reports_its_elements() {
    use super::test_fixtures::storey_with_typed_wall;
    for schema in ["IFC4", "IFC4X3"] {
        let content = storey_with_typed_wall(schema);
        let plan = ExportPlan { dispositions: vec![(ObjectRef::Id(80), Disposition::Delete)], context: PlanContext::attributed() };
        let report = execute(&content, &plan, &mut Vec::new()).unwrap();
        let f = report.findings.iter().find(|f| f.express_id == Some(10)).expect("wall reported");
        assert!(f.message.contains("#80") && f.message.contains("#70") && f.message.contains("was deleted"), "{schema}: {}", f.message);
    }
}

/// Deleting a member of a shared relationship whose record cannot be edited
/// exactly must not leave that relationship naming the deleted member.
/// (#8142)
#[test]
fn a_required_edit_that_cannot_be_written_never_leaves_a_dangling_reference() {
    let base = String::from_utf8(two_walls_sharing_a_pset("IFC4")).unwrap();
    let at = base.find("#32=").unwrap();
    let (head, rel) = base.split_at(at);
    let content = format!("{head}{}", rel.replacen(",$,", ",'a\u{F7E9}b',", 1));
    let plan = ExportPlan { dispositions: vec![(ObjectRef::Id(10), Disposition::Delete)], context: PlanContext::attributed() };
    let mut out = Vec::new();
    let result = execute(content.as_bytes(), &plan, &mut out);
    let text = String::from_utf8_lossy(&out);
    let dangling = text.lines().any(|l| l.starts_with("#32=") && l.contains("#10"));
    assert!(result.is_err() || !dangling, "{result:?}\n{text}");
}

/// Writes are deduped on the record they resolve to, the later one winning:
/// a targeted and an untargeted write to one record leave one new value.
/// (#8142)
#[test]
fn a_targeted_and_an_untargeted_write_to_one_record_dedupe() {
    let content = two_walls_sharing_a_pset("IFC4");
    let (out, report) = patch_one(&content, vec![rating("Pset_WallCommon", "'AAA'").with_target(30), rating("Pset_WallCommon", "'BBB'")]);
    assert!(report.refusals.is_empty() && report.findings.is_empty(), "{:?} {:?}", report.refusals, report.findings);
    let text = String::from_utf8(out).unwrap();
    assert_eq!(text.matches("'BBB'").count(), 1, "{text}");
    assert_eq!(text.matches("'AAA'").count(), 0, "{text}");
}

/// A target in none of the object's sets is refused alone, before grouping.
/// (#8142)
#[test]
fn a_target_in_no_set_of_the_object_is_refused_without_its_neighbours() {
    let content = wall_with_two_same_named_sets();
    // Neither names a set the object has, so both would share one group.
    let other = PropWrite::new("Pset_New", "Other", "IFCLABEL", "'ok'", PsetKind::Property, PropScope::Occurrence);
    let (out, report) = patch_one(&content, vec![rating("Pset_New", "'x'").with_target(99), other]);
    assert_eq!(report.refusals.len(), 1, "{:?}", report.refusals);
    assert!(report.refusals[0].reason.contains("not a member of any set"), "{}", report.refusals[0].reason);
    assert!(String::from_utf8(out).unwrap().contains("'ok'"), "the valid write still lands");
}

/// A target whose own name is not the write's property is refused.
/// (#8142)
#[test]
fn a_target_named_differently_from_the_write_is_refused() {
    let content = wall_with_two_same_named_sets();
    let other = PropWrite::new("Pset_WallCommon", "Other", "IFCLABEL", "'x'", PsetKind::Property, PropScope::Occurrence).with_target(60);
    let (_, report) = patch_one(&content, vec![other]);
    assert_eq!(report.refusals.len(), 1, "{:?}", report.refusals);
    assert!(report.refusals[0].reason.contains("is named FireRating"), "{}", report.refusals[0].reason);
}

/// The refusal for a value of the wrong type names the property once.
/// (#8142)
#[test]
fn a_refused_value_names_its_property_once() {
    let bad = PropWrite::new("Pset_X", "P", "IFCLENGTHMEASURE", "'abc'", PsetKind::Property, PropScope::Occurrence);
    let (_, report) = patch_one(&wall_with_own_pset("IFC4"), vec![bad]);
    assert_eq!(report.refusals[0].reason, "Pset_X.P: 'abc' is not a valid IfcLengthMeasure value");
}

/// Quantities are held to the same rule as an Add's (not negative, no
/// measure WHERE rule), a well-formed STEP binary (`"0A"`) is accepted, and
/// an IFC4X3-only measure is accepted in IFC4X3.
/// (#8142)
#[test]
fn quantity_and_unlisted_measures_follow_the_add_rule() {
    let zero = PropWrite::new("Qto_X", "L", "IFCPOSITIVELENGTHMEASURE", "0.", PsetKind::Quantity, PropScope::Occurrence);
    let (_, report) = patch_one(&wall_with_own_pset("IFC4"), vec![zero]);
    assert!(report.refusals.is_empty(), "{:?}", report.refusals);
    let binary = PropWrite::new("Pset_X", "U", "IFCBINARY", "\"0A\"", PsetKind::Property, PropScope::Occurrence);
    let (_, report) = patch_one(&wall_with_own_pset("IFC4"), vec![binary]);
    assert!(report.refusals.is_empty(), "{:?}", report.refusals);
    let uri = PropWrite::new("Pset_X", "U", "IFCURIREFERENCE", "'http://example.org/a'", PsetKind::Property, PropScope::Occurrence);
    let (_, report) = patch_one(&wall_with_own_pset("IFC4X3"), vec![uri]);
    assert!(report.refusals.is_empty(), "{:?}", report.refusals);
}

/// (#8142) An occurrence override of a type-owned record resolves like an
/// untargeted write, so it dedupes with one that reaches the object's own
/// member of that name and leaves no orphan record.
#[test]
fn an_override_of_a_type_owned_record_dedupes_with_an_untargeted_write_8142() {
    use super::test_fixtures::wall_with_type_owned_pset;
    let extra = "#60=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('9HR'),$);\n\
        #61=IFCPROPERTYSET('0000000000000000000061',$,'Pset_WallCommon',$,(#60));\n\
        #62=IFCRELDEFINESBYPROPERTIES('0000000000000000000062',$,$,$,(#10,#40),#61);\n";
    let content = String::from_utf8(wall_with_type_owned_pset("IFC4")).unwrap().replacen("ENDSEC;\nEND-ISO", &format!("{extra}ENDSEC;\nEND-ISO"), 1);
    let (out, report) = patch_one(content.as_bytes(), vec![rating("Pset_WallCommon", "'AAA'").with_target(41), rating("Pset_WallCommon", "'BBB'")]);
    assert!(report.refusals.is_empty() && report.findings.is_empty(), "{:?} {:?}", report.refusals, report.findings);
    let text = String::from_utf8(out).unwrap();
    assert_eq!(text.matches("'AAA'").count(), 0, "{text}");
    assert_eq!(text.matches("'BBB'").count(), 1, "{text}");
}

/// (#8142) A value record two sets list is found through the set the write names.
#[test]
fn a_target_listed_by_two_sets_resolves_through_the_named_one_8142() {
    let extra = "#61=IFCPROPERTYSET('0000000000000000000061',$,'Pset_B',$,(#30));\n\
        #62=IFCRELDEFINESBYPROPERTIES('0000000000000000000062',$,$,$,(#10),#61);\n";
    let content = String::from_utf8(wall_with_own_pset("IFC4")).unwrap().replacen("ENDSEC;\nEND-ISO", &format!("{extra}ENDSEC;\nEND-ISO"), 1);
    let (out, report) = patch_one(content.as_bytes(), vec![rating("Pset_B", "'x'").with_target(30)]);
    assert!(report.refusals.is_empty(), "{:?}", report.refusals);
    let lines = entity_lines(&out);
    // The shared value record, and the set that keeps it, are untouched.
    assert!(lines[&30].contains("'1HR'"), "{}", lines[&30]);
    assert!(lines[&31].contains("(#30)"), "Pset_WallCommon still lists it: {}", lines[&31]);
    // Pset_B, the named set, now lists a new record carrying the write.
    let new_member: u32 = lines[&61].rsplit_once("(#").and_then(|(_, r)| r.split(')').next()).and_then(|n| n.parse().ok()).expect("Pset_B lists one member");
    assert_ne!(new_member, 30, "{}", lines[&61]);
    assert!(lines[&new_member].contains("'x'"), "{}", lines[&new_member]);
}

/// (#8142) An override of a type-owned record takes its unit from the record
/// targeted, not from the first set of that name.
#[test]
fn an_override_takes_the_unit_of_the_record_it_targets_8142() {
    use super::test_fixtures::wall_with_type_owned_pset;
    let extra = "#55=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);\n\
        #54=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('2'),#55);\n\
        #53=IFCPROPERTYSET('0000000000000000000053',$,'Pset_A',$,(#54));\n";
    let content = String::from_utf8(wall_with_type_owned_pset("IFC4"))
        .unwrap()
        .replace("'Pset_WallCommon'", "'Pset_A'")
        .replace("IFCLABEL('2HR'),$)", "IFCLABEL('2HR'),#51)")
        .replace("(#42)", "(#42,#53)")
        .replacen("ENDSEC;\nEND-ISO", &format!("{extra}ENDSEC;\nEND-ISO"), 1);
    let (out, report) = patch_one(content.as_bytes(), vec![rating("Pset_A", "'3HR'").with_target(54)]);
    assert!(report.refusals.is_empty(), "{:?}", report.refusals);
    let text = String::from_utf8(out).unwrap();
    let line = text.lines().find(|l| l.contains("'3HR'")).expect("the override");
    assert!(line.ends_with(",#55);"), "unit of the targeted record, not of #41: {line}");
}

/// (#8142) An override of a type-owned record that has no unit writes none,
/// rather than taking the unit of a same-named record in another set.
#[test]
fn an_override_of_a_record_without_a_unit_writes_none_8142() {
    use super::test_fixtures::wall_with_type_owned_pset;
    let extra = "#54=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('2'),$);\n\
        #53=IFCPROPERTYSET('0000000000000000000053',$,'Pset_A',$,(#54));\n";
    let content = String::from_utf8(wall_with_type_owned_pset("IFC4"))
        .unwrap()
        .replace("'Pset_WallCommon'", "'Pset_A'")
        .replace("IFCLABEL('2HR'),$)", "IFCLABEL('2HR'),#51)")
        .replace("(#42)", "(#42,#53)")
        .replacen("ENDSEC;\nEND-ISO", &format!("{extra}ENDSEC;\nEND-ISO"), 1);
    let (out, report) = patch_one(content.as_bytes(), vec![rating("Pset_A", "'3HR'").with_target(54)]);
    assert!(report.refusals.is_empty(), "{:?}", report.refusals);
    let text = String::from_utf8(out).unwrap();
    let line = text.lines().find(|l| l.contains("'3HR'")).expect("the override");
    assert!(line.ends_with(",$);"), "the targeted record has no unit, #41's is not taken: {line}");
}

/// (#8142) A write targeting a type-owned record, on an object whose own set
/// of that name already holds the property, edits the object's own record in
/// place and leaves its unit slot alone: the type record's unit is not copied
/// over it.
#[test]
fn an_in_place_edit_keeps_its_own_unit_slot_when_the_target_is_type_owned_8142() {
    use super::test_fixtures::wall_with_type_owned_pset;
    let extra = "#60=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('9HR'),$);\n\
        #61=IFCPROPERTYSET('0000000000000000000061',$,'Pset_WallCommon',$,(#60));\n\
        #62=IFCRELDEFINESBYPROPERTIES('0000000000000000000062',$,$,$,(#10),#61);\n";
    let content = String::from_utf8(wall_with_type_owned_pset("IFC4"))
        .unwrap()
        .replace("IFCLABEL('2HR'),$)", "IFCLABEL('2HR'),#51)")
        .replacen("ENDSEC;\nEND-ISO", &format!("{extra}ENDSEC;\nEND-ISO"), 1);
    let (out, report) = patch_one(content.as_bytes(), vec![rating("Pset_WallCommon", "'3HR'").with_target(41)]);
    assert!(report.refusals.is_empty(), "{:?}", report.refusals);
    let lines = entity_lines(&out);
    assert_eq!(lines[&60], "#60=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('3HR'),$);");
    assert!(lines[&41].contains("'2HR'"), "the type's record is untouched: {}", lines[&41]);
}

/// (#8142) Known gap, pinned as `main` behaves: a count is written as a real
/// in IFC4X3 as in IFC4, though IFC4X3 declares `IfcCountMeasure` over
/// INTEGER. The fix is the follow-up on `fix/ifc4x3-count-measure`.
#[test]
fn a_count_write_is_still_a_real_in_ifc4x3_known_gap_8142() {
    let count = PropWrite::new("Pset_X", "N", "IFCCOUNTMEASURE", "3", PsetKind::Property, PropScope::Occurrence);
    for schema in ["IFC4", "IFC4X3"] {
        let (out, report) = patch_one(&wall_with_own_pset(schema), vec![count.clone()]);
        assert!(report.refusals.is_empty(), "{schema}: {:?}", report.refusals);
        assert!(String::from_utf8(out).unwrap().contains("IFCCOUNTMEASURE(3.),"), "{schema}");
    }
}

/// (#8142) An override targeting a record in the type's second set of a name
/// and an untargeted write of the same property both add that property to
/// the object's new set: one member, the later write's.
#[test]
fn two_overrides_of_one_property_write_one_member_8142() {
    use super::test_fixtures::wall_with_type_owned_pset;
    let extra = "#54=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('2'),$);\n\
        #53=IFCPROPERTYSET('0000000000000000000053',$,'Pset_A',$,(#54));\n";
    let content = String::from_utf8(wall_with_type_owned_pset("IFC4"))
        .unwrap()
        .replace("'Pset_WallCommon'", "'Pset_A'")
        .replace("(#42)", "(#42,#53)")
        .replacen("ENDSEC;\nEND-ISO", &format!("{extra}ENDSEC;\nEND-ISO"), 1);
    let (out, report) = patch_one(content.as_bytes(), vec![rating("Pset_A", "'AAA'").with_target(54), rating("Pset_A", "'BBB'")]);
    assert!(report.refusals.is_empty(), "{:?}", report.refusals);
    let text = String::from_utf8(out).unwrap();
    assert_eq!(text.matches("'AAA'").count(), 0, "{text}");
    assert_eq!(text.matches("'BBB'").count(), 1, "{text}");
}
