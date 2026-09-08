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

/// A wrong-type entity wired into a WCS-shaped slot: an `IfcAxis1Placement`
/// (Location, Axis — two attributes) rather than an `IfcAxis2Placement2D`/
/// `…3D`. Neither, so a correct implementation must refuse to read it as
/// one. Before the fix, the missing type check treated this as a 2D
/// placement (attribute-count-compatible: two refs), reading its own attr 0
/// `IfcCartesianPoint` as Location and attr 1 `IfcDirection` as
/// RefDirection, and silently produced a real 90°-rotated transform at
/// (5, 6) instead of flagging the mismatch. (An `IfcCartesianTransformation
/// Operator3D` fixture does NOT probe this: its attr 0 is an `IfcDirection`,
/// not an `IfcCartesianPoint`, so the pre-existing mandatory-Location check
/// (#2355) already rejects it before the type guard this test targets is
/// ever reached — that fixture cannot tell the guard's presence from its
/// absence.)
#[test]
fn non_placement_entity_is_not_silently_misread() {
    let body = "\
#1=IFCAXIS1PLACEMENT(#2,#3);
#2=IFCCARTESIANPOINT((5.,6.,7.));
#3=IFCDIRECTION((0.,1.,0.));
";
    let content = format!("{HEADER}{body}{FOOTER}");
    let mut decoder = EntityDecoder::new(&content);
    let entity = decoder.decode_by_id(1).expect("entity should decode");
    assert_eq!(entity.ifc_type, IfcType::IfcAxis1Placement);

    let result = parse_axis2_placement_2d(&entity, &mut decoder, 1.0);

    // Malformed/mistyped input must surface as `unresolved()`
    // (tz: NaN), matching every other malformed-data path in this
    // file (#2256's convention) — never a plausible-looking but
    // fabricated rotation. Without the type guard this produces a real
    // (tx=5, ty=6, 90°-rotation) transform instead.
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

/// `LocalOrigin`'s Z must reach `Transform2D::tz`, scaled like X and Y.
///
/// `tz` is not decorative. This parser's transform reaches the item walk via
/// `items.rs`'s `composed_transform`, and `tz` is the annotation's world
/// elevation at `items.rs:160` / `:201` / `:259`, `trimmed_curve.rs:61`,
/// `text.rs:105` and `fill.rs:52`. Hardcoding `tz: 0.0` put a MappedItem
/// placed through an `IfcCartesianTransformationOperator3D` with a non-zero Z
/// at the wrong elevation, silently. Delete the Z read and this goes red.
#[test]
fn operator_local_origin_z_reaches_tz() {
    let body = "\
#1=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#2,$,$);
#2=IFCCARTESIANPOINT((1.,2.,3.));
";
    let entity = decode(body, 1);
    let content = format!("{HEADER}{body}{FOOTER}");
    let mut decoder = EntityDecoder::new(&content);
    let result = parse_cartesian_transformation_operator(&entity, &mut decoder, 1.0);

    assert!((result.tx - 1.0).abs() < 1e-4, "tx: {result:?}");
    assert!((result.ty - 2.0).abs() < 1e-4, "ty: {result:?}");
    assert!((result.tz - 3.0).abs() < 1e-4, "LocalOrigin Z must reach tz: {result:?}");
}

/// The same, under a unit scale: Z is scaled exactly like X and Y, so a
/// millimetre-authored model does not land 1000x off in elevation alone.
#[test]
fn operator_local_origin_z_is_unit_scaled_like_x_and_y() {
    let body = "\
#1=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#2,$,$);
#2=IFCCARTESIANPOINT((1000.,2000.,3000.));
";
    let entity = decode(body, 1);
    let content = format!("{HEADER}{body}{FOOTER}");
    let mut decoder = EntityDecoder::new(&content);
    let result = parse_cartesian_transformation_operator(&entity, &mut decoder, 0.001);

    assert!((result.tx - 1.0).abs() < 1e-4, "tx: {result:?}");
    assert!((result.ty - 2.0).abs() < 1e-4, "ty: {result:?}");
    assert!((result.tz - 3.0).abs() < 1e-4, "tz must take the same unit_scale: {result:?}");
}

/// Bounding control: a 2D operator has no third coordinate, so `tz` stays 0
/// rather than picking up garbage from a short coordinate list.
#[test]
fn operator_2d_local_origin_leaves_tz_zero() {
    let body = "\
#1=IFCCARTESIANTRANSFORMATIONOPERATOR2D($,$,#2,$);
#2=IFCCARTESIANPOINT((4.,5.));
";
    let entity = decode(body, 1);
    let content = format!("{HEADER}{body}{FOOTER}");
    let mut decoder = EntityDecoder::new(&content);
    let result = parse_cartesian_transformation_operator(&entity, &mut decoder, 1.0);

    assert!((result.tx - 4.0).abs() < 1e-4, "tx: {result:?}");
    assert!((result.ty - 5.0).abs() < 1e-4, "ty: {result:?}");
    assert!(result.tz.abs() < 1e-6, "2D operator must leave tz at 0: {result:?}");
}
