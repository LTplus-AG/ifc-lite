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
