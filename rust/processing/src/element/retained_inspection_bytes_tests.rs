// SPDX-License-Identifier: MPL-2.0
//! #7955 A0P-R3: original entry deadline includes canonical source preparation.
use super::*;
use super::tests::{SOURCE, OPTIONS, commit};
use resource::inspection_test_clock as clock;

#[test]
fn issue_7955_raw_bytes_keep_original_start_through_source_and_nested_processing() {
    for stage in ["source_prepared", "source_decoder", "binding", "owner_return"] {
        clock::scope(|clock| {
            let start = InspectionStart::now();
            clock.advance(6000);
            clock.expire_at(stage, 1, 4000);
            let error = inspect_retained_bytes(start, SOURCE.as_bytes(), 10, OPTIONS, &commit()).err().unwrap();
            assert_eq!(error.diagnostic_code_json(), "\"DEADLINE_EXCEEDED\"", "stage: {stage}");
            assert_eq!(error.original_stop(), None);
        });
    }
}

#[test]
fn issue_7955_raw_bytes_strict_options_refuse_before_source_factory() {
    clock::scope(|clock| {
        let start = InspectionStart::now();
        let observer = InspectionBudget::new(start.clone(), 10000, 16777216, 10000);
        clock.expire_at("source_prepared", 1, 10000);
        let error = inspect_retained_bytes(start, SOURCE.as_bytes(), 10, "{}", &commit()).err().unwrap();
        assert_eq!(error.diagnostic_code_json(), "\"INVALID_OPTIONS\"");
        assert!(observer.scope(resource::inspection_checkpoint).is_ok(), "source factory ran before options refusal");
    });
    let report = inspect_retained_bytes(InspectionStart::now(), SOURCE.as_bytes(), 10, OPTIONS, &commit()).unwrap();
    let value: serde_json::Value = serde_json::from_slice(report.bytes().unwrap()).unwrap();
    assert_eq!(value["outcome"]["kind"], "requires_numerical_evaluation");
}
