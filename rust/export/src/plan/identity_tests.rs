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
    let expected = format!("FILE_NAME('out.ifc','{CHANGED_AT}',(''),(''),'ifc-lite {}','ExampleApp 2.1','');", env!("CARGO_PKG_VERSION"));
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
    assert!(text.contains(&format!("FILE_NAME('new.ifc','{CHANGED_AT}',(''),(''),'ifc-lite {}','ExampleApp 2.1','');", env!("CARGO_PKG_VERSION"))));
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
/// names a MODIFIED one, and is marked only when something about it really
/// changed: its own slots, or (for a set) a member leaf edited in place. The
/// rewritten records with an owner history are returned.
fn assert_modified_exactly_the_rewritten(schema: &str, src: &[u8], out: &[u8]) -> Vec<u32> {
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
        if masked(old) == masked(new) {
            let members = crate::plan::index::parse_attrs(old).unwrap().into_iter().flat_map(|a| a.list.unwrap_or_default()).flatten();
            assert!(members.into_iter().any(|m| changed_leaf(&m)), "{schema}: #{id} is marked modified but nothing of it was rewritten: {new}");
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
        assert_eq!(assert_modified_exactly_the_rewritten(schema, &src, &out), vec![32], "{schema}");
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
        assert_eq!(assert_modified_exactly_the_rewritten(schema, &src, &out), vec![32], "{schema}");
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
        assert_eq!(assert_modified_exactly_the_rewritten(schema, &src, &out), vec![31], "{schema}");
    }
}

/// A type-scoped write modifies the type's set, not the occurrence.
#[test]
fn a_type_scoped_write_modifies_the_types_set_not_the_occurrence() {
    for schema in SCHEMAS {
        let src = owned(&crate::plan::test_fixtures::wall_with_type_owned_pset(schema), schema);
        let (out, report) = export(&src, vec![patch(10, vec![write("Pset_WallCommon", "FireRating", "'X'", PropScope::Type)])], context());
        assert!(report.refusals.is_empty(), "{schema}: {report:?}");
        assert_eq!(assert_modified_exactly_the_rewritten(schema, &src, &out), vec![42], "{schema}");
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
        assert!(assert_modified_exactly_the_rewritten(schema, &src, &out).contains(&1), "{schema}: the project");
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
        assert!(report.findings.is_empty(), "{schema}: {:?}", report.findings);
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
    for state in [".READONLY.", ".READONLYLOCKED.", ".LOCKED."] {
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
    assert!(text.contains(&format!("FILE_NAME('out.ifc','{CHANGED_AT}',")), "{text}");
    let (out, _) = export(&src, vec![rename(10)], PlanContext::new().with_time_stamp("1999-01-01T00:00:00"));
    assert!(String::from_utf8(out).unwrap().contains("'1999-01-01T00:00:00'"));
}
