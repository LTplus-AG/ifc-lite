// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
#[path="support/m6_halfspaces.rs"]
mod fixture;
use fixture::{walk,walk_with,SOURCE};
// Mixed PBHS -> plane -> solid chains and the boxed-equals-plane twin use M5's
// shared plane halfspace implementation; both run unconditionally.
#[test]
fn m6_mixed_chain() {
    let (trace,result)=walk(SOURCE,1004);result.unwrap();
    assert_eq!(trace.order,["host","prism","difference","prism","difference","host","difference"]);
}
#[test]
fn m6_boxed_plane_prisms() {
    let (plain,result)=walk(SOURCE,1008);result.unwrap();assert_eq!(plain.prisms.len(),1);
    for id in [1007,1009] {
        let (boxed,result)=walk(SOURCE,id);result.unwrap();
        let mut actual=boxed.prisms[0].clone();actual.source_id=plain.prisms[0].source_id;
        assert_eq!(actual,plain.prisms[0]);
        assert_eq!(actual.lower().unwrap().bytes,plain.prisms[0].lower().unwrap().bytes);
    }
}
#[test]
fn m6_consumed_host_never_decodes_a_later_operand() {
    let chained=SOURCE.replace("#356=IFCBOOLEANRESULT(.DIFFERENCE.,#12,#314);",
        "#9356=IFCBOOLEANRESULT(.DIFFERENCE.,#12,#314);\n#356=IFCBOOLEANRESULT(.DIFFERENCE.,#9356,#999999);");
    for (label,text) in [("plain",SOURCE),("chained",chained.as_str())] {
        let (trace,result)=walk_with(text,1011,true);
        let error=result.expect_err(label);
        assert_eq!(error.kind(),ifc_lite_geometry::program::transactions::TransactionFailureKind::EmptyResult,"{label}: {error:?}");
        assert_eq!(error.origin_view(),Some(("halfspace_clip",Some(314),"consumed")),"{label}");
        assert!(!trace.decoded.contains(&999999),"{label}: later operand decoded");
    }
}
