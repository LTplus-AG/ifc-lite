// SPDX-License-Identifier: MPL-2.0
#![cfg(feature="retained-runtime")]
//! #7955 admission uses IFC source and never acquires a numerical worker.
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::admit_product;
const CURVED:&str=include_str!("../../../tests/fixtures/synthetic-retained/f-a-curved.ifc");
#[test]
fn m4_unsupported_axis_precedes_invalid_opening() {
    let text=CURVED.replace("IFCCIRCLE(#26,10.)","IFCELLIPSE(#26,10.,9.)").replace("#9,#62,$,.OPENING.)","#9,#999999,$,.OPENING.)");
    let source=SourceBundle::new(text.into_bytes()); let mut decoder=source.decoder();
    let refusal=admit_product(source.clone(),&mut decoder,55).unwrap_err();
    assert_eq!(refusal.refusal().code(),"material_layer_strategy");
}
#[test]
fn m4_admits_opened_host_and_disallows_missing_curved_axis() {
    let source=SourceBundle::new(CURVED.as_bytes().to_vec()); let mut decoder=source.decoder();
    admit_product(source.clone(),&mut decoder,55).unwrap();
    let text=CURVED.replace("(#53,#29)","(#53)");
    let source=SourceBundle::new(text.into_bytes()); let mut decoder=source.decoder();
    assert_eq!(admit_product(source.clone(),&mut decoder,55).unwrap_err().refusal().code(),"material_layer_strategy");
}
