// SPDX-License-Identifier: MPL-2.0
//! #7955 C2/C3: public-entry bounds, real source work, and original-clock delivery.
use super::*;
use resource::{Dimension, RefusalReason, ResourceFailure, inspection_test_clock as clock};

// Share the parsed STEP fixture, not a mock or a source-text assertion.
use super::tests::{SOURCE, OPTIONS, commit, run};
fn generous() -> ExecutionAccount {
    ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()))
}
fn source() -> Arc<SourceBundle> { SourceBundle::new(SOURCE.as_bytes().to_vec()) }

#[test]
fn issue_7955_c2_public_work_limit_covers_serialization_under_generous_ambient() {
    let baseline = generous();
    let report = baseline.scope(|| run(source(), OPTIONS)).unwrap();
    let json: serde_json::Value = serde_json::from_slice(report.bytes().unwrap()).unwrap();
    let requests = json["outcome"]["requestOrdinal"].as_str().unwrap().parse::<u64>().unwrap();
    let limit = report.bytes().unwrap().len() as u64 - 1;
    assert!(requests < limit && limit < baseline.usage().work);
    let options = OPTIONS.replace("\"maxWork\":\"10000\"", &format!("\"maxWork\":\"{limit}\""));
    let standalone = run(source(), &options).err().unwrap();
    let ambient = generous();
    let error = ambient.scope(|| {
        resource::charge(Cost { work: 37, ..Default::default() }).unwrap();
        run(source(), &options)
    }).err().unwrap();
    assert_eq!(error.original_stop(), standalone.original_stop());
    assert_eq!(ambient.check().err(), error.original_stop());
    assert!(ambient.usage().work >= 37 && ambient.usage().work <= 37 + limit);
    assert!(matches!(error.original_stop(), Some(ProgramStop::ResourceRefused(ResourceFailure {
        dimension: Dimension::Work, reason: RefusalReason::Limit, ..
    }))));
}

#[test]
fn issue_7955_c2_public_byte_limit_refuses_report_backing_before_growth() {
    let baseline = generous();
    let report = baseline.scope(|| run(source(), OPTIONS)).unwrap();
    let length = report.bytes().unwrap().len() as u64;
    let limit = baseline.usage().peak_live_bytes - 1;
    assert!(limit > 2 * 256 * 1024 && limit < 1024 * 1024);
    let options = OPTIONS.replace("\"maxBytes\":\"16777216\"", &format!("\"maxBytes\":\"{limit}\""));
    let standalone = run(source(), &options).err().unwrap();
    let ambient = generous();
    let error = ambient.scope(|| run(source(), &options)).err().unwrap();
    assert_eq!(error.original_stop(), standalone.original_stop());
    assert_eq!(error.original_stop(), Some(ProgramStop::ResourceRefused(ResourceFailure {
        dimension: Dimension::LiveBytes, requested: length, remaining: length - 1, reason: RefusalReason::Limit,
    })));
    // Independent original-account invariant: every covered allocation must be
    // charged before growth. The old after-allocation check exceeds this peak.
    assert!(ambient.usage().peak_live_bytes <= limit);
    assert_eq!(ambient.check().err(), error.original_stop());
}

#[test]
fn issue_7955_c2_report_permit_refunds_original_account_under_foreign_scope() {
    let original = generous();
    let report = original.scope(|| run(source(), OPTIONS)).unwrap();
    let bytes = report.bytes().unwrap().len() as u64;
    let held = original.usage().live_bytes;
    let foreign = generous();
    foreign.scope(|| drop(report));
    assert_eq!(original.usage().live_bytes, held - bytes);
    assert_eq!(foreign.usage(), resource::Usage::default());
    // Inherited retain() charges remain conservative; this asserts only the
    // report's actual backing lifetime, not complete temporary-storage refund.
}

#[test]
fn issue_7955_c3_public_deadline_covers_source_admit_serialization_and_delivery() {
    for stage in ["options", "units", "root", "hash_chunk", "hash_done", "binding", "admit",
        "report_count", "report_write", "strict_decode", "owner_return", "delivery"] {
        clock::scope(|clock| {
            clock.expire_at(stage, 1, 10000);
            let account = generous();
            let source = source();
            let mut decoder = source.decoder();
            let error = account.scope(|| inspect_retained_source(source.clone(), 10, None, &mut decoder, OPTIONS, &commit()))
                .err().unwrap_or_else(|| panic!("deadline not checked at {stage}"));
            assert_eq!(error.diagnostic_code_json(), "\"DEADLINE_EXCEEDED\"", "{stage}");
            assert_eq!(error.original_stop(), None, "deadline is not fabricated as cancellation");
            assert!(account.check().is_ok());
            assert!(decoder.try_execution_lease().is_ok());
        });
    }
}

#[test]
fn issue_7955_c3_public_source_loop_and_refusal_delivery_check_original_deadline() {
    let many = SOURCE.replace("(#13));", &format!("({}));", vec!["#13"; 512].join(",")));
    clock::scope(|clock| {
        clock.expire_at("source_step", 30, 10000);
        let error = run(SourceBundle::new(many.into_bytes()), OPTIONS).err().unwrap();
        assert_eq!(error.diagnostic_code_json(), "\"DEADLINE_EXCEEDED\"");
    });
    clock::scope(|clock| {
        clock.expire_at("report_write", 1, 10000);
        let malformed = SOURCE.replace("(#13));", "(#13,$));");
        let error = run(SourceBundle::new(malformed.into_bytes()), OPTIONS).err().unwrap();
        assert_eq!(error.diagnostic_code_json(), "\"DEADLINE_EXCEEDED\"");
    });
}

#[test]
fn issue_7955_c3_returned_report_keeps_original_clock_and_stop_priority() {
    clock::scope(|original_clock| {
        let original = generous();
        let report = original.scope(|| run(source(), OPTIONS)).unwrap();
        let foreign = generous();
        clock::scope(|foreign_clock| {
            foreign_clock.advance(50000);
            foreign.scope(|| assert!(report.bytes().is_ok()));
            original_clock.advance(10000);
            resource::detached(|| assert_eq!(report.bytes().err().unwrap().diagnostic_code_json(), "\"DEADLINE_EXCEEDED\""));
            let stop = ProgramStop::ResourceRefused(ResourceFailure {
                dimension: Dimension::Work, requested: 23, remaining: 17, reason: RefusalReason::Limit,
            });
            original.stop(stop);
            foreign.scope(|| assert_eq!(report.bytes().err().unwrap().original_stop(), Some(stop)));
            assert!(foreign.check().is_ok());
            assert_eq!(foreign.usage(), resource::Usage::default());
        });
    });
}
