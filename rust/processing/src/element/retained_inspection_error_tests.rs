// SPDX-License-Identifier: MPL-2.0
//! #7955 C4/C5: actual public admission and parsed-source refusal semantics.
use super::*;
use super::super::tests::{OPTIONS, SOURCE};

// Descriptive test input only. These tests do not attest compilation provenance.
const TEST_IDENTITY: &str = "0000000000000000000000000000000000000000";

#[test]
fn issue_7955_public_busy_lease_preserves_cause_and_allows_released_retry() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let root = decoder.decode_by_id(10).unwrap();
    let competing = decoder.try_execution_lease().unwrap();
    let Err(error) = inspect_retained_source(source.clone(), 10, Some(&root), &mut decoder,
        OPTIONS, TEST_IDENTITY) else { panic!("competing lease must refuse public admission"); };
    assert!(matches!(error.cause, Cause::Owner(WorkError::OwnerBusy)));
    assert_eq!(error.diagnostic_code_json(), "\"OWNER_BUSY\"");
    drop(competing);
    let report = inspect_retained_source(source, 10, Some(&root), &mut decoder,
        OPTIONS, TEST_IDENTITY).expect("same decoder remains a legitimate owner");
    let value: serde_json::Value = serde_json::from_slice(report.bytes().unwrap()).unwrap();
    assert_eq!(value["outcome"]["kind"], "requires_numerical_evaluation");
    assert!(decoder.try_execution_lease().is_ok());
}

#[test]
fn issue_7955_protocol_failure_never_guesses_owner_mismatch() {
    for cause in [WorkError::Aborted, WorkError::Unfinished, WorkError::Outstanding,
        WorkError::StaleTicket, WorkError::AlreadyExecuted, WorkError::NotExecuted,
        WorkError::WrongEmitter, WorkError::WrongPayload, WorkError::WrongContext] {
        let error = RetainedInspectionError::owner(cause);
        assert!(matches!(error.cause, Cause::Owner(actual) if actual == cause));
        assert_eq!(error.diagnostic_code_json(), "\"RUNTIME_FAILED\"");
    }
    assert_eq!(RetainedInspectionError::owner(WorkError::WrongOwner).diagnostic_code_json(),
        "\"OWNER_MISMATCH\"");
}

#[test]
fn issue_7955_public_atomic_source_refusals_have_no_invented_measurement() {
    // Non-reference Items is malformed source. A Block is a real parsed IFC
    // construction whose retained recipe family is unsupported, not a source error.
    for (text, code, reason) in [
        (SOURCE.replace("(#13));", "(#13,$));"), "SOURCE_INVALID", "invalid"),
        (SOURCE.replace("#13=IFCEXTRUDEDAREASOLID(#14,#2,#3,3.)", "#13=IFCBLOCK(#2,2.,3.,4.)"),
            "OPERATION_UNSUPPORTED", "unsupported"),
    ] {
        let source = SourceBundle::new(text.into_bytes());
        let mut decoder = source.decoder();
        let report = inspect_retained_source(source, 10, None, &mut decoder, OPTIONS, TEST_IDENTITY).unwrap();
        let value: serde_json::Value = serde_json::from_slice(report.bytes().unwrap()).unwrap();
        assert_eq!(value["outcome"]["kind"], "refused");
        assert_eq!(value["outcome"]["refusal"]["code"], code);
        assert_eq!(value["outcome"]["refusal"]["detail"], serde_json::json!({
            "reason": reason, "measurement": {"kind": "not_applicable"},
        }));
        assert_eq!(value["authority"], "diagnostic_only");
        assert!(value["outcome"].get("requestOrdinal").is_none());
    }
}
