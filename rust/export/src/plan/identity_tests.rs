// SPDX-License-Identifier: MPL-2.0
//! The exporting application's attribution: ADDED for what a plan adds,
//! MODIFIED for what it patches, nothing for what it leaves, and a header
//! that names the application and the toolkit apart.

use std::collections::HashMap;

use crate::plan::add_test_support::{add, block, gid as new_gid, object, SCHEMAS};
use crate::plan::test_fixtures::{gid, storey_with_typed_wall};

use super::attrs::{attribute_index, build_record};
use super::*;

const CHANGED_AT: &str = "2026-10-23T10:00:00";
const CHANGED_AT_SECONDS: &str = "1792749600";

fn app() -> ExportingApplication {
    ExportingApplication::new("ExampleOrg", "ExampleApp", "example-app", "2.1", CHANGED_AT)
        .with_person(ExportingPerson::new("jdoe", "Jane Doe"))
}

fn context() -> PlanContext {
    PlanContext::new().with_application(app()).with_file_name("out.ifc")
}

/// `storey_with_typed_wall` whose wall `#10` (and, when `second_wall`, a
/// second wall `#11`) names an original owner history `#64` written by
/// "OrigApp".
fn source(schema: &str, second_wall: bool) -> Vec<u8> {
    let mut text = String::from_utf8(storey_with_typed_wall(schema)).unwrap();
    let unset = if schema == "IFC2X3" { "#5" } else { "$" };
    let wall = format!("'{}',{unset},", gid(10));
    assert!(text.contains(&wall), "wall #10 names the fixture's default owner history");
    text = text.replace(&wall, &format!("'{}',#64,", gid(10)));
    let mut records = vec![
        build_record(schema, 60 + 100, "IFCPERSON", &[("Identification", "'orig'".into()), ("Id", "'orig'".into()), ("FamilyName", "'Orig'".into())]),
        build_record(schema, 161, "IFCORGANIZATION", &[("Name", "'OrigCo'".into())]),
        build_record(schema, 162, "IFCPERSONANDORGANIZATION", &[("ThePerson", "#160".into()), ("TheOrganization", "#161".into())]),
        build_record(
            schema,
            163,
            "IFCAPPLICATION",
            &[
                ("ApplicationDeveloper", "#161".into()),
                ("Version", "'1'".into()),
                ("ApplicationFullName", "'OrigApp'".into()),
                ("ApplicationIdentifier", "'orig-app'".into()),
            ],
        ),
        build_record(
            schema,
            164,
            "IFCOWNERHISTORY",
            &[("OwningUser", "#162".into()), ("OwningApplication", "#163".into()), ("ChangeAction", ".ADDED.".into()), ("CreationDate", "1000".into())],
        ),
    ];
    if second_wall {
        records.push(build_record(
            schema,
            11,
            "IFCWALL",
            &[("GlobalId", format!("'{}'", gid(11))), ("OwnerHistory", "#164".into()), ("Name", "'Wall 2'".into())],
        ));
    }
    // Keep the ids the assertions use readable: the original history is #164.
    let mut text = text.replace("#64,", "#164,");
    let body = records.join("\n");
    text = text.replace("ENDSEC;\nEND-ISO", &format!("{body}\nENDSEC;\nEND-ISO"));
    text.into_bytes()
}

fn lines(content: &[u8]) -> HashMap<u32, String> {
    String::from_utf8_lossy(content)
        .lines()
        .filter_map(|l| Some((l.strip_prefix('#')?.split('=').next()?.parse().ok()?, l.to_string())))
        .collect()
}

fn attr(schema: &str, line: &str, entity: &str, name: &str) -> String {
    crate::step_text::attribute_of(line, attribute_index(schema, entity, name).unwrap()).unwrap()
}

fn target(schema: &str, all: &HashMap<u32, String>, line: &str, entity: &str, name: &str) -> String {
    let slot = attr(schema, line, entity, name);
    all[&slot.trim_start_matches('#').parse::<u32>().unwrap()].clone()
}

fn histories(all: &HashMap<u32, String>, action: &str) -> Vec<u32> {
    let mut ids: Vec<u32> = all.iter().filter(|(_, l)| l.contains("=IFCOWNERHISTORY(") && l.contains(action)).map(|(id, _)| *id).collect();
    ids.sort_unstable();
    ids
}

fn rename(id: u32) -> (ObjectRef, Disposition) {
    (ObjectRef::Id(id), Disposition::Patch(Patch { name: Some("Renamed".into()), ..Default::default() }))
}

fn export(source: &[u8], dispositions: Vec<(ObjectRef, Disposition)>, context: PlanContext) -> (Vec<u8>, WriteReport) {
    let plan = ExportPlan { dispositions, context };
    let mut out = Vec::new();
    let report = execute(source, &plan, &mut out).unwrap();
    (out, report)
}

#[test]
fn a_modified_object_keeps_its_owner_and_names_the_exporting_application_as_last_modifier() {
    for schema in SCHEMAS {
        let src = source(schema, true);
        let (out, report) = export(&src, vec![rename(10)], context());
        assert!(report.findings.is_empty() && report.refusals.is_empty(), "{schema}: {report:?}");
        let all = lines(&out);
        let history = target(schema, &all, &all[&10], "IFCWALL", "OwnerHistory");
        let get = |name: &str| attr(schema, &history, "IFCOWNERHISTORY", name);
        assert_eq!(get("ChangeAction"), ".MODIFIED.", "{schema}");
        assert_eq!(get("OwningUser"), "#162", "{schema}");
        assert_eq!(get("OwningApplication"), "#163", "{schema}");
        assert_eq!(get("CreationDate"), "1000", "{schema}");
        assert_eq!(get("LastModifiedDate"), CHANGED_AT_SECONDS, "{schema}");
        let application = target(schema, &all, &history, "IFCOWNERHISTORY", "LastModifyingApplication");
        assert_eq!(attr(schema, &application, "IFCAPPLICATION", "ApplicationFullName"), "'ExampleApp'", "{schema}");
        let user = target(schema, &all, &history, "IFCOWNERHISTORY", "LastModifyingUser");
        let person = target(schema, &all, &user, "IFCPERSONANDORGANIZATION", "ThePerson");
        assert_eq!(attr(schema, &person, "IFCPERSON", "FamilyName"), "'Jane Doe'", "{schema}");
        let organization = target(schema, &all, &user, "IFCPERSONANDORGANIZATION", "TheOrganization");
        assert_eq!(attr(schema, &organization, "IFCORGANIZATION", "Name"), "'ExampleOrg'", "{schema}");
        // The original history is still the original.
        assert_eq!(out_line(&src, 164), all[&164], "{schema}");
    }
}

fn out_line(content: &[u8], id: u32) -> String {
    lines(content).remove(&id).unwrap()
}

#[test]
fn untouched_objects_keep_their_bytes_and_modified_ones_share_one_history_per_original() {
    for schema in SCHEMAS {
        let src = source(schema, true);
        let (out, _) = export(&src, vec![rename(10)], context());
        let (before, after) = (lines(&src), lines(&out));
        assert_eq!(before[&11], after[&11], "{schema}: the untouched wall is byte-identical");
        for id in before.keys().filter(|id| **id != 10) {
            assert_eq!(before[id], after[id], "{schema}: #{id}");
        }

        let (out, _) = export(&src, vec![rename(10), rename(11)], context());
        let all = lines(&out);
        let modified = histories(&all, ".MODIFIED.");
        assert_eq!(modified.len(), 1, "{schema}: one MODIFIED history for the one original");
        assert_eq!(attr(schema, &all[&10], "IFCWALL", "OwnerHistory"), format!("#{}", modified[0]), "{schema}");
        assert_eq!(attr(schema, &all[&11], "IFCWALL", "OwnerHistory"), format!("#{}", modified[0]), "{schema}");
    }
}

#[test]
fn an_added_object_is_added_by_the_exporting_application_and_all_additions_share_one_history() {
    for schema in SCHEMAS {
        let src = source(schema, false);
        let wall = |n: u128| add(object(IfcClass::Wall, new_gid(n), Some(ObjectRef::Id(70)), Representation::Extrusion(block(1.0, 0.2, 2.0))));
        let (out, report) = export(&src, vec![wall(1), wall(2)], context());
        assert!(report.findings.is_empty() && report.refusals.is_empty(), "{schema}: {report:?}");
        let all = lines(&out);
        let added = histories(&all, ".ADDED.");
        // The source's own history is ADDED too; the plan's is the new one.
        let ours: Vec<u32> = added.into_iter().filter(|id| *id > 164).collect();
        assert_eq!(ours.len(), 1, "{schema}");
        let history = &all[&ours[0]];
        let owner = target(schema, &all, history, "IFCOWNERHISTORY", "OwningApplication");
        assert_eq!(attr(schema, &owner, "IFCAPPLICATION", "ApplicationFullName"), "'ExampleApp'", "{schema}");
        assert_eq!(attr(schema, history, "IFCOWNERHISTORY", "CreationDate"), CHANGED_AT_SECONDS, "{schema}");
        let added_walls: Vec<&String> = all.values().filter(|l| l.contains("=IFCWALL(") && !l.starts_with("#10=")).collect();
        assert_eq!(added_walls.len(), 2, "{schema}");
        for line in added_walls {
            assert_eq!(attr(schema, line, "IFCWALL", "OwnerHistory"), format!("#{}", ours[0]), "{schema}");
        }
    }
}

#[test]
fn the_header_names_the_application_the_toolkit_and_the_change() {
    let src = source("IFC4", false);
    let (out, _) = export(&src, vec![rename(10)], context());
    let text = String::from_utf8(out).unwrap();
    let expected = format!("FILE_NAME('out.ifc','{CHANGED_AT}Z',(''),(''),'ifc-lite {}','ExampleOrg - ExampleApp - 2.1','');", env!("CARGO_PKG_VERSION"));
    assert!(text.contains(&expected), "{text}");
}

#[test]
fn same_inputs_give_the_same_bytes() {
    for schema in SCHEMAS {
        let src = source(schema, true);
        let wall = add(object(IfcClass::Wall, new_gid(1), Some(ObjectRef::Id(70)), Representation::None));
        let plan = || vec![rename(10), rename(11), wall.clone()];
        let (a, _) = export(&src, plan(), context());
        let (b, _) = export(&src, plan(), context());
        assert_eq!(a, b, "{schema}");
    }
}

#[test]
fn without_an_application_the_source_attribution_stays_and_a_finding_says_so() {
    let src = source("IFC4", false);
    let (out, report) = export(&src, vec![rename(10)], PlanContext::new());
    assert!(report.findings.iter().any(|f| f.message.contains("no ExportingApplication")), "{:?}", report.findings);
    assert_eq!(attr("IFC4", &lines(&out)[&10], "IFCWALL", "OwnerHistory"), "#164");
    let (_, quiet) = export(&src, vec![], PlanContext::new());
    assert!(quiet.findings.is_empty(), "{:?}", quiet.findings);
}

#[test]
fn an_unreadable_change_time_is_reported_and_attribution_stays() {
    let src = source("IFC4", false);
    let bad = ExportingApplication::new("O", "A", "a", "1", "yesterday");
    let (out, report) = export(&src, vec![rename(10)], PlanContext::new().with_application(bad));
    assert!(report.findings.iter().any(|f| f.message.contains("changed_at")), "{:?}", report.findings);
    assert_eq!(attr("IFC4", &lines(&out)[&10], "IFCWALL", "OwnerHistory"), "#164");
}

#[test]
fn a_skeleton_is_owned_and_headed_by_the_exporting_application() {
    let root = |n: u128| SkeletonRoot::new(GlobalId(n));
    let bytes = skeleton(&Skeleton::new(root(1), root(2), root(3)).with_application(app()).with_file_name("new.ifc")).unwrap();
    let all = lines(&bytes);
    let added = histories(&all, ".ADDED.");
    assert_eq!(added.len(), 1);
    for entity in ["IFCPROJECT", "IFCSITE", "IFCBUILDING", "IFCRELAGGREGATES"] {
        let line = all.values().find(|l| l.contains(&format!("={entity}("))).unwrap();
        assert_eq!(attr("IFC4", line, entity, "OwnerHistory"), format!("#{}", added[0]), "{entity}");
    }
    let text = String::from_utf8(bytes.clone()).unwrap();
    assert!(text.contains(&format!("FILE_NAME('new.ifc','{CHANGED_AT}Z',(''),(''),'ifc-lite {}','ExampleOrg - ExampleApp - 2.1','');", env!("CARGO_PKG_VERSION"))));
    // A plan on top of it validates.
    let (_, report) = export(&bytes, vec![], context());
    assert!(report.findings.is_empty(), "{:?}", report.findings);
}

#[test]
fn a_relationship_an_add_extends_is_modified_and_one_identity_serves_both() {
    for schema in SCHEMAS {
        let src = String::from_utf8(source(schema, false)).unwrap();
        let head = "IFCRELCONTAINEDINSPATIALSTRUCTURE('";
        let rel = src.lines().find(|l| l.contains(head)).expect("containment in the fixture");
        let rel_id: u32 = rel.trim_start_matches('#').split('=').next().unwrap().parse().unwrap();
        let rel_gid = rel.split(head).nth(1).unwrap().split('\'').next().unwrap();
        let unset = if schema == "IFC2X3" { "#5" } else { "$" };
        let owned = rel.replacen(&format!("{head}{rel_gid}',{unset},"), &format!("{head}{rel_gid}',#164,"), 1);
        assert_ne!(rel, owned, "{schema}: the fixture relationship names an owner history");
        let src = src.replace(rel, &owned).into_bytes();
        let wall = add(object(IfcClass::Wall, new_gid(1), Some(ObjectRef::Id(70)), Representation::None));
        let (out, report) = export(&src, vec![wall], context());
        assert!(report.findings.is_empty() && report.refusals.is_empty(), "{schema}: {report:?}");
        let all = lines(&out);
        let history = target(schema, &all, &all[&rel_id], "IFCRELCONTAINEDINSPATIALSTRUCTURE", "OwnerHistory");
        assert_eq!(attr(schema, &history, "IFCOWNERHISTORY", "ChangeAction"), ".MODIFIED.", "{schema}");
        assert_eq!(attr(schema, &history, "IFCOWNERHISTORY", "OwningUser"), "#162", "{schema}");
        let applications = all.values().filter(|l| l.contains("'ExampleApp'")).count();
        assert_eq!(applications, 1, "{schema}: one application record for the added wall and the modified relationship");
    }
}

#[test]
fn an_add_that_does_not_build_writes_no_attribution_records() {
    let src = source("IFC4", false);
    let bad_parent = add(object(IfcClass::Wall, new_gid(1), Some(ObjectRef::Id(9999)), Representation::None));
    let (out, report) = export(&src, vec![bad_parent], context());
    assert_eq!(report.added, 0, "{report:?}");
    assert_eq!(lines(&out).len(), lines(&src).len());
}

// ---- What counts as modified: derived from what the plan rewrites. ----

/// `content` with every unset `OwnerHistory` naming one original history
/// `#900` (person, organization, user and application `#901`..`#904`).
fn owned(content: &[u8], schema: &str) -> Vec<u8> {
    let text = String::from_utf8(content.to_vec()).unwrap();
    let mut out = String::new();
    for line in text.lines() {
        let entity = line.split_once('=').and_then(|(_, rest)| rest.split('(').next()).unwrap_or("");
        let slot = attribute_index(schema, entity, "OwnerHistory");
        let line = match slot {
            Some(i) if crate::step_text::attribute_of(line, i).as_deref().map(str::trim) == Some("$") => {
                let edit = std::collections::BTreeMap::from([(i, "#900".to_string())]);
                crate::step_text::apply_attr_mutations_counted(line, &edit, &mut 0)
            }
            _ => line.to_string(),
        };
        out.push_str(&line);
        out.push('\n');
    }
    let chain = [
        build_record(schema, 901, "IFCPERSON", &[("Identification", "'o'".into()), ("Id", "'o'".into()), ("FamilyName", "'O'".into())]),
        build_record(schema, 902, "IFCORGANIZATION", &[("Name", "'OCo'".into())]),
        build_record(schema, 903, "IFCPERSONANDORGANIZATION", &[("ThePerson", "#901".into()), ("TheOrganization", "#902".into())]),
        build_record(
            schema,
            904,
            "IFCAPPLICATION",
            &[("ApplicationDeveloper", "#902".into()), ("Version", "'1'".into()), ("ApplicationFullName", "'OApp'".into()), ("ApplicationIdentifier", "'o-app'".into())],
        ),
        build_record(
            schema,
            900,
            "IFCOWNERHISTORY",
            &[("OwningUser", "#903".into()), ("OwningApplication", "#904".into()), ("ChangeAction", ".ADDED.".into()), ("CreationDate", "1000".into())],
        ),
    ];
    out.replace("ENDSEC;\nEND-ISO", &format!("{}\nENDSEC;\nEND-ISO", chain.join("\n"))).into_bytes()
}

/// Every source record the output rewrote, if it carries an owner history,
/// names a MODIFIED one, and is marked only when the plan patched it or
/// something about it really changed: its own slots, or (for a set) a value
/// it lists edited in place. The rewritten records with an owner history
/// are returned.
fn assert_modified_exactly_the_rewritten(schema: &str, src: &[u8], out: &[u8], patched: &[u32]) -> Vec<u32> {
    let (before, after) = (lines(src), lines(out));
    let changed_leaf = |id: &u32| after.get(id).is_some_and(|l| *l != before[id]);
    let mut marked = Vec::new();
    for (id, old) in &before {
        let Some(new) = after.get(id) else { continue };
        if new == old {
            continue;
        }
        let entity = old.split_once('=').and_then(|(_, r)| r.split('(').next()).unwrap();
        let Some(slot) = attribute_index(schema, entity, "OwnerHistory") else { continue };
        let history = target(schema, &after, new, entity, "OwnerHistory");
        assert_eq!(attr(schema, &history, "IFCOWNERHISTORY", "ChangeAction"), ".MODIFIED.", "{schema}: #{id} {new}");
        let masked = |l: &str| {
            let edit = std::collections::BTreeMap::from([(slot, "#0".to_string())]);
            crate::step_text::apply_attr_mutations_counted(l, &edit, &mut 0)
        };
        if masked(old) == masked(new) && !patched.contains(id) {
            let mut owned = Vec::new();
            crate::step_text::refs_in_line(old.as_bytes(), &mut owned);
            assert!(owned.iter().any(changed_leaf), "{schema}: #{id} is marked modified but nothing of it was rewritten: {new}");
        }
        marked.push(*id);
    }
    marked.sort_unstable();
    marked
}

fn write(pset: &str, prop: &str, literal: &str, scope: PropScope) -> PropWrite {
    PropWrite::new(pset, prop, "IFCLABEL", literal, PsetKind::Property, scope)
}

fn patch(id: u32, writes: Vec<PropWrite>) -> (ObjectRef, Disposition) {
    (ObjectRef::Id(id), Disposition::Patch(Patch { psets: writes, ..Default::default() }))
}

/// (#8142 follow-up) A delete that strips the object from a relationship
/// shared with others modifies that relationship.
#[test]
fn a_relationship_a_delete_strips_is_modified() {
    for schema in SCHEMAS {
        let src = owned(&crate::plan::test_fixtures::three_walls_sharing_a_pset(schema), schema);
        let (out, report) = export(&src, vec![(ObjectRef::Id(12), Disposition::Delete)], context());
        assert!(report.refusals.is_empty(), "{schema}: {report:?}");
        assert_eq!(assert_modified_exactly_the_rewritten(schema, &src, &out, &[]), vec![32], "{schema}");
    }
}

/// A copy-on-write that detaches the object from a shared set's
/// relationship modifies that relationship, not the object.
#[test]
fn a_relationship_a_copy_on_write_detaches_from_is_modified() {
    for schema in SCHEMAS {
        let src = owned(&crate::plan::test_fixtures::two_walls_sharing_a_pset(schema), schema);
        let (out, report) = export(&src, vec![patch(10, vec![write("Pset_WallCommon", "FireRating", "'X'", PropScope::Occurrence)])], context());
        assert!(report.refusals.is_empty(), "{schema}: {report:?}");
        assert_eq!(assert_modified_exactly_the_rewritten(schema, &src, &out, &[10]), vec![10, 32], "{schema}");
    }
}

/// A value edited in place modifies the set that holds it (the value
/// record has no owner history of its own), not the object.
#[test]
fn a_value_edited_in_place_modifies_its_set() {
    for schema in SCHEMAS {
        let src = owned(&crate::plan::test_fixtures::wall_with_own_pset(schema), schema);
        let (out, report) = export(&src, vec![patch(10, vec![write("Pset_WallCommon", "FireRating", "'X'", PropScope::Occurrence)])], context());
        assert!(report.refusals.is_empty(), "{schema}: {report:?}");
        assert_eq!(assert_modified_exactly_the_rewritten(schema, &src, &out, &[10]), vec![10, 31], "{schema}");
    }
}

/// A type-scoped write modifies the type's set, not the occurrence.
#[test]
fn a_type_scoped_write_modifies_the_types_set_not_the_occurrence() {
    for schema in SCHEMAS {
        let src = owned(&crate::plan::test_fixtures::wall_with_type_owned_pset(schema), schema);
        let (out, report) = export(&src, vec![patch(10, vec![write("Pset_WallCommon", "FireRating", "'X'", PropScope::Type)])], context());
        assert!(report.refusals.is_empty(), "{schema}: {report:?}");
        assert_eq!(assert_modified_exactly_the_rewritten(schema, &src, &out, &[10]), vec![10, 42], "{schema}");
    }
}

/// An Add that has to synthesize a body context lists it on the project,
/// which is modified.
#[test]
fn the_project_a_new_context_is_listed_on_is_modified() {
    for schema in SCHEMAS {
        let flat = String::from_utf8(storey_with_typed_wall(schema)).unwrap().replace("'Model',3,", "'Model',2,");
        let src = owned(flat.as_bytes(), schema);
        let wall = add(object(IfcClass::Wall, new_gid(1), Some(ObjectRef::Id(70)), Representation::Extrusion(block(1.0, 0.2, 2.0))));
        let (out, report) = export(&src, vec![wall], context());
        assert!(report.refusals.is_empty(), "{schema}: {report:?}");
        assert!(assert_modified_exactly_the_rewritten(schema, &src, &out, &[]).contains(&1), "{schema}: the project");
    }
}

// ---- Review findings on the attribution records. ----

/// The source already names this application: it is reused (an
/// `ApplicationIdentifier` is UNIQUE), with its developer, and so is the
/// user whose person and organization match.
#[test]
fn an_application_the_source_already_names_is_reused() {
    for schema in SCHEMAS {
        let src = String::from_utf8(source(schema, false)).unwrap();
        let ours = [
            build_record(schema, 170, "IFCPERSON", &[("Identification", "'jdoe'".into()), ("Id", "'jdoe'".into()), ("FamilyName", "'Jane Doe'".into())]),
            build_record(schema, 171, "IFCORGANIZATION", &[("Name", "'ExampleOrg'".into())]),
            build_record(schema, 172, "IFCPERSONANDORGANIZATION", &[("ThePerson", "#170".into()), ("TheOrganization", "#171".into())]),
            build_record(
                schema,
                173,
                "IFCAPPLICATION",
                &[("ApplicationDeveloper", "#171".into()), ("Version", "'2.0'".into()), ("ApplicationFullName", "'ExampleApp'".into()), ("ApplicationIdentifier", "'example-app'".into())],
            ),
        ];
        let src = src.replace("ENDSEC;\nEND-ISO", &format!("{}\nENDSEC;\nEND-ISO", ours.join("\n"))).into_bytes();
        let (out, report) = export(&src, vec![rename(10)], context());
        // Reused, though the source's is another version: UR1 allows one.
        assert_eq!(report.findings.len(), 1, "{schema}: {:?}", report.findings);
        assert!(report.findings[0].message.contains("'2.0'") && report.findings[0].message.contains("'2.1'"), "{schema}: {:?}", report.findings);
        let all = lines(&out);
        assert_eq!(all.values().filter(|l| l.contains("'example-app'")).count(), 1, "{schema}: one application with the identifier");
        let history = target(schema, &all, &all[&10], "IFCWALL", "OwnerHistory");
        assert_eq!(attr(schema, &history, "IFCOWNERHISTORY", "LastModifyingApplication"), "#173", "{schema}");
        assert_eq!(attr(schema, &history, "IFCOWNERHISTORY", "LastModifyingUser"), "#172", "{schema}");
        let users = |all: &HashMap<u32, String>| all.values().filter(|l| l.contains("=IFCPERSONANDORGANIZATION(")).count();
        assert_eq!(users(&all), users(&lines(&src)), "{schema}: no new user");
    }
}

/// A plan whose patches add no record writes no ADDED history.
#[test]
fn a_patch_that_adds_nothing_writes_no_added_history() {
    for schema in SCHEMAS {
        let src = owned(&crate::plan::test_fixtures::wall_with_own_pset(schema), schema);
        let (out, _) = export(&src, vec![patch(10, vec![write("Pset_WallCommon", "FireRating", "'X'", PropScope::Occurrence)])], context());
        let all = lines(&out);
        assert_eq!(histories(&all, ".ADDED.").len(), histories(&lines(&src), ".ADDED.").len(), "{schema}");
    }
}

/// IFC2X3 requires an owner history: a modified object without one is
/// reported. IFC4 makes it optional, so an unset one says nothing.
#[test]
fn a_modified_ifc2x3_object_without_an_owner_history_is_reported() {
    let unset = String::from_utf8(storey_with_typed_wall("IFC2X3")).unwrap().replace(&format!("'{}',#5,", gid(10)), &format!("'{}',$,", gid(10)));
    let (_, report) = export(unset.as_bytes(), vec![rename(10)], context());
    assert!(report.findings.iter().any(|f| f.express_id == Some(10) && f.message.contains("IFC2X3")), "{:?}", report.findings);
    let (_, report) = export(&storey_with_typed_wall("IFC4"), vec![rename(10)], context());
    assert!(report.findings.is_empty(), "{:?}", report.findings);
}

/// An object the source marks read-only or locked is still written, since
/// it was edited, keeps its State, and is reported.
#[test]
fn a_modified_read_only_object_is_reported_and_keeps_its_state() {
    for state in [".READONLY.", ".READONLYLOCKED.", ".LOCKED.", ".READWRITELOCKED."] {
        let schema = "IFC4";
        let src = String::from_utf8(source(schema, false)).unwrap();
        let original = lines(src.as_bytes())[&164].clone();
        let locked = build_record(
            schema,
            164,
            "IFCOWNERHISTORY",
            &[("OwningUser", "#162".into()), ("OwningApplication", "#163".into()), ("State", state.into()), ("ChangeAction", ".ADDED.".into()), ("CreationDate", "1000".into())],
        );
        let src = src.replace(&original, &locked).into_bytes();
        let (out, report) = export(&src, vec![rename(10)], context());
        assert!(report.findings.iter().any(|f| f.express_id == Some(10) && f.message.contains(state)), "{state}: {:?}", report.findings);
        let all = lines(&out);
        assert!(all[&10].contains("'Renamed'"), "{state}");
        let history = target(schema, &all, &all[&10], "IFCWALL", "OwnerHistory");
        assert_eq!(attr(schema, &history, "IFCOWNERHISTORY", "State"), state);
    }
}

/// With an application the header's time is its change time, whatever
/// the context says; without one, the context's time stamp.
#[test]
fn the_header_time_is_the_change_time_with_an_application() {
    let src = source("IFC4", false);
    let (out, _) = export(&src, vec![rename(10)], context().with_time_stamp("1999-01-01T00:00:00"));
    let text = String::from_utf8(out).unwrap();
    assert!(text.contains(&format!("FILE_NAME('out.ifc','{CHANGED_AT}Z',")), "{text}");
    let (out, _) = export(&src, vec![rename(10)], PlanContext::new().with_time_stamp("1999-01-01T00:00:00"));
    assert!(String::from_utf8(out).unwrap().contains("'1999-01-01T00:00:00'"));
}

/// Every `#id` a line of `content` names is a record of it.
fn assert_no_dangling(content: &[u8], what: &str) {
    let all = lines(content);
    for line in all.values() {
        let mut refs = Vec::new();
        crate::step_text::refs_in_line(line.as_bytes(), &mut refs);
        for r in refs {
            assert!(all.contains_key(&r), "{what}: {line} names #{r}, which is not in the file");
        }
    }
}

/// A placement or geometry patch rewrites the product's placement or its
/// representation slot: the product is modified.
#[test]
fn a_placement_or_geometry_patch_modifies_the_product() {
    let moved = Patch::new().with_placement(PlacementPatch::new([[1.0, 0.0, 0.0, 5.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]]));
    let mesh = TriangleMesh::new(vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], vec![[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]]);
    let reshaped = Patch::new().with_geometry(GeometryPatch::new(mesh));
    for schema in SCHEMAS {
        let src = owned(&crate::plan::test_fixtures::wall_with_own_pset(schema), schema);
        for patch in [moved.clone(), reshaped.clone()] {
            let (out, report) = export(&src, vec![(ObjectRef::Id(10), Disposition::Patch(patch))], context());
            assert!(report.refusals.is_empty(), "{schema}: {report:?}");
            assert!(assert_modified_exactly_the_rewritten(schema, &src, &out, &[10]).contains(&10), "{schema}: the wall");
        }
    }
}

/// An application chain the plan's deletes take is not reused: a fresh one
/// is written, and nothing names a removed record.
#[test]
fn a_chain_the_plan_deletes_is_not_reused() {
    for schema in SCHEMAS {
        let src = String::from_utf8(source(schema, false)).unwrap();
        let ours = [
            build_record(schema, 170, "IFCPERSON", &[("Identification", "'jdoe'".into()), ("Id", "'jdoe'".into()), ("FamilyName", "'Jane Doe'".into())]),
            build_record(schema, 171, "IFCORGANIZATION", &[("Name", "'ExampleOrg'".into())]),
            build_record(schema, 172, "IFCPERSONANDORGANIZATION", &[("ThePerson", "#170".into()), ("TheOrganization", "#171".into())]),
            build_record(
                schema,
                173,
                "IFCAPPLICATION",
                &[("ApplicationDeveloper", "#171".into()), ("Version", "'2.1'".into()), ("ApplicationFullName", "'ExampleApp'".into()), ("ApplicationIdentifier", "'example-app'".into())],
            ),
            build_record(schema, 174, "IFCOWNERHISTORY", &[("OwningUser", "#172".into()), ("OwningApplication", "#173".into()), ("ChangeAction", ".ADDED.".into()), ("CreationDate", "1".into())]),
            build_record(schema, 175, "IFCWALL", &[("GlobalId", format!("'{}'", gid(175))), ("OwnerHistory", "#174".into()), ("Name", "'Doomed'".into())]),
        ];
        let src = src.replace("ENDSEC;\nEND-ISO", &format!("{}\nENDSEC;\nEND-ISO", ours.join("\n"))).into_bytes();
        let (out, report) = export(&src, vec![(ObjectRef::Id(175), Disposition::Delete), rename(10)], context());
        assert!(report.refusals.is_empty(), "{schema}: {report:?}");
        assert_no_dangling(&out, schema);
        let all = lines(&out);
        let history = target(schema, &all, &all[&10], "IFCWALL", "OwnerHistory");
        let application = target(schema, &all, &history, "IFCOWNERHISTORY", "LastModifyingApplication");
        assert!(application.contains("'example-app'"), "{schema}: {application}");
    }
}

/// A patch whose every write is refused wrote nothing: its object is not
/// modified or counted as patched, and nothing of the application's chain
/// is written (#8154).
#[test]
fn a_fully_refused_patch_marks_and_writes_nothing() {
    for schema in SCHEMAS {
        let src = owned(&crate::plan::test_fixtures::wall_with_own_pset(schema), schema);
        let bad = PropWrite::new("Pset_New", "L", "IFCLENGTHMEASURE", "'abc'", PsetKind::Property, PropScope::Occurrence);
        let (out, report) = export(&src, vec![patch(10, vec![bad])], context());
        assert_eq!(report.refusals.len(), 1, "{schema}: {report:?}");
        assert_eq!(report.patched, 0, "{schema}: {report:?}");
        assert_eq!(lines(&out)[&10], lines(&src)[&10], "{schema}: the wall is untouched");
        assert!(!String::from_utf8_lossy(&out).contains("'ExampleApp'"), "{schema}: no chain");
    }
}

/// An unreadable change time is one finding, not two.
#[test]
fn an_unreadable_change_time_is_one_finding() {
    let bad = ExportingApplication::new("O", "A", "a", "1", "yesterday");
    let (_, report) = export(&source("IFC4", false), vec![rename(10)], PlanContext::new().with_application(bad));
    assert_eq!(report.findings.len(), 1, "{:?}", report.findings);
}

/// Attribution needs a change time 32-bit readers can hold: seconds in
/// `[0, i32::MAX]`. Outside it the plan keeps the source's attribution and
/// a finding names the value; a bare integer past plausible seconds is
/// named as milliseconds. A skeleton is still written, unattributed.
#[test]
fn a_change_time_outside_32_bits_is_refused_and_named() {
    for (stamp, millis) in [("2040-01-01T00:00:00", false), ("-1", false), ("1792749600000", true), ("6000-01-01T00:00:00", false)] {
        let app = ExportingApplication::new("O", "A", "a", "1", stamp);
        let (out, report) = export(&source("IFC4", false), vec![rename(10)], PlanContext::new().with_application(app.clone()));
        assert_eq!(report.findings.len(), 1, "{stamp}: {:?}", report.findings);
        assert!(report.findings[0].message.contains(stamp), "{stamp}: {:?}", report.findings);
        assert_eq!(report.findings[0].message.contains("milliseconds"), millis, "{stamp}: {:?}", report.findings);
        assert_eq!(attr("IFC4", &lines(&out)[&10], "IFCWALL", "OwnerHistory"), "#164", "{stamp}");
        let root = |n: u128| SkeletonRoot::new(GlobalId(n));
        let unattributed = Skeleton::new(root(1), root(2), root(3)).with_application(app);
        // The plain skeleton refuses an application it cannot attribute to,
        // as before; the reporting one writes it unattributed and says so.
        assert!(skeleton(&unattributed).is_err(), "{stamp}");
        let (bytes, findings) = skeleton_with_findings(&unattributed).unwrap();
        assert!(histories(&lines(&bytes), ".ADDED.").is_empty(), "{stamp}: unattributed");
        assert_eq!(findings.len(), 1, "{stamp}: {findings:?}");
    }
}

/// An IfcMaterialList member deleted: the list, which carries no owner
/// history, is the one record rewritten, and nothing is marked
/// (#8154).
#[test]
fn a_material_list_member_delete_marks_nothing() {
    for schema in SCHEMAS {
        let r = |id, entity, fields: &[(&str, &str)]| {
            let fields: Vec<(&str, String)> = fields.iter().map(|&(n, v)| (n, v.to_string())).collect();
            build_record(schema, id, entity, &fields)
        };
        let records = [
            r(500, "IFCMATERIAL", &[("Name", "'Brick'")]),
            r(501, "IFCMATERIAL", &[("Name", "'Mortar'")]),
            r(502, "IFCMATERIALLIST", &[("Materials", "(#500,#501)")]),
            r(503, "IFCRELASSOCIATESMATERIAL", &[("GlobalId", "'0000000000000000000503'"), ("RelatedObjects", "(#10)"), ("RelatingMaterial", "#502")]),
        ];
        let text = String::from_utf8(storey_with_typed_wall(schema)).unwrap().replace("ENDSEC;\nEND-ISO", &format!("{}\nENDSEC;\nEND-ISO", records.join("\n")));
        let src = owned(text.as_bytes(), schema);
        let (out, report) = export(&src, vec![(ObjectRef::Id(501), Disposition::Delete)], context());
        assert!(report.refusals.is_empty(), "{schema}: {report:?}");
        assert!(assert_modified_exactly_the_rewritten(schema, &src, &out, &[]).is_empty(), "{schema}");
    }
}

/// The history a source supplies and the plan deletes is never settled on.
#[test]
fn a_removed_history_is_not_settled() {
    let src = source("IFC4", false);
    let index = crate::plan::index::FileIndex::complete(&src);
    let context = PlanContext::new();
    // The source's first owner history is #164.
    let history = crate::plan::attribution::Histories::new(&index, "IFC4", None, &context);
    assert_eq!(history.settled(&std::collections::HashSet::from([164])), None);
    assert_eq!(history.settled(&std::collections::HashSet::new()), Some(164));
}


/// A plan that deletes the file's owner history does not name it for the
/// records its patches add.
#[test]
fn a_deleted_owner_history_is_not_named_by_new_records() {
    let src = source("IFC4", false);
    let (out, report) = export(&src, vec![(ObjectRef::Id(164), Disposition::Delete), patch(70, vec![write("Pset_New", "P", "'x'", PropScope::Occurrence)])], PlanContext::new());
    assert!(report.refusals.is_empty(), "{report:?}");
    assert_no_dangling(&out, "IFC4");
}

/// The source's application of this identifier is reused even when its
/// developer cannot be read: one application per identifier (UR1), and the
/// user is given an organization of its own.
#[test]
fn an_application_without_a_readable_developer_is_reused_not_duplicated() {
    let schema = "IFC4";
    let src = String::from_utf8(source(schema, false)).unwrap();
    let app = build_record(
        schema,
        173,
        "IFCAPPLICATION",
        &[("ApplicationDeveloper", "$".into()), ("Version", "'2.1'".into()), ("ApplicationFullName", "'ExampleApp'".into()), ("ApplicationIdentifier", "'example-app'".into())],
    );
    let src = src.replace("ENDSEC;\nEND-ISO", &format!("{app}\nENDSEC;\nEND-ISO")).into_bytes();
    let (out, _) = export(&src, vec![rename(10)], context());
    let all = lines(&out);
    assert_eq!(all.values().filter(|l| l.contains("'example-app'")).count(), 1);
    let history = target(schema, &all, &all[&10], "IFCWALL", "OwnerHistory");
    assert_eq!(attr(schema, &history, "IFCOWNERHISTORY", "LastModifyingApplication"), "#173");
    assert_no_dangling(&out, schema);
}

/// A shape a type's representation map holds loses an item: the shape,
/// which carries no owner history, is the one record rewritten, and nothing
/// is marked (#8154).
#[test]
fn a_rewritten_mapped_shape_marks_nothing() {
    for schema in SCHEMAS {
        let r = |id, entity, fields: &[(&str, &str)]| {
            let fields: Vec<(&str, String)> = fields.iter().map(|&(n, v)| (n, v.to_string())).collect();
            build_record(schema, id, entity, &fields)
        };
        let records = [
            r(400, "IFCWALLTYPE", &[("GlobalId", "'0000000000000000000400'"), ("Name", "'Mapped'"), ("RepresentationMaps", "(#401)"), ("PredefinedType", ".NOTDEFINED.")]),
            r(401, "IFCREPRESENTATIONMAP", &[("MappingOrigin", "#101"), ("MappedRepresentation", "#402")]),
            r(402, "IFCSHAPEREPRESENTATION", &[("ContextOfItems", "#100"), ("RepresentationIdentifier", "'Body'"), ("RepresentationType", "'SweptSolid'"), ("Items", "(#403,#404)")]),
            r(403, "IFCCARTESIANPOINT", &[("Coordinates", "(0.,0.,0.)")]),
            r(404, "IFCCARTESIANPOINT", &[("Coordinates", "(1.,0.,0.)")]),
            r(410, "IFCWALL", &[("GlobalId", "'0000000000000000000410'"), ("Name", "'Instance'"), ("Representation", "#420")]),
            r(420, "IFCPRODUCTDEFINITIONSHAPE", &[("Representations", "(#421)")]),
            r(421, "IFCSHAPEREPRESENTATION", &[("ContextOfItems", "#100"), ("RepresentationIdentifier", "'Body'"), ("RepresentationType", "'MappedRepresentation'"), ("Items", "(#422)")]),
            r(422, "IFCMAPPEDITEM", &[("MappingSource", "#401"), ("MappingTarget", "#423")]),
            r(423, "IFCCARTESIANTRANSFORMATIONOPERATOR3D", &[("LocalOrigin", "#102")]),
        ];
        let text = String::from_utf8(storey_with_typed_wall(schema)).unwrap().replace("ENDSEC;\nEND-ISO", &format!("{}\nENDSEC;\nEND-ISO", records.join("\n")));
        let src = owned(text.as_bytes(), schema);
        let (out, report) = export(&src, vec![(ObjectRef::Id(404), Disposition::Delete)], context());
        assert!(report.refusals.is_empty(), "{schema}: {report:?}");
        assert!(assert_modified_exactly_the_rewritten(schema, &src, &out, &[]).is_empty(), "{schema}");
    }
}

/// The header's time is UTC and says so, whatever offset the change time
/// was given in.
#[test]
fn the_header_time_is_utc() {
    let app = ExportingApplication::new("ExampleOrg", "ExampleApp", "example-app", "2.1", "2026-10-23T12:00:00+02:00");
    let (out, _) = export(&source("IFC4", false), vec![rename(10)], PlanContext::new().with_application(app));
    assert!(String::from_utf8(out).unwrap().contains("'2026-10-23T10:00:00Z'"));
}

/// When the Adds' relationships fail, the ledger keeps nothing the
/// discarded Adds had taken, so nothing later names it.
#[test]
fn a_failed_add_phase_leaves_the_ledger_untouched() {
    use crate::plan::add::AddState;
    use crate::plan::add_types::AddItem;
    use crate::plan::attribution::{Histories, Ledger};
    let mut checked = false;
    for headroom in 5..40 {
        let src = crate::plan::test_fixtures::storey_with_headroom("IFC4", headroom);
        let index = crate::plan::index::FileIndex::complete(&src);
        let plan = ExportPlan { dispositions: Vec::new(), context: context() };
        let mut ledger = Ledger::for_plan(&plan, &mut Vec::new()).unwrap();
        let wall = object(IfcClass::Wall, new_gid(90), Some(ObjectRef::Id(70)), Representation::None);
        let key = ObjectRef::Guid(wall.global_id.encode());
        let adds = [(&key, AddItem::Object(&wall))];
        let (removed, reshaped) = (std::collections::HashSet::new(), std::collections::HashSet::new());
        let mut ids = crate::step_ids::IdAllocator::after(index.max_id);
        let mut refusals = Vec::new();
        let mut history = Histories::new(&index, "IFC4", Some(&mut ledger), &plan.context);
        let built = AddState::new(&index, "IFC4", &removed, &reshaped, &mut history, None).build_all(&adds, &mut ids, &mut HashMap::new(), &mut Vec::new(), &mut refusals, &mut Vec::new());
        if built == 0 && refusals.iter().any(|r| r.reason.contains("relationships for added objects not written")) {
            checked = true;
            assert_eq!(ledger.made.added(), None, "headroom {headroom}: no ADDED history committed");
            assert_eq!(ledger.made.application(), None, "headroom {headroom}: no chain committed");
        }
    }
    assert!(checked, "some headroom fails the relationships after the Add built");
}

/// Deleting an organization's address rewrites the organization, which owns
/// nothing rooted: no IfcRoot is marked modified.
#[test]
fn an_address_delete_marks_nothing_rooted() {
    for schema in SCHEMAS {
        let src = String::from_utf8(owned(&crate::plan::test_fixtures::wall_with_own_pset(schema), schema)).unwrap();
        let src = src.replace("#902=IFCORGANIZATION($,'OCo',$,$,$);", "#902=IFCORGANIZATION($,'OCo',$,$,(#905));").replace(
            "ENDSEC;\nEND-ISO",
            &format!("{}\nENDSEC;\nEND-ISO", build_record(schema, 905, "IFCPOSTALADDRESS", &[("Town", "'Zug'".into())])),
        );
        assert!(src.contains("(#905));"), "{schema}: the organization lists the address");
        let (out, report) = export(src.as_bytes(), vec![(ObjectRef::Id(905), Disposition::Delete)], context());
        assert!(report.refusals.is_empty(), "{schema}: {report:?}");
        assert!(assert_modified_exactly_the_rewritten(schema, src.as_bytes(), &out, &[]).is_empty(), "{schema}");
    }
}

/// A kept application whose developer reference dangles is reused as it is:
/// one application per identifier, the user with an organization of its own.
#[test]
fn an_application_with_a_dangling_developer_is_reused() {
    let schema = "IFC4";
    let src = String::from_utf8(source(schema, false)).unwrap();
    let app = build_record(
        schema,
        173,
        "IFCAPPLICATION",
        &[("ApplicationDeveloper", "#999".into()), ("Version", "'2.1'".into()), ("ApplicationFullName", "'ExampleApp'".into()), ("ApplicationIdentifier", "'example-app'".into())],
    );
    let src = src.replace("ENDSEC;\nEND-ISO", &format!("{app}\nENDSEC;\nEND-ISO")).into_bytes();
    let (out, _) = export(&src, vec![rename(10)], context());
    let all = lines(&out);
    assert_eq!(all.values().filter(|l| l.contains("'example-app'")).count(), 1);
    let history = target(schema, &all, &all[&10], "IFCWALL", "OwnerHistory");
    assert_eq!(attr(schema, &history, "IFCOWNERHISTORY", "LastModifyingApplication"), "#173");
}

/// A source whose wall carries a faceted brep, for the geometry-tree test.
fn wall_with_brep(schema: &str) -> Vec<u8> {
    let r = |id, entity, fields: &[(&str, &str)]| {
        let fields: Vec<(&str, String)> = fields.iter().map(|&(n, v)| (n, v.to_string())).collect();
        build_record(schema, id, entity, &fields)
    };
    let records = [
        r(600, "IFCWALL", &[("GlobalId", "'0000000000000000000600'"), ("Name", "'Brep wall'"), ("Representation", "#601")]),
        r(601, "IFCPRODUCTDEFINITIONSHAPE", &[("Representations", "(#602)")]),
        r(602, "IFCSHAPEREPRESENTATION", &[("ContextOfItems", "#100"), ("RepresentationIdentifier", "'Body'"), ("RepresentationType", "'Brep'"), ("Items", "(#603)")]),
        r(603, "IFCFACETEDBREP", &[("Outer", "#604")]),
        r(604, "IFCCLOSEDSHELL", &[("CfsFaces", "(#605,#606)")]),
        r(605, "IFCFACE", &[("Bounds", "(#607)")]),
        r(606, "IFCFACE", &[("Bounds", "(#607)")]),
        r(607, "IFCFACEOUTERBOUND", &[("Bound", "#608"), ("Orientation", ".T.")]),
        r(608, "IFCPOLYLOOP", &[("Polygon", "(#102,#609,#610)")]),
        r(609, "IFCCARTESIANPOINT", &[("Coordinates", "(1.,0.,0.)")]),
        r(610, "IFCCARTESIANPOINT", &[("Coordinates", "(0.,1.,0.)")]),
    ];
    let text = String::from_utf8(storey_with_typed_wall(schema)).unwrap().replace("ENDSEC;\nEND-ISO", &format!("{}\nENDSEC;\nEND-ISO", records.join("\n")));
    owned(text.as_bytes(), schema)
}


/// A material in a layer set renamed: the material carries no owner
/// history, and nothing is marked (#8154).
#[test]
fn a_layered_material_rename_marks_nothing() {
    for schema in SCHEMAS {
        let r = |id, entity, fields: &[(&str, &str)]| {
            let fields: Vec<(&str, String)> = fields.iter().map(|&(n, v)| (n, v.to_string())).collect();
            build_record(schema, id, entity, &fields)
        };
        let records = [
            r(700, "IFCMATERIAL", &[("Name", "'Brick'")]),
            r(701, "IFCMATERIALLAYER", &[("Material", "#700"), ("LayerThickness", "0.2")]),
            r(702, "IFCMATERIALLAYERSET", &[("MaterialLayers", "(#701)"), ("LayerSetName", "'Wall'")]),
            r(703, "IFCMATERIALLAYERSETUSAGE", &[("ForLayerSet", "#702"), ("LayerSetDirection", ".AXIS2."), ("DirectionSense", ".POSITIVE."), ("OffsetFromReferenceLine", "0.")]),
            r(704, "IFCRELASSOCIATESMATERIAL", &[("GlobalId", "'0000000000000000000704'"), ("RelatedObjects", "(#10)"), ("RelatingMaterial", "#703")]),
        ];
        let text = String::from_utf8(storey_with_typed_wall(schema)).unwrap().replace("ENDSEC;\nEND-ISO", &format!("{}\nENDSEC;\nEND-ISO", records.join("\n")));
        let src = owned(text.as_bytes(), schema);
        let (out, report) = export(&src, vec![rename(700)], context());
        assert!(report.refusals.is_empty(), "{schema}: {report:?}");
        assert!(assert_modified_exactly_the_rewritten(schema, &src, &out, &[]).is_empty(), "{schema}");
    }
}

/// A classification reference renamed: it carries no owner history, and
/// nothing is marked (#8154).
#[test]
fn a_classification_reference_rename_marks_nothing() {
    for schema in SCHEMAS {
        let r = |id, entity, fields: &[(&str, &str)]| {
            let fields: Vec<(&str, String)> = fields.iter().map(|&(n, v)| (n, v.to_string())).collect();
            build_record(schema, id, entity, &fields)
        };
        let records = [
            r(800, "IFCCLASSIFICATIONREFERENCE", &[("Location", "'x'"), ("Name", "'Walls'")]),
            r(801, "IFCRELASSOCIATESCLASSIFICATION", &[("GlobalId", "'0000000000000000000801'"), ("RelatedObjects", "(#10)"), ("RelatingClassification", "#800")]),
        ];
        let text = String::from_utf8(storey_with_typed_wall(schema)).unwrap().replace("ENDSEC;\nEND-ISO", &format!("{}\nENDSEC;\nEND-ISO", records.join("\n")));
        let src = owned(text.as_bytes(), schema);
        let (out, report) = export(&src, vec![rename(800)], context());
        assert!(report.refusals.is_empty(), "{schema}: {report:?}");
        assert!(assert_modified_exactly_the_rewritten(schema, &src, &out, &[]).is_empty(), "{schema}");
    }
}

/// An application whose developer the plan deletes goes with it (the
/// cascade): it is not reused, nothing names the removed developer, and the
/// identifier stays unique.
#[test]
fn an_application_whose_developer_is_deleted_is_not_reused() {
    let schema = "IFC4";
    let src = String::from_utf8(source(schema, false)).unwrap();
    let ours = [
        build_record(schema, 171, "IFCORGANIZATION", &[("Name", "'ExampleOrg'".into())]),
        build_record(
            schema,
            173,
            "IFCAPPLICATION",
            &[("ApplicationDeveloper", "#171".into()), ("Version", "'2.1'".into()), ("ApplicationFullName", "'ExampleApp'".into()), ("ApplicationIdentifier", "'example-app'".into())],
        ),
    ];
    let src = src.replace("ENDSEC;\nEND-ISO", &format!("{}\nENDSEC;\nEND-ISO", ours.join("\n"))).into_bytes();
    let (out, _) = export(&src, vec![(ObjectRef::Id(171), Disposition::Delete), rename(10)], context());
    assert_no_dangling(&out, schema);
    let all = lines(&out);
    assert_eq!(all.values().filter(|l| l.contains("'example-app'")).count(), 1, "one application with the identifier");
    let history = target(schema, &all, &all[&10], "IFCWALL", "OwnerHistory");
    assert_ne!(attr(schema, &history, "IFCOWNERHISTORY", "LastModifyingApplication"), "#173", "the application is not reused");
}


/// `storey_with_typed_wall` with `records` added and every unset owner
/// history naming `#900`.
fn with_records(schema: &str, records: &[String]) -> Vec<u8> {
    let text = String::from_utf8(storey_with_typed_wall(schema)).unwrap().replace("ENDSEC;\nEND-ISO", &format!("{}\nENDSEC;\nEND-ISO", records.join("\n")));
    owned(text.as_bytes(), schema)
}

fn rec(schema: &str, id: u32, entity: &str, fields: &[(&str, &str)]) -> String {
    let fields: Vec<(&str, String)> = fields.iter().map(|&(n, v)| (n, v.to_string())).collect();
    build_record(schema, id, entity, &fields)
}

/// A classification two references name is renamed: it carries no owner
/// history, and nothing is marked or reported (#8154).
#[test]
fn a_shared_classification_rename_marks_nothing() {
    for schema in SCHEMAS {
        let r = |id, entity, fields: &[(&str, &str)]| rec(schema, id, entity, fields);
        let src = with_records(
            schema,
            &[
                r(850, "IFCCLASSIFICATION", &[("Source", "'x'"), ("Edition", "'1'"), ("Name", "'Uniclass'")]),
                r(851, "IFCCLASSIFICATIONREFERENCE", &[("Location", "'a'"), ("ItemReference", "'a'"), ("Identification", "'a'"), ("Name", "'A'"), ("ReferencedSource", "#850")]),
                r(852, "IFCCLASSIFICATIONREFERENCE", &[("Location", "'b'"), ("ItemReference", "'b'"), ("Identification", "'b'"), ("Name", "'B'"), ("ReferencedSource", "#850")]),
                r(853, "IFCRELASSOCIATESCLASSIFICATION", &[("GlobalId", "'0000000000000000000853'"), ("RelatedObjects", "(#10)"), ("RelatingClassification", "#851")]),
                r(854, "IFCRELASSOCIATESCLASSIFICATION", &[("GlobalId", "'0000000000000000000854'"), ("RelatedObjects", "(#60)"), ("RelatingClassification", "#852")]),
            ],
        );
        let (out, report) = export(&src, vec![rename(850)], context());
        assert!(assert_modified_exactly_the_rewritten(schema, &src, &out, &[]).is_empty(), "{schema}");
        assert!(report.findings.is_empty(), "{schema}: {:?}", report.findings);
    }
}




/// A storey's placement patched, with the wall's placement relative to it:
/// the storey is modified, and the wall is not (#8154).
#[test]
fn a_storey_placement_patch_modifies_the_storey() {
    let moved = Patch::new().with_placement(PlacementPatch::new([[1.0, 0.0, 0.0, 5.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 3.0], [0.0, 0.0, 0.0, 1.0]]));
    for schema in SCHEMAS {
        let src = owned(&storey_with_typed_wall(schema), schema);
        assert!(String::from_utf8_lossy(&src).contains("#20=IFCLOCALPLACEMENT(#73,"), "{schema}: the wall is placed relative to the storey");
        let (out, report) = export(&src, vec![(ObjectRef::Id(70), Disposition::Patch(moved.clone()))], context());
        assert!(report.refusals.is_empty(), "{schema}: {report:?}");
        assert_eq!(assert_modified_exactly_the_rewritten(schema, &src, &out, &[70]), vec![70], "{schema}");
    }
}

/// A geometry patch on a wall whose brep is styled and whose material is
/// layered modifies the wall (#8154).
#[test]
fn a_geometry_patch_on_a_styled_layered_brep_wall_modifies_the_wall() {
    let mesh = TriangleMesh::new(vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], vec![[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]]);
    for schema in SCHEMAS {
        let r = |id, entity, fields: &[(&str, &str)]| rec(schema, id, entity, fields);
        let extra = [
            r(620, "IFCSURFACESTYLE", &[("Name", "'Red'"), ("Side", ".BOTH."), ("Styles", "(#621)")]),
            r(621, "IFCSURFACESTYLESHADING", &[("SurfaceColour", "#622")]),
            r(622, "IFCCOLOURRGB", &[("Red", "1."), ("Green", "0."), ("Blue", "0.")]),
            r(623, "IFCSTYLEDITEM", &[("Item", "#603"), ("Styles", "(#620)")]),
            r(700, "IFCMATERIAL", &[("Name", "'Brick'")]),
            r(701, "IFCMATERIALLAYER", &[("Material", "#700"), ("LayerThickness", "0.2")]),
            r(702, "IFCMATERIALLAYERSET", &[("MaterialLayers", "(#701)"), ("LayerSetName", "'Wall'")]),
            r(703, "IFCMATERIALLAYERSETUSAGE", &[("ForLayerSet", "#702"), ("LayerSetDirection", ".AXIS2."), ("DirectionSense", ".POSITIVE."), ("OffsetFromReferenceLine", "0.")]),
            r(704, "IFCRELASSOCIATESMATERIAL", &[("GlobalId", "'0000000000000000000704'"), ("RelatedObjects", "(#600)"), ("RelatingMaterial", "#703")]),
        ];
        let src = String::from_utf8(wall_with_brep(schema)).unwrap().replace("ENDSEC;\nEND-ISO", &format!("{}\nENDSEC;\nEND-ISO", extra.join("\n"))).into_bytes();
        let src = owned(&src, schema);
        let (out, report) = export(&src, vec![(ObjectRef::Id(600), Disposition::Patch(Patch::new().with_geometry(GeometryPatch::new(mesh.clone()))))], context());
        assert!(report.refusals.is_empty(), "{schema}: {report:?}");
        assert!(assert_modified_exactly_the_rewritten(schema, &src, &out, &[600]).contains(&600), "{schema}: the wall");
    }
}

/// UR2: the source's application with this full name and version is
/// reused even under another identifier; a second would repeat the pair
/// (#8154).
#[test]
fn an_application_with_the_same_name_and_version_is_reused() {
    let schema = "IFC4";
    let src = String::from_utf8(source(schema, false)).unwrap();
    let ours = [
        build_record(schema, 171, "IFCORGANIZATION", &[("Name", "'ExampleOrg'".into())]),
        build_record(
            schema,
            173,
            "IFCAPPLICATION",
            &[("ApplicationDeveloper", "#171".into()), ("Version", "'2.1'".into()), ("ApplicationFullName", "'ExampleApp'".into()), ("ApplicationIdentifier", "'other-id'".into())],
        ),
    ];
    let src = src.replace("ENDSEC;\nEND-ISO", &format!("{}\nENDSEC;\nEND-ISO", ours.join("\n"))).into_bytes();
    let (out, report) = export(&src, vec![rename(10)], context());
    // Consumers look the exporter up by identifier: the mismatch is said.
    assert!(report.findings.iter().any(|f| f.message.contains("'other-id'") && f.message.contains("'example-app'")), "{:?}", report.findings);
    let all = lines(&out);
    assert_eq!(all.values().filter(|l| l.contains("=IFCAPPLICATION(") && l.contains("'ExampleApp'")).count(), 1);
    let history = target(schema, &all, &all[&10], "IFCWALL", "OwnerHistory");
    assert_eq!(attr(schema, &history, "IFCOWNERHISTORY", "LastModifyingApplication"), "#173");
}

/// Without an application, the placeholder history reuses the source's
/// placeholder application rather than writing its identifier twice
/// (#8154).
#[test]
fn the_placeholder_history_reuses_the_sources_placeholder_application() {
    let schema = "IFC4";
    let src = String::from_utf8(crate::plan::test_fixtures::wall_with_own_pset(schema)).unwrap();
    let ours = [
        build_record(schema, 171, "IFCORGANIZATION", &[("Name", "'ifc-lite'".into())]),
        build_record(
            schema,
            173,
            "IFCAPPLICATION",
            &[
                ("ApplicationDeveloper", "#171".into()),
                ("Version", "'1.0'".into()),
                ("ApplicationFullName", "'ifc-lite export-plan executor'".into()),
                ("ApplicationIdentifier", "'ifc-lite-export-plan'".into()),
            ],
        ),
    ];
    let src = src.replace("ENDSEC;\nEND-ISO", &format!("{}\nENDSEC;\nEND-ISO", ours.join("\n"))).into_bytes();
    let (out, _) = export(&src, vec![patch(10, vec![write("Pset_New", "P", "'x'", PropScope::Occurrence)])], PlanContext::new());
    assert_eq!(String::from_utf8_lossy(&out).matches("'ifc-lite-export-plan'").count(), 1);
    assert_no_dangling(&out, schema);
}

/// A delete-only plan that rewrites a relationship carrying an owner
/// history, with no application, says it credits the change to the
/// previous author (#8154).
#[test]
fn a_delete_only_plan_without_an_application_says_so() {
    let src = owned(&crate::plan::test_fixtures::three_walls_sharing_a_pset("IFC4"), "IFC4");
    let (_, report) = export(&src, vec![(ObjectRef::Id(12), Disposition::Delete)], PlanContext::new());
    assert!(report.findings.iter().any(|f| f.message.contains("no ExportingApplication")), "{:?}", report.findings);
}

/// Two patches that each write: both count, though the second rewrites what
/// the first did (a second rename; a second write to one shared value,
/// whose copy replaces the first's) (#8154).
#[test]
fn a_repeated_write_still_counts_as_a_patch() {
    for schema in SCHEMAS {
        let (_, report) = export(&source(schema, false), vec![rename(10), rename(10)], context());
        assert_eq!(report.patched, 2, "{schema}: {report:?}");
        let src = crate::plan::test_fixtures::two_walls_separate_sets_sharing_a_leaf(schema);
        let rating = |v: &str| patch(10, vec![write("Pset_WallCommon", "FireRating", v, PropScope::Occurrence)]);
        let (_, report) = export(&src, vec![rating("'A'"), rating("'B'")], context());
        assert!(report.refusals.is_empty(), "{schema}: {report:?}");
        assert_eq!(report.patched, 2, "{schema}: {report:?}");
    }
}

/// A patch that asks for nothing is reported, not dropped silently
/// (#8154).
#[test]
fn an_empty_patch_is_refused() {
    let (_, report) = export(&source("IFC4", false), vec![(ObjectRef::Id(10), Disposition::Patch(Patch::new()))], context());
    assert_eq!(report.patched, 0, "{report:?}");
    assert!(report.refusals.iter().any(|r| r.object == ObjectRef::Id(10) && r.reason.contains("patch changes nothing")), "{report:?}");
}


/// An application reused by name and version that has no identifier is
/// said to have none (#8154).
#[test]
fn a_reused_application_without_an_identifier_is_said_to_have_none() {
    let schema = "IFC4";
    let src = String::from_utf8(source(schema, false)).unwrap();
    let ours = [
        build_record(schema, 171, "IFCORGANIZATION", &[("Name", "'ExampleOrg'".into())]),
        build_record(schema, 173, "IFCAPPLICATION", &[("ApplicationDeveloper", "#171".into()), ("Version", "'2.1'".into()), ("ApplicationFullName", "'ExampleApp'".into())]),
    ];
    let src = src.replace("ENDSEC;\nEND-ISO", &format!("{}\nENDSEC;\nEND-ISO", ours.join("\n"))).into_bytes();
    let (_, report) = export(&src, vec![rename(10)], context());
    assert!(report.findings.iter().any(|f| f.message.contains("with no identifier")), "{:?}", report.findings);
}

/// A quantity edited in place marks the element quantity listing it, and
/// the object patched (#8154).
#[test]
fn a_quantity_edited_in_place_marks_its_element_quantity() {
    for schema in SCHEMAS {
        let src = owned(&crate::plan::test_fixtures::wall_with_type_owned_quantity_set(schema), schema);
        let length = PropWrite::new("Qto_WallBaseQuantities", "Length", "IFCLENGTHMEASURE", "3.5", PsetKind::Quantity, PropScope::Type);
        let (out, report) = export(&src, vec![patch(10, vec![length])], context());
        assert!(report.refusals.is_empty(), "{schema}: {report:?}");
        assert_eq!(assert_modified_exactly_the_rewritten(schema, &src, &out, &[10]), vec![10, 42], "{schema}");
    }
}

/// When the Adds' relationships fail, the output carries nothing they took:
/// no ADDED history, no chain (#8154).
#[test]
fn a_failed_add_phase_leaves_no_attribution_records_in_the_output() {
    let mut checked = false;
    for headroom in 5..40 {
        let src = crate::plan::test_fixtures::storey_with_headroom("IFC4", headroom);
        let wall = add(object(IfcClass::Wall, new_gid(90), Some(ObjectRef::Id(70)), Representation::None));
        let (out, report) = export(&src, vec![wall], context());
        if report.refusals.iter().any(|r| r.reason.contains("relationships for added objects not written")) {
            checked = true;
            let text = String::from_utf8_lossy(&out);
            assert!(!text.contains("IFCOWNERHISTORY(") && !text.contains("'ExampleApp'"), "headroom {headroom}: {text}");
            assert_eq!(lines(&out).len(), lines(&src).len(), "headroom {headroom}: nothing appended");
        }
    }
    assert!(checked, "some headroom fails the relationships after the Add built");
}

/// Deletions are attributed to no one, with or without an application, so
/// a plan that only removes a standalone record has nothing an application
/// would record and gets no missing-application finding (#8154).
#[test]
fn a_delete_of_a_standalone_record_without_an_application_is_not_reported() {
    let src = String::from_utf8(source("IFC4", false)).unwrap().replace("ENDSEC;\nEND-ISO", "#990=IFCCARTESIANPOINT((9.,9.,9.));\nENDSEC;\nEND-ISO");
    let (out, report) = export(src.as_bytes(), vec![(ObjectRef::Id(990), Disposition::Delete)], PlanContext::new());
    assert!(!lines(&out).contains_key(&990));
    assert!(!report.findings.iter().any(|f| f.message.contains("no ExportingApplication")), "{:?}", report.findings);
}

/// The header names the application as buildingSMART's header agreement asks
/// (`Company - Application - Version`), and a name or version that can't be
/// read that way is reported, not rewritten (#8154).
#[test]
fn originating_system_follows_the_header_agreement() {
    let noted = |app: &ExportingApplication| {
        let mut findings = Vec::new();
        super::identity::Identity::resolve(app, &mut findings).unwrap();
        !findings.is_empty()
    };
    assert!(!noted(&app()));
    for (dev, name, version) in [
        ("Example-Org", "ExampleApp", "2.1"),
        ("ExampleOrg", "Example\u{2013}App", "2.1"),
        ("ExampleOrg", "Example\u{FF0D}App", "2.1"),
        ("ExampleOrg ", "ExampleApp", "2.1"),
        ("ExampleOrg", "ExampleApp", "2.1-RC1"),
        ("ExampleOrg", "ExampleApp", "v2.1"),
        ("ExampleOrg", "ExampleApp", ""),
        ("", "ExampleApp", "2.1"),
        ("ExampleOrg", "ExampleApp", "2.1-"),
        ("ExampleOrg", "ExampleApp", "2.1-rc."),
        ("ExampleOrg", "ExampleApp", "2.1-beta..3"),
    ] {
        assert!(noted(&ExportingApplication::new(dev, name, "example-app", version, CHANGED_AT)), "{dev}/{name}/{version}");
    }
    for version in ["2.1-alpha", "2.1-beta.2", "2.1-rc1", "26.0.0.0"] {
        assert!(!noted(&ExportingApplication::new("ExampleOrg", "ExampleApp", "example-app", version, CHANGED_AT)), "{version}");
    }
}

/// A header that doesn't follow the agreement is reported, never a reason to
/// refuse the skeleton; the names are written as given, each in its place
/// (#8154).
#[test]
fn a_nonconforming_application_name_still_writes_the_skeleton() {
    let root = |n: u128| SkeletonRoot::new(GlobalId(n));
    let s = Skeleton::new(root(1), root(2), root(3)).with_application(ExportingApplication::new("LTplus ", "ifc-lite", "ifc-lite", "", CHANGED_AT));
    let bytes = skeleton(&s).expect("written");
    let text = String::from_utf8(bytes).unwrap();
    assert!(text.contains("'LTplus  - ifc-lite - '"), "{text}");
}

/// The header note reaches the caller on both paths, and a conforming
/// application adds none (#8154).
#[test]
fn the_header_note_is_reported_by_the_plan_and_the_skeleton() {
    let dashed = || ExportingApplication::new("Example-Org", "ExampleApp", "example-app", "2.1", CHANGED_AT);
    let note = |findings: &[ValidationFinding]| findings.iter().filter(|f| f.message.contains("header agreement")).count();
    let (_, report) = export(&source("IFC4", false), vec![rename(10)], PlanContext::new().with_application(dashed()));
    assert_eq!(note(&report.findings), 1, "{:?}", report.findings);
    let (_, report) = export(&source("IFC4", false), vec![rename(10)], context());
    assert_eq!(note(&report.findings), 0, "{:?}", report.findings);
    let root = |n: u128| SkeletonRoot::new(GlobalId(n));
    let (_, findings) = skeleton_with_findings(&Skeleton::new(root(1), root(2), root(3)).with_application(dashed())).unwrap();
    assert_eq!(note(&findings), 1, "{findings:?}");
    let (_, findings) = skeleton_with_findings(&Skeleton::new(root(1), root(2), root(3)).with_application(app())).unwrap();
    assert!(findings.is_empty(), "{findings:?}");
}
