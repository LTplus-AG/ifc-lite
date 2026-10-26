// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: source faults remain product-atomic and do not become exact retries.
use super::support::*;
#[test]
fn late_unsupported_item_keeps_earlier_construction_private() {
    let text = BOX
        .replace("'SweptSolid',(#19)", "'SweptSolid',(#19,#90)")
        .replace(
            "ENDSEC;\nEND-ISO",
            "#90=IFCFACETEDBREP(#91);#91=IFCCLOSEDSHELL(());\nENDSEC;\nEND-ISO",
        );
    let Some(outcomes) = native(&text) else {
        return;
    };
    assert_eq!(refusal(&outcomes, 27).code(), "operation_unsupported");
}
#[test]
fn zero_deadline_is_reported_before_transport() {
    let mut options = ifc_lite_retained_native::ModelOptions::default();
    options.product_budget.deadline_ms = 0;
    let (_, outcomes) = inert(BOX, &options);
    assert_eq!(refusal(&outcomes, 27).code(), "deadline_exceeded");
}
