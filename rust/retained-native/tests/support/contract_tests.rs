// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: source refusals remain typed at the native model boundary.
use super::support::*;
#[test]
fn opening_and_layer_refusals_do_not_acquire_the_worker() {
    for (text, id, code) in [
        (
            include_str!("../../../../tests/fixtures/cli-retained/layered-wall.ifc"),
            27,
            "material_layer_strategy",
        ),
        (
            include_str!("../../../../tests/fixtures/synthetic-retained/f-a-curved.ifc"),
            55,
            "opening_strategy",
        ),
    ] {
        let acquired = std::cell::Cell::new(0);
        let mut outcomes = Vec::new();
        let options = ifc_lite_retained_native::ModelOptions {
            ids: Some([id].into_iter().collect()),
            ..Default::default()
        };
        ifc_lite_retained_native::block_on(
            ifc_lite_processing::element::retained_runtime::run_model(
                ifc_lite_core::SourceBundle::new(text.as_bytes().to_vec()),
                &options,
                || {
                    acquired.set(acquired.get() + 1);
                    Ok(peer())
                },
                |outcome| outcomes.push(outcome),
            ),
        )
        .unwrap();
        assert_eq!(refusal(&outcomes, id).code(), code);
        assert_eq!(acquired.get(), 0, "source refusal must precede acquisition");
    }
}
#[test]
fn source_refused_family_is_not_replaced_by_exact() {
    let text = include_str!("../../../../tests/fixtures/synthetic-retained/f-c-brep.ifc");
    let (_, outcomes) = inert(text, &Default::default());
    assert!(!outcomes.is_empty());
    for outcome in outcomes {
        assert!(matches!(outcome,ifc_lite_retained_native::ProductOutcome::Refused { refusal: ifc_lite_processing::element::retained_runtime::RetainedProductRefusal::OperationUnsupported,.. }));
    }
}
