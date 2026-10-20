// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! F3e X1 (#7780): where `IfcAlignment.Axis` lives.
//!
//! `Axis` exists in IFC4X1 and IFC4X2 (after `Representation`, at 7). IFC4X3
//! has no such attribute, and its slot 7 is `PredefinedType`. `locate_axis_curve`
//! used to probe `[7, 8, 6]` whatever the file declared, so a 4X3 file with a
//! curve reference at 7 would have it taken for the directrix. It now reads the
//! declared schema's `Axis` slot, then the one off-schema tolerance
//! (`OFF_SCHEMA_AXIS_SLOT`, 8), then `Representation`.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::locate_axis_curve;

/// `#4` is a 10 m polyline and `#6` a 500 m decoy; `#8` carries the decoy as
/// the alignment's `'Axis'` representation. `alignment` is the attribute list.
fn model(schema: &str, alignment: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('{schema}'));\nENDSEC;\nDATA;\n\
#1=IFCCARTESIANPOINT((0.,0.,0.));\n#2=IFCCARTESIANPOINT((10.,0.,0.));\n\
#3=IFCCARTESIANPOINT((500.,0.,0.));\n\
#4=IFCPOLYLINE((#1,#2));\n#6=IFCPOLYLINE((#1,#3));\n\
#7=IFCSHAPEREPRESENTATION($,'Axis','Curve3D',(#6));\n#8=IFCPRODUCTDEFINITIONSHAPE($,$,(#7));\n\
#10=IFCALIGNMENT({alignment});\nENDSEC;\nEND-ISO-10303-21;\n"
    )
}

/// The express id of the located directrix.
fn located(content: &str) -> Option<u32> {
    let mut decoder = EntityDecoder::new(content);
    let alignment = decoder.decode_by_id(10).expect("alignment #10");
    locate_axis_curve(&alignment, &mut decoder).map(|curve| curve.id)
}

#[test]
fn ifc4x1_and_ifc4x2_read_axis_at_7() {
    for schema in ["IFC4X1", "IFC4X2"] {
        // Axis (#4) wins over the Representation decoy (#6) hung at 6.
        let content = model(schema, "'0aBcDeFgHiJkLmNoPqRsT0',$,'A',$,$,$,#8,#4,$");
        assert_eq!(located(&content), Some(4), "{schema}");
    }
}

#[test]
fn an_ifc4x3_reference_at_7_is_predefined_type_not_an_axis() {
    // A non-conforming 4X3 writer put a curve where `PredefinedType` belongs.
    // The 4X3 reading never probes 7, so the 'Axis' representation (#6) wins.
    // Before, the probe took the stray reference (#4) for the directrix.
    let content = model("IFC4X3_ADD2", "'0aBcDeFgHiJkLmNoPqRsT0',$,'A',$,$,$,#8,#4");
    assert_eq!(located(&content), Some(6));
    // The conforming 4X3 form (an enumeration at 7) is unaffected.
    let conforming = model("IFC4X3_ADD2", "'0aBcDeFgHiJkLmNoPqRsT0',$,'A',$,$,$,#8,.USERDEFINED.");
    assert_eq!(located(&conforming), Some(6));
}

#[test]
fn a_mislabelled_ifc4_file_keeps_the_ifc4x1_draft_layout() {
    // IfcAlignment is declared from IFC4X1 on. An IFC2X3/IFC4 label on a file that carries one is
    // an IFC4X1-draft export, and its `Axis` stays at 7 as it always was.
    for schema in ["IFC2X3", "IFC4"] {
        let content = model(schema, "'0aBcDeFgHiJkLmNoPqRsT0',$,'A',$,$,$,#8,#4,$");
        assert_eq!(located(&content), Some(4), "{schema}");
    }
}

#[test]
fn an_unknown_schema_reads_as_ifc4x3() {
    let content = model("NOT_A_SCHEMA", "'0aBcDeFgHiJkLmNoPqRsT0',$,'A',$,$,$,#8,#4");
    assert_eq!(located(&content), Some(6), "an undeclared schema is read as IFC4X3 (D54)");
}

#[test]
fn the_off_schema_slot_is_the_one_kept_tolerance() {
    // A publisher that hung `Axis` at 8 behind a null 7 and no Representation.
    let content = model("IFC4X1", "'0aBcDeFgHiJkLmNoPqRsT0',$,'A',$,$,$,$,$,#4");
    assert_eq!(located(&content), Some(4));
    // Representation (6) is still the last resort.
    let by_representation = model("IFC4X1", "'0aBcDeFgHiJkLmNoPqRsT0',$,'A',$,$,$,#6,$,$");
    assert_eq!(located(&by_representation), Some(6));
}
