// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use ifc_lite_core::IfcType;

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

/// PROCESSING-SYM-16 (#7779): `links` chained `IfcLocalPlacement`s, each
/// translating +1 in X, under a product whose `ObjectPlacement` is the leaf.
fn chained_product(links: usize) -> String {
    let mut body = String::from("#1=IFCAXIS2PLACEMENT3D(#2,$,$);\n#2=IFCCARTESIANPOINT((1.,0.,0.));\n#10=IFCLOCALPLACEMENT($,#1);\n");
    for i in 1..links {
        body.push_str(&format!("#{}=IFCLOCALPLACEMENT(#{},#1);\n", 10 + i, 9 + i));
    }
    body.push_str(&format!(
        "#900=IFCWALL('0000000000000000000000',$,$,$,$,#{},$,$,$);\n",
        9 + links
    ));
    body
}

#[test]
fn a_chain_past_fifty_links_resolves_like_the_mesh_path_sym_16() {
    // Base capped the recursion at `depth > 50` (51 links) and returned
    // `unresolved()` (tz = NaN, the symbol kept at the origin).
    for links in [40, 51, 80, ifc_lite_core::MAX_PLACEMENT_DEPTH] {
        let content = format!("{HEADER}{}{FOOTER}", chained_product(links));
        let mut decoder = EntityDecoder::new(&content);
        let product = decoder.decode_by_id(900).unwrap();
        let t = resolve_object_placement(&product, &mut decoder, 1.0);
        assert!(t.tz.is_finite(), "{links} links must resolve");
        assert_eq!(t.tx, links as f64, "{links} links compose in full");
    }
}

fn resolve(body: &str, product: u32) -> Transform2D {
    let content = format!("{HEADER}{body}{FOOTER}");
    let mut decoder = EntityDecoder::new(&content);
    let entity = decoder.decode_by_id(product).unwrap();
    resolve_object_placement(&entity, &mut decoder, 1.0)
}

/// F3b P2 (D27): the chain is the shared iterative walk, so there is no cap
/// at all (SYM-16's 50 and then 100 are both gone) and no recursion to
/// overflow.
#[test]
fn a_very_deep_chain_resolves_without_a_cap() {
    let links = ifc_lite_core::MAX_PLACEMENT_DEPTH * 3;
    let content = format!("{HEADER}{}{FOOTER}", chained_product(links));
    let mut decoder = EntityDecoder::new(&content);
    let product = decoder.decode_by_id(900).unwrap();
    let t = resolve_object_placement(&product, &mut decoder, 1.0);
    assert!(t.tz.is_finite());
    assert_eq!(t.tx, links as f64);
}

/// §3.8: a cycle is `unresolved()` (kept at the origin, tz NaN). Base composed
/// about 51 locals around the loop and drew the symbol displaced.
#[test]
fn a_placement_cycle_is_unresolved_not_a_displaced_symbol() {
    let body = "#1=IFCAXIS2PLACEMENT3D(#2,$,$);\n#2=IFCCARTESIANPOINT((1.,0.,0.));\n\
                #10=IFCLOCALPLACEMENT(#11,#1);\n#11=IFCLOCALPLACEMENT(#10,#1);\n\
                #900=IFCWALL('0000000000000000000000',$,$,$,$,#10,$,$,$);\n";
    let t = resolve(body, 900);
    assert!(t.tz.is_nan(), "{t:?}");
    assert_eq!((t.tx, t.ty), (0.0, 0.0), "{t:?}");
}

/// §3.9 (user-visible): symbols under an `IfcLinearPlacement` product draw in
/// place. Base only walked `IfcLocalPlacement` and returned `unresolved()`.
#[test]
fn a_linear_placement_resolves_through_the_shared_chain() {
    let body = "#1=IFCAXIS2PLACEMENT3D(#2,$,$);\n#2=IFCCARTESIANPOINT((3.,4.,0.));\n\
                #10=IFCLINEARPLACEMENT($,$,#1);\n\
                #900=IFCWALL('0000000000000000000000',$,$,$,$,#10,$,$,$);\n";
    let t = resolve(body, 900);
    assert!(t.tz.is_finite(), "{t:?}");
    assert_eq!((t.tx, t.ty), (3.0, 4.0));
}

/// §3.11 (user-visible, rare): Axis is honoured, so a tilted parent projects
/// foreshortened. Base ignored Axis (m11 = 1).
#[test]
fn a_tilted_placement_is_projected_foreshortened() {
    // Axis tilted 60 degrees about X: local Y = Z x X has y component cos(60).
    let (s, c) = (60f64.to_radians().sin(), 60f64.to_radians().cos());
    let body = format!(
        "#1=IFCAXIS2PLACEMENT3D(#2,#3,$);\n#2=IFCCARTESIANPOINT((0.,0.,0.));\n\
         #3=IFCDIRECTION((0.,{:?},{:?}));\n#10=IFCLOCALPLACEMENT($,#1);\n\
         #900=IFCWALL('0000000000000000000000',$,$,$,$,#10,$,$,$);\n",
        -s, c
    );
    let t = resolve(&body, 900);
    assert!((t.m00 - 1.0).abs() < 1e-12 && (t.m11 - c).abs() < 1e-12, "{t:?}");
}

/// §3.17: one epsilon. A RefDirection of length 5e-5 is read as authored
/// (the canonical repair is for a zero vector), where symbolic's own 1e-4
/// threshold snapped it to +X.
#[test]
fn a_short_ref_direction_is_read_not_snapped_to_x() {
    let body = "#1=IFCAXIS2PLACEMENT2D(#2,#3);\n#2=IFCCARTESIANPOINT((0.,0.));\n\
                #3=IFCDIRECTION((0.,0.00005));\n";
    let entity = decode(body, 1);
    let content = format!("{HEADER}{body}{FOOTER}");
    let mut decoder = EntityDecoder::new(&content);
    let t = parse_axis2_placement_2d(&entity, &mut decoder, 1.0);
    assert!((t.m10 - 1.0).abs() < 1e-12 && t.m00.abs() < 1e-12, "{t:?}");
}

/// D30/D15: a `$` mandatory Location or a malformed component anywhere in the
/// chain DROPS the symbol (`refused()`, NaN translation), where base kept it
/// at the origin (`$` Location) or read the component as 0.
#[test]
fn an_admission_refusal_inside_the_chain_drops_the_symbol() {
    for (point, what) in [("$", "`$` Location"), ("#2", "malformed component")] {
        let body = format!(
            "#1=IFCAXIS2PLACEMENT3D({point},$,$);\n#2=IFCCARTESIANPOINT((1.,'x',0.));\n\
             #10=IFCLOCALPLACEMENT($,#1);\n#11=IFCLOCALPLACEMENT(#10,#1);\n\
             #900=IFCWALL('0000000000000000000000',$,$,$,$,#11,$,$,$);\n"
        );
        let t = resolve(&body, 900);
        assert!(t.tx.is_nan() && t.ty.is_nan(), "{what}: {t:?}");
    }
}
