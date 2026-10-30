// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955 M10 follow-up: the winding gate's classification is source-only. It must not
//! depend on the world placement, must read every operator production accepts, and
//! must fail closed on a mapped body it cannot decode. No SDK worker is involved.
use ifc_lite_core::SourceBundle;
use ifc_lite_retained_native::oracle::affine::{self, AffineOracle, Classification};

const SOURCE: &str = include_str!("../../../tests/fixtures/synthetic-retained/f-h-affine-finals.ifc");
// h2 (#42) maps h1's profile through a mirror: Axis1 = -X, Axis2 = +Y.
const MIRROR: &str = "#38=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#35,#36,#37,1.,#3);";

fn with(replacements: &[(&str, &str)]) -> String {
    let mut text = SOURCE.to_owned();
    for (from, to) in replacements {
        assert!(text.contains(from), "fixture lost {from}");
        text = text.replace(from, to);
    }
    text
}
fn classify(text: &str, id: u32) -> Classification {
    let source = SourceBundle::new(text.as_bytes().to_vec());
    AffineOracle::new(&source).classify(id)
}
fn operator(text: &str) -> String {
    with(&[(MIRROR, text)]).replace(
        "ENDSEC;\nEND-ISO",
        "#9201=IFCDIRECTION((-1.,0.));\n#9202=IFCDIRECTION((0.,1.));\n#9203=IFCDIRECTION((0.,-1.));\nENDSEC;\nEND-ISO",
    )
}

#[test]
fn m10_classification_does_not_need_the_world_placement() {
    assert_eq!(classify(SOURCE, 42), Classification::Affine);
    // Production resolves both placements (placement/chain.rs); the oracle must not
    // let a mirrored map publish without its winding gate because it cannot.
    for (label, placement) in [
        ("linear", "#9100=IFCLINEARPLACEMENT($,#9101,$);\n#9101=IFCAXIS2PLACEMENTLINEAR($,$,$);"),
        ("grid", "#9100=IFCGRIDPLACEMENT(#9101,$);\n#9101=IFCVIRTUALGRIDINTERSECTION($,(0.,0.,0.));"),
    ] {
        let text = with(&[
            ("#42=IFCBUILDINGELEMENTPROXY('2ANRI009XL68a3hv0UbDE$',$,'h2',$,$,#9,",
             "#42=IFCBUILDINGELEMENTPROXY('2ANRI009XL68a3hv0UbDE$',$,'h2',$,$,#9100,"),
            ("ENDSEC;\nEND-ISO", &format!("{placement}\nENDSEC;\nEND-ISO")),
        ]);
        assert_eq!(classify(&text, 42), Classification::Affine, "{label} placement");
        assert!(AffineOracle::new(&SourceBundle::new(text.into_bytes())).is_affine_final(42), "{label}");
    }
}

#[test]
fn m10_classification_reads_2d_operators_like_production() {
    // Same mirror authored as a 2D operator: plane normal +Z, Z keeps Scale.
    let text = operator("#38=IFCCARTESIANTRANSFORMATIONOPERATOR2D(#9201,#9202,#37,1.);");
    assert_eq!(classify(&text, 42), Classification::Affine);
    let a = affine::expected(text.as_bytes(), 42).unwrap();
    let b = affine::expected(SOURCE.as_bytes(), 42).unwrap();
    assert!((a[0].volume - b[0].volume).abs() < 1e-12);
    for (x, y) in a[0].centroid.into_iter().zip(b[0].centroid) {
        assert!((x - y).abs() < 1e-12);
    }
    // Scale 2, Scale2 3, and Z at Scale: |det| = 2*3*2 over the h1 prism (0.56).
    let text = operator("#38=IFCCARTESIANTRANSFORMATIONOPERATOR2DNONUNIFORM(#51,#52,#37,2.,3.);");
    assert_eq!(classify(&text, 42), Classification::Affine);
    let e = affine::expected(text.as_bytes(), 42).unwrap();
    assert!((e[0].volume - 0.56 * 12.).abs() < 1e-9, "{}", e[0].volume);
    // Axis1 omitted: Axis2 = (0,-1) fixes X = (-1,0), a 180-degree turn, not a mirror.
    let text = operator("#38=IFCCARTESIANTRANSFORMATIONOPERATOR2D($,#9203,#37,1.);");
    assert_eq!(classify(&text, 42), Classification::Rigid);
}

#[test]
fn m10_2d_operator_with_axis1_only_derives_y_as_the_counter_clockwise_complement() {
    // Hosted review of #8360. Axis2 omitted: Y = (-x_y, x_x). Axis1 = (0,1) is a quarter turn and
    // Axis1 = (-1,0) a half turn; both are rotations. A +Y default made the first unclassifiable
    // (y collapses onto x) and the second a false mirror.
    for (label, axis1) in [("quarter turn", "#9204=IFCDIRECTION((0.,1.));"), ("half turn", "#9204=IFCDIRECTION((-1.,0.));")] {
        let text = operator("#38=IFCCARTESIANTRANSFORMATIONOPERATOR2D(#9204,$,#37,1.);")
            .replace("ENDSEC;\nEND-ISO", &format!("{axis1}\nENDSEC;\nEND-ISO"));
        assert_eq!(classify(&text, 42), Classification::Rigid, "{label}");
        let e = affine::expected(text.as_bytes(), 42).unwrap();
        assert!((e[0].volume - 0.56).abs() < 1e-12, "{label}: {}", e[0].volume);
    }
    // An Axis1 that really is a mirror partner still is one: Axis1 = (1,0), Axis2 = (0,-1).
    let text = operator("#38=IFCCARTESIANTRANSFORMATIONOPERATOR2D(#9201,#9203,#37,1.);")
        .replace("#9201=IFCDIRECTION((-1.,0.));", "#9201=IFCDIRECTION((1.,0.));");
    assert_eq!(classify(&text, 42), Classification::Affine);
}

#[test]
fn m10_unclassifiable_mapped_body_is_unmodelled_never_rigid() {
    // Each is a mapped body whose operator cannot be decoded: the pre-fix oracle
    // answered `not affine`, so such a product published with no winding gate.
    for (label, text) in [
        ("missing origin", "#38=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#35,#36,$,1.,#3);"),
        ("zero Axis3", "#38=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#35,#36,#37,1.,#9301);"),
        ("abstract operator", "#38=IFCCARTESIANTRANSFORMATIONOPERATOR(#35,#36,#37,1.);"),
    ] {
        let text = with(&[(MIRROR, text)]).replace("ENDSEC;\nEND-ISO", "#9301=IFCDIRECTION((0.,0.,0.));\nENDSEC;\nEND-ISO");
        let Classification::Unmodelled(reason) = classify(&text, 42) else { panic!("{label}") };
        assert!(reason.contains("#39"), "{label}: {reason}");
        assert!(!AffineOracle::new(&SourceBundle::new(text.into_bytes())).is_affine_final(42), "{label}");
    }
    // An unreadable mapping source is the same failure, not a missing body.
    let text = with(&[("#39=IFCMAPPEDITEM(#26,#38);", "#39=IFCMAPPEDITEM(#9999,#38);")]);
    assert!(matches!(classify(&text, 42), Classification::Unmodelled(_)));
}

#[test]
fn m10_classification_without_a_mapped_body_stays_rigid() {
    // Fail-closed is for mapped bodies only: a direct extrusion is rigid, not unmodelled.
    let text = with(&[("#33=IFCPRODUCTDEFINITIONSHAPE($,$,(#32));", "#33=IFCPRODUCTDEFINITIONSHAPE($,$,(#25));")]);
    assert_eq!(classify(&text, 34), Classification::Rigid);
    // Identity map (h1) stays rigid too.
    assert_eq!(classify(SOURCE, 34), Classification::Rigid);
}

// Hosted review of #8360: a mirrored IfcMappedItem under a Boolean operand or a CSG
// root is still part of the Body. `mapped_items` stopped at the Boolean and said Rigid.
fn csg_body(solids: &str, root: &str) -> String {
    // h2 (#42): #39 is the mirrored map item, #31 h1's identity map item.
    with(&[("#40=IFCSHAPEREPRESENTATION(#4,'Body','MappedRepresentation',(#39));",
        &format!("{solids}\n#40=IFCSHAPEREPRESENTATION(#4,'Body','CSG',({root}));"))])
}

#[test]
fn m10_mirrored_map_under_a_boolean_or_csg_root_is_never_rigid() {
    for (label, solids, root) in [
        ("union of the mirror", "#9400=IFCBOOLEANRESULT(.UNION.,#39,#39);", "#9400"),
        ("mirror as second operand", "#9400=IFCBOOLEANRESULT(.DIFFERENCE.,#31,#39);", "#9400"),
        ("mirror as first operand", "#9400=IFCBOOLEANRESULT(.DIFFERENCE.,#39,#31);", "#9400"),
        ("under a CSG solid", "#9400=IFCBOOLEANRESULT(.UNION.,#31,#39);\n#9401=IFCCSGSOLID(#9400);", "#9401"),
        ("nested Boolean", "#9400=IFCBOOLEANRESULT(.UNION.,#31,#31);\n#9402=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#9400,#39);", "#9402"),
    ] {
        assert_eq!(classify(&csg_body(solids, root), 42), Classification::Affine, "{label}");
    }
}

#[test]
fn m10_rigid_maps_under_a_boolean_stay_rigid() {
    let text = csg_body("#9400=IFCBOOLEANRESULT(.UNION.,#31,#31);", "#9400");
    assert_eq!(classify(&text, 42), Classification::Rigid);
}

#[test]
fn m10_undecodable_map_under_a_boolean_is_unmodelled() {
    // The mirror's operator has no origin: it cannot be classified, and it sits under a Boolean.
    let text = csg_body("#9400=IFCBOOLEANRESULT(.UNION.,#39,#39);", "#9400")
        .replace(MIRROR, "#38=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#35,#36,$,1.,#3);");
    let Classification::Unmodelled(reason) = classify(&text, 42) else { panic!("must not be rigid") };
    assert!(reason.contains("#39"), "{reason}");
}

// Review nits on #8360.
#[test]
fn m10_3d_operator_without_axis2_falls_back_to_z_cross_x_when_plus_y_collapses() {
    // Axis2 omitted and +Y lies in the plane of Z and X, so projecting +Y leaves nothing. Production
    // takes Z x X there and publishes a rigid rotation; the oracle must not call it unmodelled.
    for (label, operator) in [
        ("Axis1 = +Y", "#38=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#36,$,#37,1.,$);"),
        ("Axis3 = +X, default Axis1", "#38=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#37,1.,#43);"),
    ] {
        let text = with(&[(MIRROR, operator)]);
        assert_eq!(classify(&text, 42), Classification::Rigid, "{label}");
        let e = affine::expected(text.as_bytes(), 42).unwrap();
        assert!((e[0].volume - 0.56).abs() < 1e-12, "{label}: {}", e[0].volume);
    }
}

#[test]
fn m10_singular_map_is_affine_not_rigid() {
    // Scale = 0 collapses the map. `stretches` has no singular values to report, which read as
    // "rigid"; a singular map is the opposite of rigid and must reach the winding gate.
    let text = with(&[(MIRROR, "#38=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#35,#36,#37,0.,#3);")]);
    assert_eq!(classify(&text, 42), Classification::Affine);
}
