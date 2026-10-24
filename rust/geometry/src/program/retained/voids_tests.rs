// SPDX-License-Identifier: MPL-2.0
//! #7955: bounds and reporting are separate contracts on reached IFC source.
use super::*;
use ifc_lite_core::SourceBundle;
const SOURCE: &str = "#1=IFCWALL('w',$,$,$,$,$,$,$,$);#2=IFCOPENINGELEMENT('o',$,$,$,$,$,$,$,$);";
fn refused_source() -> (VoidReply, bool) {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let host = decoder.decode_by_id(1).unwrap();
    let selection = RetainedSelection::new(RetainedContract { source_epoch:1, source_revision:1 }, 1).unwrap();
    let mut control = RetainedVoids::new(&host, &[2], selection.clone()).unwrap();
    // Isolate the next opening source admission from the separately tested host
    // walk. No numerical receipt, fake geometry, or mock decoder is supplied.
    control.child = None;
    selection.set_work_limit(0);
    let reply = control.execute(&GeometryRouter::with_scale(1.), &mut decoder).unwrap();
    (reply, decoder.get_cached(2).is_some())
}
#[test]
fn j2_opening_work_bound_precedes_reached_decode() {
    let (_, decoded) = refused_source();
    assert!(!decoded, "J2_BOUND_BEFORE_DECODE");
}
#[test]
fn j2_opening_work_refusal_is_reported() {
    let (reply, _) = refused_source();
    assert!(matches!(reply, VoidReply::Selected(Err(crate::Error::ProgramStopped(_)))), "J2_BOUND_REPORT");
}
