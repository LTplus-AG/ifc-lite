// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

const HEADER: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Test'),'2;1');
FILE_NAME('test.ifc','2024-01-01',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
"#;
const FOOTER: &str = "ENDSEC;\nEND-ISO-10303-21;\n";

fn decode(body: &str, id: u32) -> DecodedEntity {
    let content = format!("{HEADER}{body}{FOOTER}");
    let mut decoder = EntityDecoder::new(&content);
    decoder.decode_by_id(id).expect("entity should decode")
}

/// A wrong-type entity wired into a WCS-shaped slot: an
/// `IfcCartesianTransformationOperator3D` with a non-trivial Axis1/Axis2
/// pair. Neither `IfcAxis2Placement2D` nor `…3D`, so a correct
/// implementation must refuse to read it as one. Before the fix, the
/// missing type check let the 2D branch read Axis2 (attr 1) as
/// RefDirection and silently produced a real 90°-rotated transform
/// instead of flagging the mismatch.
#[test]
fn non_placement_entity_is_not_silently_misread() {
    let body = "\
#1=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#2,#3,#4,$,$);
#2=IFCDIRECTION((1.,0.,0.));
#3=IFCDIRECTION((0.,1.,0.));
#4=IFCCARTESIANPOINT((5.,6.,7.));
";
    let content = format!("{HEADER}{body}{FOOTER}");
    let mut decoder = EntityDecoder::new(&content);
    let entity = decoder.decode_by_id(1).expect("entity should decode");
    assert_eq!(entity.ifc_type, IfcType::IfcCartesianTransformationOperator3D);

    let result = parse_axis2_placement_2d(&entity, &mut decoder, 1.0);

    // Malformed/mistyped input must surface as `unresolved()`
    // (tz: NaN), matching every other malformed-data path in this
    // file (#2256's convention) — never a plausible-looking but
    // fabricated rotation.
    assert!(
        result.tz.is_nan(),
        "expected unresolved() for a non-placement entity, got a real transform: {result:?}"
    );
}

/// Bounding control: a genuine `IfcAxis2Placement3D` must still parse
/// correctly — the type check must not reject valid input.
#[test]
fn genuine_3d_placement_still_parses() {
    let body = "\
#1=IFCAXIS2PLACEMENT3D(#2,#3,#4);
#2=IFCCARTESIANPOINT((1.,2.,3.));
#3=IFCDIRECTION((0.,0.,1.));
#4=IFCDIRECTION((0.,1.,0.));
";
    let entity = decode(body, 1);
    let content = format!("{HEADER}{body}{FOOTER}");
    let mut decoder = EntityDecoder::new(&content);
    let result = parse_axis2_placement_2d(&entity, &mut decoder, 1.0);

    assert!(result.tz.is_finite(), "genuine 3D placement must resolve: {result:?}");
    assert!((result.tx - 1.0).abs() < 1e-4);
    assert!((result.ty - 2.0).abs() < 1e-4);
    assert!((result.tz - 3.0).abs() < 1e-4);
    // RefDirection (attr 2) is Y-axis (0,1,0); ratios normalize to (0,1)
    // in the XY plane per the len<=0.0001 vertical-fallback rule above
    // — RefDirection here is purely in-plane on Y, so dx=0, dy=1.
    assert!((result.m10 - 1.0).abs() < 1e-4);
}

/// Bounding control: a genuine `IfcAxis2Placement2D` must still parse
/// correctly — RefDirection read from attr 1, not attr 2.
#[test]
fn genuine_2d_placement_still_parses() {
    let body = "\
#1=IFCAXIS2PLACEMENT2D(#2,#3);
#2=IFCCARTESIANPOINT((10.,20.));
#3=IFCDIRECTION((0.,1.));
";
    let entity = decode(body, 1);
    let content = format!("{HEADER}{body}{FOOTER}");
    let mut decoder = EntityDecoder::new(&content);
    let result = parse_axis2_placement_2d(&entity, &mut decoder, 1.0);

    assert!(result.tz.is_finite(), "genuine 2D placement must resolve: {result:?}");
    assert!((result.tx - 10.0).abs() < 1e-4);
    assert!((result.ty - 20.0).abs() < 1e-4);
    assert!((result.m10 - 1.0).abs() < 1e-4);
}
