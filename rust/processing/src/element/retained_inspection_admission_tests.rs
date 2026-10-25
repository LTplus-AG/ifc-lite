// SPDX-License-Identifier: MPL-2.0
//! #7955 R1/R2: actual geometry entry admission and deadline/origin interaction.
use super::*;
use super::tests::{SOURCE, OPTIONS, commit, run};
use resource::{Dimension, RefusalReason, ResourceFailure, inspection_test_clock as clock};

fn account(limits: ResourceLimits) -> ExecutionAccount {
    ExecutionAccount::new(ExecutionPolicy::Bounded(limits))
}

fn direct(options: &str, ambient: Option<&ExecutionAccount>, edit: impl FnOnce(&mut String))
    -> Result<SourceInspectionReport, SourceInspectionError> {
    // Authenticate the real decoder/root/binding independently, with no outer
    // processing inspection allowance or scratch reservation around geometry.
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let snapshot = ProductionModel::from_source(source.clone()).snapshot(Default::default());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_scale(1.);
    let root = decoder.decode_by_id(10).unwrap();
    let options = wire::decode_options(options).unwrap();
    let binding = binding::from_source(&source, &root, &options, 1).unwrap();
    let mut json = serde_json::to_string(&binding).unwrap();
    edit(&mut json);
    let mut owner = session_owner::ProductOwner::admit(&decoder, &router).unwrap();
    let mut inspect = || owner.work(&mut decoder, &router, |decoder, router| {
        snapshot.validate_decoder(decoder).unwrap();
        ifc_lite_geometry::program::inspect_retained_program_source(
            &root, decoder, router, &json, 0, &commit())
    }).unwrap().0;
    match ambient { Some(ambient) => ambient.scope(inspect), None => inspect() }
}

#[test]
fn issue_7955_r1_direct_geometry_refuses_before_owned_binding_decode() {
    let tiny = OPTIONS.replace("16777216", "1");
    for (options, ambient) in [
        (tiny.as_str(), None),
        (tiny.as_str(), Some(account(Default::default()))),
        (OPTIONS, Some(account(ResourceLimits { live_bytes: Some(0), ..Default::default() }))),
    ] {
        clock::scope(|clock| {
            // This independent clock observer does not share the account that
            // the deliberate admission refusal stops. Reaching the real owned
            // decode would expire it, even if that entry ultimately refused.
            let observer = InspectionBudget::new(InspectionStart::now(), 10000, 16777216, 10000);
            clock.expire_at("binding_decode", 1, 10000);
            let error = direct(options, ambient.as_ref(), |_| {}).err().unwrap();
            assert!(matches!(error, SourceInspectionError::Stopped(ProgramStop::ResourceRefused(ResourceFailure {
                dimension: Dimension::LiveBytes, requested: 262144, remaining: 0 | 1,
                reason: RefusalReason::Limit,
            }))));
            assert!(observer.scope(resource::inspection_checkpoint).is_ok(), "owned decode ran before admission");
            if let Some(ambient) = ambient {
                assert_eq!(ambient.usage().peak_live_bytes, 0);
                assert_eq!(ambient.check().err().map(SourceInspectionError::Stopped), Some(error));
            }
        });
    }
    clock::scope(|clock| {
        let observer = InspectionBudget::new(InspectionStart::now(), 10000, 16777216, 10000);
        clock.expire_at("binding_decode", 1, 10000);
        assert_eq!(direct(OPTIONS, None, |_| {}).err(), Some(SourceInspectionError::DeadlineExceeded));
        assert!(matches!(observer.scope(resource::inspection_checkpoint),
            Err(ifc_lite_geometry::Error::InspectionDeadlineExceeded)));
    });
}

#[test]
fn issue_7955_r1_bootstrap_keeps_authoritative_strict_binding_validation() {
    let report = direct(OPTIONS, None, |json| {
        *json = json.replace("\"maxBytes\":\"16777216\"", r#""max\u0042ytes":"\u00316777216""#);
    }).unwrap();
    let value: serde_json::Value = serde_json::from_slice(report.bytes().unwrap()).unwrap();
    assert_eq!(value["identity"]["options"]["maxBytes"], "16777216");
    assert_eq!(value["outcome"]["kind"], "requires_numerical_evaluation");
    for (from, to) in [
        ("\"enumerationComplete\":", "\"extra\":0,\"enumerationComplete\":"),
        ("\"enumerationComplete\":", "\"enumerationComplete\":false,\"enumerationComplete\":"),
        ("\"engine\":\"retained\"", "\"engine\":\"other\""),
        ("\"maxBytes\":\"16777216\"", "\"maxBytes\":\"1\",\"maxBytes\":\"16777216\""),
    ] {
        assert_eq!(direct(OPTIONS, None, |json| {
            assert!(json.contains(from));
            *json = json.replace(from, to);
        }).err(), Some(SourceInspectionError::InvalidReport));
    }
}

fn disk_source(boolean: bool) -> Arc<SourceBundle> {
    let points = (0..128).map(|i| format!("#{}", i + 100)).collect::<Vec<_>>().join(",");
    let records = (0..128).map(|i| format!("#{}=IFCCARTESIANPOINT(({}.,0.,0.));", i + 100, i))
        .collect::<String>();
    let mut text = SOURCE.replace("#13=IFCEXTRUDEDAREASOLID(#14,#2,#3,3.);",
        &format!("#13=IFCSWEPTDISKSOLID(#30,0.1,$,$,$);#30=IFCPOLYLINE(({points}));{records}"));
    if boolean {
        text = text.replace("(#13));", "(#40));#40=IFCBOOLEANRESULT(.UNION.,#13,#23);");
    }
    SourceBundle::new(text.into_bytes())
}

fn expire_in_curve(source: Arc<SourceBundle>, original: &ExecutionAccount) -> RetainedInspectionError {
    clock::scope(|clock| {
        // Only one structural item. The 100th step is in its constructor's
        // directrix/source traversal, including when reached as a Boolean operand.
        clock.expire_at("source_step", 100, 10000);
        original.scope(|| run(source, OPTIONS)).err().unwrap()
    })
}

#[test]
fn issue_7955_r2_tight_bytes_deadline_never_records_a_constructor_or_boolean_origin() {
    for boolean in [false, true] {
        let source = disk_source(boolean);
        let generous = account(Default::default());
        let error = expire_in_curve(source.clone(), &generous);
        assert_eq!(error.diagnostic_code_json(), "\"DEADLINE_EXCEEDED\"");
        assert_eq!(error.original_stop(), None);
        assert!(generous.check().is_ok());

        // Independent calibration: refuse WORK at the same source checkpoint.
        // ProgramStopped already bypasses every origin adapter, so this peak
        // cannot include a deadline-origin allocation even on the broken code.
        let control = account(ResourceLimits { work: Some(generous.usage().work), ..Default::default() });
        let stopped = control.scope(|| run(source.clone(), OPTIONS)).err().unwrap();
        assert!(matches!(stopped.original_stop(), Some(ProgramStop::ResourceRefused(ResourceFailure {
            dimension: Dimension::Work, requested: 1, remaining: 0, ..
        }))));
        let bytes = control.usage().peak_live_bytes;
        assert!(bytes >= 2 * 256 * 1024);
        let tight = account(ResourceLimits { live_bytes: Some(bytes), ..Default::default() });
        let error = expire_in_curve(source.clone(), &tight);
        assert_eq!(error.diagnostic_code_json(), "\"DEADLINE_EXCEEDED\"", "Boolean: {boolean}");
        assert_eq!(error.original_stop(), None, "deadline must not invent a resource stop");
        assert!(tight.check().is_ok(), "the original account remains healthy");
        assert_eq!(tight.usage().peak_live_bytes, bytes);

        // An independently existing stop still beats expiry; do not repair the
        // interaction by globally prioritizing deadlines over original stops.
        let independent = account(Default::default());
        let stop = ProgramStop::ResourceRefused(ResourceFailure {
            dimension: Dimension::CopyBytes, requested: 17, remaining: 3, reason: RefusalReason::Limit,
        });
        clock::scope(|clock| {
            let budget = independent.scope(|| InspectionBudget::new(InspectionStart::now(), 10000, 16777216, 10000));
            clock.advance(10000);
            independent.stop(stop);
            let error = budget.scope(|| run(source, OPTIONS)).err().unwrap();
            assert_eq!(error.original_stop(), Some(stop));
        });
    }
}
