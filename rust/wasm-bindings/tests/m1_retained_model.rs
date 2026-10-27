// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-browser")]
#[path = "../src/retained_model_refusal.rs"]
mod retained_model_refusal;
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::admit_product;
use retained_model_refusal::RefusedProduct;

// Refs #7955 E2: real opening admission through the controller, serialized by
// the same host boundary as retainedModel. Reverse the oracle patch to lose
// the typed refusal (without removing the API or breaking compilation).
#[test]
fn m1_e2_retained_model_keeps_typed_refusal_at_host_boundary() {
    let source = SourceBundle::new(
        include_bytes!("../../../tests/fixtures/synthetic-retained/f-a-curved.ifc").to_vec(),
    );
    let mut decoder = source.decoder();
    for id in [55, 122, 188, 254] {
        let error = admit_product(source.clone(), &mut decoder, id).unwrap_err();
        let view = RefusedProduct::new(id, "IfcWall".into(), error.refusal(), None);
        let actual = serde_json::to_value(view).unwrap();
        assert_eq!(
            actual,
            serde_json::json!({
                "status": "refused", "expressId": id, "ifcType": "IfcWall", "code": "opening_strategy",
            })
        );
    }
}
