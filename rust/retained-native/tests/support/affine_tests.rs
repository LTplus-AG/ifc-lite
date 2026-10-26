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

#[test]
fn issue_7955_native_nonuniform_and_reflected_copies_match_authored_bounds_and_volume() {
    for reflected in [false, true] {
        let bytes = mapped()
            .replace("'SweptSolid',(#113,#114)", "'SweptSolid',(#113)")
            .replace(
                "#13=IFCMAPPEDITEM",
                "#13=IFCBOOLEANRESULT(.UNION.,#813,#813);#813=IFCMAPPEDITEM",
            );
        let bytes = if reflected {
            bytes.replace("OPERATOR3D($,$,#84,2.,$)", "OPERATOR3D(#201,#202,#84,1.,#203)")
                .replace("ENDSEC;END-ISO", "#201=IFCDIRECTION((1.,0.,0.));#202=IFCDIRECTION((0.,-1.,0.));#203=IFCDIRECTION((0.,0.,1.));ENDSEC;END-ISO")
        } else {
            bytes.replace(
                "OPERATOR3D($,$,#84,2.,$)",
                "OPERATOR3DNONUNIFORM($,$,#84,2.,$,3.,4.)",
            )
        };
        let Some(outcomes) = native(&bytes) else {
            return;
        };
        let (volume, bounds) = if reflected {
            (24., [11., 22., 36., 13., 26., 39.])
        } else {
            (576., [10., 18., 36., 14., 30., 48.])
        };
        super::geometry_assertions::assert_geometry(shape(&outcomes, 10), volume, Some(bounds));
    }
}
