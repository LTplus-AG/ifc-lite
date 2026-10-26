// SPDX-License-Identifier: MPL-2.0
//! Disposition::AddType: a type with no occurrence, declared to the project
//! in IFC4 and IFC4X3 and written on its own in IFC2X3, and later Adds typed
//! by it. Synthetic fixtures only.

use crate::plan::add_test_support::*;
use crate::plan::add_types::*;
use crate::plan::attrs::{build_record, unset_required};
use crate::plan::index::FileIndex;
use crate::plan::test_fixtures::{gid as fixture_gid, storey_with_typed_wall};
use crate::plan::types::*;

fn wall_type(n: u128) -> NewType {
    NewType::new(IfcClass::Named("IfcWallType".into())).with_global_id(gid(n)).with_name(format!("Type {n}"))
}

fn add_type(t: NewType) -> (ObjectRef, Disposition) {
    (ObjectRef::Guid(t.global_id.unwrap().encode()), Disposition::AddType(Box::new(t)))
}

fn assert_valid(out: &[u8], report: &WriteReport, schema: &str) {
    assert_clean(report, schema);
    assert!(crate::plan::validate::validate(out, schema).is_empty(), "{schema}: {:?}", crate::plan::validate::validate(out, schema));
    let index = FileIndex::scan(out, &Default::default());
    for (id, _, _, _) in index.records() {
        let line = index.raw_line(id).unwrap();
        assert!(unset_required(schema, &line).is_empty(), "{schema}: #{id} leaves {:?} unset", unset_required(schema, &line));
    }
}

#[test]
fn types_added_on_their_own_share_one_declaration_to_the_project() {
    for schema in ["IFC4", "IFC4X3"] {
        let source = storey_with_typed_wall(schema);
        let pset = NewPropertySet::new("Pset_WallCommon", PsetKind::Property, vec![NewProperty::new("IsExternal", PropertyValue::Boolean(true))]);
        let (out, report) = run(&source, vec![add_type(wall_type(1).with_psets(vec![pset])), add_type(wall_type(2))]);
        assert_valid(&out, &report, schema);
        assert_eq!(report.added, 2, "{schema}");
        let (a, b) = (id_in(&out, gid(1)), id_in(&out, gid(2)));
        assert_eq!(type_in(&out, a), "IFCWALLTYPE");
        assert_eq!(attr(&out, schema, a, "Name"), "'Type 1'");
        assert_eq!(count(&out, "IFCPROPERTYSET"), 1, "{schema}: the type's own set");
        let declares = ids_of_type(&out, "IFCRELDECLARES");
        assert_eq!(declares.len(), 1, "{schema}: one declaration for both");
        assert_eq!(attr(&out, schema, declares[0], "RelatingContext"), "#1", "{schema}");
        assert_eq!(attr(&out, schema, declares[0], "RelatedDefinitions"), format!("(#{a},#{b})"), "{schema}");
    }
}

#[test]
fn a_projects_existing_declaration_is_extended() {
    for schema in ["IFC4", "IFC4X3"] {
        let fields = [("GlobalId", "'0000000000000000000045'".to_string()), ("RelatingContext", "#1".into()), ("RelatedDefinitions", "(#40)".into())];
        let declared = build_record(schema, 45, "IFCRELDECLARES", &fields) + "\n";
        let source = String::from_utf8(storey_with_typed_wall(schema)).unwrap().replacen("ENDSEC;\nEND-ISO", &format!("{declared}ENDSEC;\nEND-ISO"), 1);
        let (out, report) = run(source.as_bytes(), vec![add_type(wall_type(3))]);
        assert_valid(&out, &report, schema);
        assert_eq!(count(&out, "IFCRELDECLARES"), 1, "{schema}");
        assert_eq!(attr(&out, schema, 45, "RelatedDefinitions"), format!("(#40,#{})", id_in(&out, gid(3))), "{schema}");
    }
}

/// IFC2X3 has no IfcRelDeclares: the type is written on its own.
#[test]
fn an_ifc2x3_type_is_written_on_its_own() {
    let source = storey_with_typed_wall("IFC2X3");
    let (out, report) = run(&source, vec![add_type(wall_type(4))]);
    // Written on its own, and the report says so rather than staying silent.
    let id = id_in(&out, gid(4));
    assert_eq!(report.findings.len(), 1, "{:?}", report.findings);
    assert_eq!(report.findings[0].express_id, Some(id));
    assert!(report.findings[0].message.contains("no IfcRelDeclares"), "{}", report.findings[0].message);
    assert!(crate::plan::validate::validate(&out, "IFC2X3").is_empty());
    assert_eq!(report.added, 1);
    assert_eq!(type_in(&out, id_in(&out, gid(4))), "IFCWALLTYPE");
    assert!(!String::from_utf8(out).unwrap().contains("IFCRELDECLARES"));
}

/// A later Add in the plan is typed by the type through its GlobalId; an
/// earlier one cannot see it yet.
#[test]
fn a_later_add_is_typed_by_a_type_added_on_its_own() {
    for schema in SCHEMAS {
        let source = storey_with_typed_wall(schema);
        let typed = |n| {
            let mut w = object(IfcClass::Wall, gid(n), Some(ObjectRef::Id(70)), Representation::None);
            w.type_link = Some(TypeLink::Existing(ObjectRef::Guid(gid(5).encode())));
            add(w)
        };
        let (out, report) = run(&source, vec![typed(6), add_type(wall_type(5)), typed(7)]);
        assert_eq!(report.added, 2, "{schema}: {:?}", report.refusals);
        assert_eq!(report.refusals.len(), 1, "{schema}");
        assert_eq!(report.refusals[0].object, ObjectRef::Guid(gid(6).encode()), "{schema}: typed before the type exists");
        assert!(crate::plan::validate::validate(&out, schema).is_empty(), "{schema}");
        let rels = crate::relationships(&out);
        assert_eq!(rels.type_of.get(&id_in(&out, gid(7))), Some(&id_in(&out, gid(5))), "{schema}");
    }
}

#[test]
fn a_type_that_cannot_be_added_on_its_own_is_refused() {
    let source = storey_with_typed_wall("IFC4");
    let nameless = NewType::new(IfcClass::Named("IfcWallType".into())).with_global_id(gid(13));
    let (_, report) = run(&source, vec![add_type(nameless.clone())]);
    assert!(report.refusals[0].reason.contains("needs a name"), "{:?}", report.refusals);
    // The same rule for a type created beside its occurrence.
    let mut occurrence = object(IfcClass::Wall, gid(14), Some(ObjectRef::Id(70)), Representation::None);
    occurrence.type_link = Some(TypeLink::New(NewType { global_id: None, ..nameless }));
    let (_, report) = run(&source, vec![add(occurrence)]);
    assert_eq!(report.added, 0);
    assert!(report.refusals[0].reason.contains("a new type needs a name"), "{:?}", report.refusals);
    let no_gid = NewType::new(IfcClass::Named("IfcWallType".into()));
    let (_, report) = run(&source, vec![(ObjectRef::Guid(gid(8).encode()), Disposition::AddType(Box::new(no_gid)))]);
    assert!(report.refusals[0].reason.contains("needs its own GlobalId"), "{:?}", report.refusals);

    let not_a_type = NewType::new(IfcClass::Wall).with_global_id(gid(9)).with_name("Not a type");
    let mismatched = (ObjectRef::Guid(gid(11).encode()), Disposition::AddType(Box::new(wall_type(10))));
    let (out, report) = run(&source, vec![add_type(not_a_type), mismatched]);
    assert_eq!(report.added, 0);
    let reasons: Vec<&str> = report.refusals.iter().map(|r| r.reason.as_str()).collect();
    assert!(reasons[0].contains("not an IFCTYPEPRODUCT"), "{reasons:?}");
    assert!(reasons[1].contains("does not match"), "{reasons:?}");
    assert_eq!(out, run(&source, Vec::new()).0, "a refused type writes nothing");

    // A key naming the fixture's own wall type.
    let (_, report) = run(&source, vec![(ObjectRef::Guid(fixture_gid(40)), Disposition::AddType(Box::new(wall_type(12))))]);
    assert!(report.refusals[0].reason.contains("already exists"), "{:?}", report.refusals);
}
