// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::schema_convert::convert_step_line;
use crate::schema_enum::ConversionChecks;
use crate::schema_ifc2x3_slots::Ifc2x3SlotFill;
use ifc_lite_core::attribute_names_for_schema;

/// The table is the shared fixture, entry for entry (the TypeScript twin runs
/// the same comparison).
#[test]
fn the_table_is_the_shared_fixture_10763() {
    let mut doc: serde_json::Value =
        serde_json::from_str(include_str!("../tests/fixtures/schema_attribute_maps.json")).expect("valid JSON");
    let fixture = doc["maps"].as_array_mut().expect("maps");
    fixture.iter_mut().for_each(|m| drop(m.as_object_mut().expect("map").remove("why")));
    assert!(ATTR_MAPS.len() >= 20, "anti-vacuity");
    assert_eq!(serde_json::to_value(ATTR_MAPS).expect("serializes"), doc["maps"]);
}

/// Every name a map lists sits on the side it is listed for in core's
/// registry, IFC4X3 declares the IFC4 list, and no map covers a pair a trim or
/// pad already handles.
#[test]
fn every_map_names_real_attributes_and_a_non_prefix_pair_10763() {
    for m in ATTR_MAPS {
        let old = attribute_names_for_schema("IFC2X3", m.ifc2x3).unwrap_or_else(|| panic!("{} in IFC2X3", m.ifc2x3));
        let new = attribute_names_for_schema("IFC4", m.ifc4).unwrap_or_else(|| panic!("{} in IFC4", m.ifc4));
        assert_eq!(attribute_names_for_schema("IFC4X3", m.ifc4), Some(new), "{}: IFC4X3 declares the IFC4 list", m.ifc4);
        let pairs = m.renamed.iter().chain(m.set_of_one.as_ref());
        for (a, b) in pairs {
            assert!(old.contains(a) && new.contains(b), "{}: {a} -> {b}", m.ifc4);
        }
        for name in m.retyped.iter().chain(m.up_only) {
            assert!(old.contains(name) && new.contains(name), "{}: {name} is in both lists", m.ifc4);
        }
        let prefix = |a: &[&str], b: &[&str]| a.len() < b.len() && b.starts_with(a);
        assert!(!prefix(old, new) && !prefix(new, old) && old != new, "{}: a prefix pair needs no map", m.ifc4);
    }
}

fn up(line: &str) -> String {
    convert_step_line(line, "IFC2X3", "IFC4", 1, &mut Ifc2x3SlotFill::new(None), None).unwrap()
}

fn down(line: &str) -> String {
    convert_step_line(line, "IFC4", "IFC2X3", 1, &mut Ifc2x3SlotFill::new(None), None).unwrap()
}

/// The issue's example: before #10763 the description landed in `Identifier`
/// and the record stayed seven slots long.
#[test]
fn ifc_approval_carries_each_value_to_its_own_slot_10763() {
    let src = "#5=IFCAPPROVAL('desc',#9,'Approved','L1','Q','Name','Id');";
    assert_eq!(up(src), "#5=IFCAPPROVAL('Id','Name','desc',$,'Approved','L1','Q',$,$);");
    // ApprovalDateTime is required in IFC2X3 and has no source; it stays $.
    let ifc4 = "#5=IFCAPPROVAL('Id','Name','desc','2020-01-01','Approved','L1','Q',#7,#8);";
    assert_eq!(down(ifc4), "#5=IFCAPPROVAL('desc',$,'Approved','L1','Q','Name','Id');");
}

#[test]
fn a_single_reference_becomes_a_set_and_back_10763() {
    assert_eq!(up("#5=IFCAPPROVALRELATIONSHIP(#3,#4,'d','n');"), "#5=IFCAPPROVALRELATIONSHIP('n','d',#4,(#3));");
    assert_eq!(down("#5=IFCAPPROVALRELATIONSHIP('n','d',#4,(#3));"), "#5=IFCAPPROVALRELATIONSHIP(#3,#4,'d','n');");
}

/// What each direction cannot carry is counted, including the members of a
/// SET past the first, and an up-only reference is dropped on the way down.
#[test]
fn every_value_without_a_target_slot_is_counted_10763() {
    let dropped = |line: &str, from: &str, to: &str| {
        let mut checks = ConversionChecks::default();
        let out = convert_step_line(line, from, to, 1, &mut Ifc2x3SlotFill::new(None), Some(&mut checks)).unwrap();
        (out, checks.attribute_values_dropped)
    };
    let (out, n) = dropped("#5=IFCAPPROVALRELATIONSHIP('n','d',#4,(#3,#6,#7));", "IFC4", "IFC2X3");
    assert_eq!((out.as_str(), n), ("#5=IFCAPPROVALRELATIONSHIP(#3,#4,'d','n');", 2));
    let (out, n) = dropped("#5=IFCLIBRARYINFORMATION('n','v',#3,'2020-01-01','https://x',$);", "IFC4", "IFC2X3");
    assert_eq!((out.as_str(), n), ("#5=IFCLIBRARYINFORMATION('n','v',$,$,$);", 3));
    let (out, n) = dropped("#5=IFCLIBRARYINFORMATION('n','v',#3,#4,(#6));", "IFC2X3", "IFC4");
    assert_eq!((out.as_str(), n), ("#5=IFCLIBRARYINFORMATION('n','v',#3,$,$,$);", 2));
}

/// IFC4 deleted IfcExtendedMaterialProperties for a concrete
/// IfcMaterialProperties; IFC2X3 cannot instantiate its abstract namesake.
#[test]
fn ifc4_material_and_profile_properties_downgrade_to_the_deleted_subtypes_10763() {
    assert_eq!(
        down("#5=IFCMATERIALPROPERTIES('Pset_x','d',(#6,#7),#8);"),
        "#5=IFCEXTENDEDMATERIALPROPERTIES(#8,(#6,#7),'d','Pset_x');"
    );
    assert_eq!(
        convert_step_line("#5=IFCPROFILEPROPERTIES('n',$,(#6),#8);", "IFC4X3", "IFC2X3", 1, &mut Ifc2x3SlotFill::new(None), None).unwrap(),
        "#5=IFCGENERALPROFILEPROPERTIES($,#8,$,$,$,$,$);"
    );
}

/// A mapped upgrade that leaves an IFC4-required slot `$` is counted, which
/// the IFC2X3 -> IFC4 path otherwise skips.
#[test]
fn a_required_ifc4_slot_with_no_source_is_counted_10763() {
    let mut checks = ConversionChecks::default();
    let out = convert_step_line("#5=IFCTEXTUREMAP((#6));", "IFC2X3", "IFC4", 5, &mut Ifc2x3SlotFill::new(None), Some(&mut checks)).unwrap();
    assert_eq!(out, "#5=IFCTEXTUREMAP($,$,$);");
    assert_eq!(checks.ifc4_slots.required_slots_unfilled(), 3);
    assert_eq!(checks.attribute_values_dropped, 1);
    let mut commented = ConversionChecks::default();
    convert_step_line("/* note = */#5=IFCTEXTUREMAP((#6));", "IFC2X3", "IFC4", 5, &mut Ifc2x3SlotFill::new(None), Some(&mut commented)).unwrap();
    assert_eq!(commented.ifc4_slots.required_slots_unfilled(), 3, "a comment before the record");
}

#[test]
fn first_member_reads_a_list_and_passes_anything_else_through_10763() {
    assert_eq!(first_member("( #3 , #4 )"), ("#3".to_owned(), 1));
    assert_eq!(first_member("#3"), ("#3".to_owned(), 0));
    assert_eq!(first_member("()"), ("$".to_owned(), 0));
    assert_eq!(first_member("/* members */ (#3,#6)"), ("#3".to_owned(), 1), "a comment before the list");
}
