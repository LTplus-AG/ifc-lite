// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: lifted nested Boolean source, executed through C's public seam.
use super::{metrics::Metrics, support::*};
fn nested() -> String {
    SOURCE.replace("#13=IFCEXTRUDEDAREASOLID", "#13=IFCBOOLEANRESULT(.DIFFERENCE.,#113,#213);#113=IFCEXTRUDEDAREASOLID")
        .replace("ENDSEC;END-ISO", "#213=IFCBOOLEANRESULT(.UNION.,#114,#115);#114=IFCEXTRUDEDAREASOLID(#14,#5,#15,1.);#115=IFCEXTRUDEDAREASOLID(#14,#5,#15,2.);ENDSEC;END-ISO")
}
#[test]
fn nested_boolean_matches_authored_volume_and_publishes_complete_closed_shape() {
    let Some(outcomes) = native(&nested()) else {
        return;
    };
    let product = shape(&outcomes, 10);
    let mut result = Metrics::default();
    for part in &product.parts {
        result
            .add_mesh(
                &part
                    .positions
                    .chunks_exact(3)
                    .map(|p| [p[0], p[1], p[2]])
                    .collect::<Vec<_>>(),
                &part.indices,
            )
            .unwrap();
        assert!(part.curved, "Booleans follow curved comparison policy");
    }
    assert!((result.volume - 8.).abs() < 8e-6);
    assert_eq!(result.defects, 0);
}
#[test]
fn empty_final_boolean_remains_refused() {
    let text = SOURCE.replace(
        "#13=IFCEXTRUDEDAREASOLID",
        "#13=IFCBOOLEANRESULT(.DIFFERENCE.,#113,#113);#113=IFCEXTRUDEDAREASOLID",
    );
    let Some(outcomes) = native(&text) else {
        return;
    };
    assert_eq!(refusal(&outcomes, 10).code(), "empty_result");
}

#[test]
fn h2c_sdk_mapped_boolean_operand_scale_changes_the_authored_cut_volume() {
    let bytes = nested().replace(".UNION.,#114,#115", ".UNION.,#314,#115")
        .replace("#115=IFCEXTRUDEDAREASOLID(#14,#5,#15,2.)", "#115=IFCEXTRUDEDAREASOLID(#14,#5,#15,0.5)")
        .replace("ENDSEC;END-ISO", "#314=IFCMAPPEDITEM(#315,#316);#315=IFCREPRESENTATIONMAP(#5,#317);#316=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,2.,$);#317=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#114));ENDSEC;END-ISO");
    let Some(outcomes) = native(&bytes) else {
        return;
    };
    super::geometry_assertions::assert_geometry(shape(&outcomes, 10), 8., None);
}

#[test]
fn issue_7955_mapped_boolean_result_replaces_its_old_frame_exactly_once() {
    let bytes = SOURCE.replace("#13=IFCEXTRUDEDAREASOLID", "#13=IFCBOOLEANRESULT(.DIFFERENCE.,#113,#314);#113=IFCEXTRUDEDAREASOLID")
        .replace("ENDSEC;END-ISO", "#213=IFCBOOLEANRESULT(.UNION.,#114,#115);#114=IFCEXTRUDEDAREASOLID(#14,#507,#15,1.);#115=IFCEXTRUDEDAREASOLID(#14,#507,#15,2.);#506=IFCCARTESIANPOINT((5.,0.,0.));#507=IFCAXIS2PLACEMENT3D(#506,$,$);#314=IFCMAPPEDITEM(#315,#316);#315=IFCREPRESENTATIONMAP(#507,#318);#316=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#319,#320,#317,1.,#15);#317=IFCCARTESIANPOINT((2.,-10.,0.));#318=IFCSHAPEREPRESENTATION(#2,'Body','CSG',(#213));#319=IFCDIRECTION((0.,1.,0.));#320=IFCDIRECTION((-1.,0.,0.));ENDSEC;END-ISO");
    let Some(outcomes) = native(&bytes) else {
        return;
    };
    super::geometry_assertions::assert_geometry(shape(&outcomes, 10), 20., None);
}
