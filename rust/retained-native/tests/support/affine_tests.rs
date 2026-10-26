// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: lifted affine source; M1 deliberately refuses final affine-only values.
use super::support::*;
fn mapped() -> String {
    SOURCE.replace("#13=IFCEXTRUDEDAREASOLID", "#13=IFCMAPPEDITEM(#81,#82);#113=IFCEXTRUDEDAREASOLID")
        .replace("ENDSEC;END-ISO", "#81=IFCREPRESENTATIONMAP(#5,#83);#82=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#84,2.,$);#83=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#113,#114));#84=IFCCARTESIANPOINT((2.,4.,6.));#114=IFCEXTRUDEDAREASOLID(#14,#5,#15,1.);ENDSEC;END-ISO")
}
#[test]
fn final_affine_only_value_refuses_incomplete_without_partial_product() {
    let Some(outcomes) = native(&mapped()) else {
        return;
    };
    assert_eq!(refusal(&outcomes, 10).code(), "incomplete");
    shape(&outcomes, 20);
}
#[test]
fn later_affine_part_keeps_earlier_construction_private() {
    let text = mapped().replace("'SweptSolid',(#13)", "'SweptSolid',(#23,#13)");
    let Some(outcomes) = native(&text) else {
        return;
    };
    assert_eq!(refusal(&outcomes, 10).code(), "incomplete");
}
