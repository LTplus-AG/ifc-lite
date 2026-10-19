// SPDX-License-Identifier: MPL-2.0
//! R1 regression: observe live cache backing at teardown, not just final usage.
use super::inspection::probes::{self, Phase};
use super::*;
use crate::resource::{ExecutionAccount, ExecutionPolicy, ResourceLimits};
use ifc_lite_core::{IfcType, SourceBundle};
use std::{
    cell::RefCell,
    panic::{catch_unwind, AssertUnwindSafe},
    rc::Rc,
    sync::mpsc,
};
const SOURCE: &str =
    include_str!("../../../../processing/tests/fixtures/issue_3641_voiding_trap.ifc");
#[derive(Clone, Copy)]
enum Action {
    Continue,
    Cancel,
    #[cfg(panic = "unwind")]
    Unwind,
}
struct Event {
    phase: Phase,
    decoder_present: bool,
    cached_type: Option<IfcType>,
    live_bytes: u64,
}
struct Observation {
    result: std::thread::Result<Result<Arc<UntrustedProfileChain>, RegionError>>,
    events: Vec<Event>,
    account: ExecutionAccount,
}
fn observe(source: &str, action: Action) -> Observation {
    let bundle = SourceBundle::new(source.as_bytes().to_vec());
    let mut decoder = bundle.decoder();
    let profile = decoder.decode_by_id(61272).unwrap();
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        live_bytes: Some(256 * 1024 * 1024),
        ..Default::default()
    }));
    let shared = account.clone();
    let (query, queries) = mpsc::channel();
    let (answer, answers) = mpsc::channel();
    // A concurrent reader sees the actual shared allowance while capture is
    // blocked at each boundary. No numerical result or account state is mocked.
    let reader = std::thread::spawn(move || {
        while let Ok(phase) = queries.recv() {
            answer.send((phase, shared.usage().live_bytes)).unwrap();
        }
    });
    let events = Rc::new(RefCell::new(Vec::new()));
    let recorded = Rc::clone(&events);
    let cancellation = account.clone();
    let guard = probes::install(move |phase, decoder| {
        let cached_type = decoder
            .and_then(|d| d.get_cached(61274))
            .map(|e| e.ifc_type);
        query.send(phase).unwrap();
        let (observed_phase, live_bytes) = answers.recv().unwrap();
        assert_eq!(observed_phase, phase);
        recorded.borrow_mut().push(Event {
            phase,
            decoder_present: decoder.is_some(),
            cached_type,
            live_bytes,
        });
        if phase == Phase::ReachedPoints {
            match action {
                Action::Continue => {}
                Action::Cancel => cancellation.cancel(),
                #[cfg(panic = "unwind")]
                Action::Unwind => panic!("R1 unwind after actual Points cache admission"),
            }
        }
    });
    let result = catch_unwind(AssertUnwindSafe(|| {
        account.scope(|| capture_untrusted_profile_chain(&profile, decoder))
    }));
    drop(guard);
    reader.join().unwrap();
    let events = Rc::try_unwrap(events).ok().unwrap().into_inner();
    Observation {
        result,
        events,
        account,
    }
}
fn assert_decoder_first(events: &[Event], expected: IfcType) {
    assert_eq!(events.len(), 3);
    assert_eq!(events[0].phase, Phase::ReachedPoints);
    assert_eq!(events[1].phase, Phase::BeforeDecoder);
    assert_eq!(events[2].phase, Phase::AfterDecoder);
    assert!(events[0].live_bytes > 0);
    for event in &events[..2] {
        assert!(event.decoder_present);
        assert_eq!(
            event.cached_type.as_ref(),
            Some(&expected),
            "real admitted cache must exist"
        );
    }
    assert!(!events[2].decoder_present);
    assert_eq!(events[2].cached_type, None);
    // Checking the live boundary is essential: refunding permits before the
    // actual cache destructor could still yield a misleading final usage of 0.
    assert!(events[1].live_bytes >= events[0].live_bytes);
    assert_eq!(events[2].live_bytes, events[1].live_bytes);
}
#[test]
fn r1_large_wrong_type_points_refusal_destroys_cache_before_shared_allowance_refund() {
    let start = SOURCE.find("#61274=").unwrap();
    let end = start + SOURCE[start..].find(';').unwrap() + 1;
    let mut source = SOURCE.to_string();
    source.replace_range(
        start..end,
        &format!(
            "#61274=IFCPROPERTYSINGLEVALUE('Large wrong Points',$,IFCLABEL('{}'),$);",
            "x".repeat(16 * 1024)
        ),
    );
    let observed = observe(&source, Action::Continue);
    assert_decoder_first(&observed.events, IfcType::IfcPropertySingleValue);
    assert_eq!(observed.events[1].live_bytes, observed.events[0].live_bytes);
    assert!(matches!(
        observed.result,
        Ok(Err(RegionError::Unsupported(RegionRefusal::SourceFamily)))
    ));
    assert_eq!(
        observed.account.check(),
        Ok(()),
        "ordinary refusal must not stop shared account"
    );
    assert_eq!(observed.account.usage().live_bytes, 0);
}
#[test]
fn r1_success_destroys_inspection_cache_before_transferring_raw_permits() {
    let observed = observe(SOURCE, Action::Continue);
    assert_decoder_first(&observed.events, IfcType::IfcCartesianPointList2D);
    let raw = match observed.result {
        Ok(Ok(raw)) => raw,
        _ => panic!("raw capture"),
    };
    assert!(matches!(
        raw.original().status,
        crate::analytic::AnalyticStatus::Unsupported(_)
    ));
    assert_eq!(
        observed.account.usage().live_bytes,
        observed.events[2].live_bytes
    );
    let cert = regularize_untrusted_lines(Arc::clone(&raw), RegionLimits::default()).unwrap();
    drop(raw);
    assert_eq!(cert.source().original().profile_id, 61272);
    assert!(observed.account.usage().live_bytes > observed.events[2].live_bytes);
    drop(cert);
    assert_eq!(observed.account.usage().live_bytes, 0);
}
#[test]
fn r1_typed_cancel_after_actual_points_admission_keeps_permits_through_decoder_drop() {
    let observed = observe(SOURCE, Action::Cancel);
    assert_decoder_first(&observed.events, IfcType::IfcCartesianPointList2D);
    assert!(matches!(
        observed.result,
        Ok(Err(RegionError::Stopped(resource::ProgramStop::Cancelled)))
    ));
    assert_eq!(
        observed.account.check(),
        Err(resource::ProgramStop::Cancelled)
    );
    assert_eq!(observed.account.usage().live_bytes, 0);
}
#[cfg(panic = "unwind")]
#[test]
fn r1_unwind_after_actual_points_admission_keeps_permits_through_decoder_drop() {
    let observed = observe(SOURCE, Action::Unwind);
    assert_decoder_first(&observed.events, IfcType::IfcCartesianPointList2D);
    assert!(observed.result.is_err());
    assert_eq!(observed.account.usage().live_bytes, 0);
}
