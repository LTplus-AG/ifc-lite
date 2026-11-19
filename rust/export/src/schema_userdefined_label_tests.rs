// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::schema_convert::convert_step_line;
use crate::schema_enum::ConversionChecks;
use crate::schema_ifc2x3_slots::Ifc2x3SlotFill;

fn convert(line: &str, from: &str, to: &str) -> (String, usize, usize) {
    let (mut checks, mut slots) = (ConversionChecks::default(), Ifc2x3SlotFill::new(None));
    let out = convert_step_line(line, from, to, 7, &mut slots, Some(&mut checks)).unwrap();
    (out, checks.attribute_values_dropped, slots.required_slots_unfilled())
}

/// Every table row names real attributes, and the IFC4 type has ObjectType.
#[test]
fn the_table_names_real_attributes_10824() {
    for (ifc2x3, ifc4, kind, label) in LABEL_CARRIES {
        let old = ifc_lite_core::attribute_names_for_schema("IFC2X3", ifc2x3).unwrap();
        assert!(old.contains(kind) && old.contains(label) && old.contains(&"ObjectType"), "{ifc2x3}");
        for schema in ["IFC4", "IFC4X3"] {
            let new = ifc_lite_core::attribute_names_for_schema(schema, ifc4).unwrap();
            assert!(new.contains(&"ObjectType") && new.contains(&"PredefinedType") && !new.contains(label), "{schema} {ifc4}");
        }
    }
}

/// The issue's records: the IFC2X3 label becomes IFC4's ObjectType, and it no
/// longer counts as dropped.
#[test]
fn an_upgrade_writes_the_label_into_an_unset_object_type_10824() {
    for to in ["IFC4", "IFC4X3"] {
        assert_eq!(
            convert("#7=IFCWORKPLAN('g',#2,'P',$,$,'WP',$,$,$,$,$,$,$,.USERDEFINED.,'Custom');", "IFC2X3", to),
            ("#7=IFCWORKPLAN('g',#2,'P',$,'Custom','WP',$,$,$,$,$,$,$,.USERDEFINED.);".to_owned(), 0, 0),
        );
        assert_eq!(
            convert("#7=IFCPROCEDURE('g',#2,'P',$,$,'P-1',.USERDEFINED.,'Flush');", "IFC2X3", to).0,
            "#7=IFCPROCEDURE('g',#2,'P',$,'Flush','P-1',$,.USERDEFINED.);"
        );
        assert_eq!(
            convert("#7=IFCELECTRICDISTRIBUTIONPOINT('g',#2,'n',$,$,$,$,'t',.USERDEFINED.,'Custom');", "IFC2X3", to).0,
            "#7=IFCELECTRICDISTRIBUTIONBOARD('g',#2,'n',$,'Custom',$,$,'t',.USERDEFINED.);"
        );
    }
}

/// A set ObjectType is kept, and the IFC2X3 label is then dropped and
/// counted; a label beside another member is not carried.
#[test]
fn a_set_object_type_or_another_member_keeps_the_label_dropped_10824() {
    let (out, dropped, _) = convert("#7=IFCWORKPLAN('g',#2,'P',$,'Mine','WP',$,$,$,$,$,$,$,.USERDEFINED.,'Custom');", "IFC2X3", "IFC4");
    assert_eq!((out.as_str(), dropped), ("#7=IFCWORKPLAN('g',#2,'P',$,'Mine','WP',$,$,$,$,$,$,$,.USERDEFINED.);", 1));
    let (out, dropped, _) = convert("#7=IFCWORKPLAN('g',#2,'P',$,$,'WP',$,$,$,$,$,$,$,.ACTUAL.,'Custom');", "IFC2X3", "IFC4");
    assert_eq!((out.as_str(), dropped), ("#7=IFCWORKPLAN('g',#2,'P',$,$,'WP',$,$,$,$,$,$,$,.ACTUAL.);", 1));
}

/// The downgrade fills the IFC2X3 label IFC2X3's WHERE rule requires from
/// ObjectType, which IFC2X3 also keeps.
#[test]
fn a_downgrade_writes_object_type_into_the_unset_label_10824() {
    for from in ["IFC4", "IFC4X3"] {
        assert_eq!(
            convert("#7=IFCWORKPLAN('g',#2,'P',$,'Custom','WP',$,$,$,$,$,$,$,.USERDEFINED.);", from, "IFC2X3").0,
            "#7=IFCWORKPLAN('g',#2,'P',$,'Custom','WP',$,$,$,$,$,$,$,.USERDEFINED.,'Custom');"
        );
        assert_eq!(
            convert("#7=IFCPROCEDURE('g',#2,'P',$,'Flush','P-1',$,.USERDEFINED.);", from, "IFC2X3").0,
            "#7=IFCPROCEDURE('g',#2,'P',$,'Flush','P-1',.USERDEFINED.,'Flush');"
        );
    }
    assert_eq!(
        convert("#7=IFCELECTRICDISTRIBUTIONBOARD('g',#2,'n',$,'Custom',$,$,'t',.USERDEFINED.);", "IFC4", "IFC2X3").0,
        "#7=IFCELECTRICDISTRIBUTIONPOINT('g',#2,'n',$,'Custom',$,$,'t',.USERDEFINED.,'Custom');"
    );
    let other = "#7=IFCPROCEDURE('g',#2,'P',$,'Flush','P-1',$,.SHUTDOWN.);";
    assert_eq!(convert(other, "IFC4", "IFC2X3").0, "#7=IFCPROCEDURE('g',#2,'P',$,'Flush','P-1',.SHUTDOWN.,$);", "another member keeps $");
}

#[test]
fn is_userdefined_reads_past_comments_10824() {
    assert!(is_userdefined(" /* x */ .userdefined. "));
    assert!(!is_userdefined(".USERDEFINED.X"));
    assert!(!is_userdefined("$"));
}
