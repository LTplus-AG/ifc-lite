// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `streaming.rs` (ratchet-exempt sibling file).

use super::*;
use crate::admission::{Admission, AdmissionCfg};
use futures::StreamExt;

/// One CPU permit, no memory gate, no queue: while that permit is out, any
/// other request is rejected immediately with 503 OVERLOADED. That rejection
/// is the symptom a stalled SSE client could otherwise inflict on everyone
/// else for the lifetime of its TCP connection.
fn single_slot_admission() -> Arc<Admission> {
    Arc::new(Admission::new(AdmissionCfg {
        max_concurrent_parses: 1,
        mem_budget_bytes: 0,
        queue_depth: 0,
        queue_timeout: Duration::from_millis(10),
        shed_pct: 0,
    }))
}

/// A watched permit: the watchdog owns the stream's share, and the returned
/// sender is what the generator would publish its parked state through.
async fn watched(admission: &Arc<Admission>, initial: Waiting) -> (watch::Sender<Waiting>, Arc<AtomicBool>) {
    let guard = admission.acquire(0).await.expect("the first permit is free");
    let (tx, rx) = watch::channel(initial);
    let cancel = Arc::new(AtomicBool::new(false));
    let (_events_tx, events_rx) = mpsc::unbounded_channel::<StreamEvent>();
    let events: SharedEvents = Arc::new(tokio::sync::Mutex::new(events_rx));
    spawn_idle_watchdog(Arc::new(guard), rx, Arc::clone(&cancel), events, IDLE);
    (tx, cancel)
}

const IDLE: Duration = Duration::from_secs(30);

/// The defect: a client POSTs to `/api/v1/parse/stream`, reads one frame and
/// then stops reading its socket without closing it. The response body is
/// never dropped, so the admission permit it carries is never released, and
/// `max_concurrent_parses` such connections shut the server to everyone.
/// The permit must come back on its own.
/// Regression for #4582.
#[tokio::test(start_paused = true)]
async fn an_idle_consumer_loses_the_streams_admission_permit() {
    let admission = single_slot_admission();
    let (_waiting, cancel) = watched(&admission, Waiting::OnConsumer).await;

    // Inside the window the gate is still shut - the control for the
    // assertion below, which would otherwise pass against an admission that
    // never handed out the permit in the first place.
    tokio::time::sleep(IDLE / 3).await;
    assert!(
        admission.acquire(0).await.is_err(),
        "the permit is legitimately held until the idle bound elapses"
    );

    tokio::time::sleep(IDLE * 3).await;
    assert!(
        cancel.load(Ordering::Relaxed),
        "the parse behind an abandoned stream must be cancelled, not left burning a core"
    );
    assert!(
        admission.acquire(0).await.is_ok(),
        "the permit must be released once the client has consumed nothing for a whole window"
    );
}

/// The false positive that would matter more than the bug: a large model can
/// go minutes between batches, and the stream is then waiting on the PRODUCER,
/// not on the client. Killing that parse would be a regression, so the
/// watchdog must stay silent while the generator is not parked in a `yield`.
/// Regression for #4582.
#[tokio::test(start_paused = true)]
async fn a_slow_parse_keeps_its_permit_because_it_is_not_the_client_stalling() {
    let admission = single_slot_admission();
    let (_waiting, cancel) = watched(&admission, Waiting::OnProducer).await;

    tokio::time::sleep(IDLE * 10).await;
    assert!(!cancel.load(Ordering::Relaxed), "a slow parse must not be cancelled");
    assert!(
        admission.acquire(0).await.is_err(),
        "a parse that is merely slow must keep its permit"
    );
}

/// A client that keeps consuming keeps its permit, however long the stream
/// runs: the bound is on IDLENESS, not on total duration.
/// Regression for #4582.
#[tokio::test(start_paused = true)]
async fn a_client_that_keeps_reading_keeps_its_permit() {
    let admission = single_slot_admission();
    let (waiting, cancel) = watched(&admission, Waiting::OnConsumer).await;

    // Ten windows, one frame taken in each: the generator's yield returns
    // (`OnProducer`) and it parks on the next frame (`OnConsumer`).
    for _ in 0..10 {
        tokio::time::sleep(IDLE / 2).await;
        waiting.send(Waiting::OnProducer).unwrap();
        waiting.send(Waiting::OnConsumer).unwrap();
    }
    assert!(!cancel.load(Ordering::Relaxed));
    assert!(
        admission.acquire(0).await.is_err(),
        "a stream that is being drained must keep its permit"
    );
}

/// The stream ending releases the share at once, not a window later: the
/// generator drops its sender, the watchdog's `changed()` errors, and the
/// task returns with the permit. Nothing lingers for `idle` per finished
/// stream.
/// Regression for #4582.
#[tokio::test(start_paused = true)]
async fn a_finished_stream_releases_its_share_without_waiting_out_the_window() {
    let admission = single_slot_admission();
    let (waiting, cancel) = watched(&admission, Waiting::OnConsumer).await;
    drop(waiting);
    tokio::task::yield_now().await;
    assert!(!cancel.load(Ordering::Relaxed), "a stream that ended was not stalled");
    assert!(
        admission.acquire(0).await.is_ok(),
        "the share must be back the moment the stream is gone, not after {IDLE:?}"
    );
}

/// Zero geometry, so the pipeline emits `Start` then `Complete` and exits
/// immediately: this test is about the permit, not about meshing.
const MINIMAL_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('idle.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

/// End to end through `process_streaming`, so the wiring is covered too: a
/// real stream, a real permit, one frame consumed and then nothing. Real
/// time (not paused) because the producer runs on a blocking thread; the
/// bound is 50ms and the poll loop allows 5s, so the margin is 100x.
/// Regression for #4582.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stalled_sse_body_releases_its_permit_end_to_end() {
    let admission = single_slot_admission();
    let guard = admission.acquire(0).await.expect("the first permit is free");
    let mut stream = process_streaming(
        bytes::Bytes::from_static(MINIMAL_IFC.as_bytes()),
        100,
        1000,
        OpeningFilterMode::Default,
        TessellationQuality::default(),
        StreamAdmission::bounded(guard, Duration::from_millis(50)),
    );

    assert!(stream.next().await.is_some(), "the stream must emit at least one event");

    // The client stops reading here but never closes: `stream` stays alive,
    // exactly as a response body does until the socket goes away.
    let mut released = false;
    for _ in 0..100 {
        if admission.acquire(0).await.is_ok() {
            released = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        released,
        "an SSE body nobody reads must not hold its admission permit for the life of the connection"
    );

    // A client that comes back after the bound must still see the stream END,
    // never hang on a channel whose producer was cancelled, and must not be
    // handed the output that was dropped to free memory: with the permit gone
    // to a replacement stream, this stream's queued `Complete` went with it,
    // so what comes back is one `Error` and the end.
    let rest = tokio::time::timeout(Duration::from_secs(5), stream.collect::<Vec<_>>())
        .await
        .expect("a stream whose permit was released must still terminate");
    assert!(
        !rest.iter().any(|e| matches!(e, StreamEvent::Complete { .. })),
        "the queued Complete was dropped when the watchdog fired; a returning client must not be served it"
    );
    assert!(
        matches!(rest.last(), Some(StreamEvent::Error { .. })),
        "the drained tail must end in an Error frame, got {} event(s)",
        rest.len()
    );
}

/// Response transformation is still producer work: the client cannot drain a
/// frame until serialization has returned it. Regression for #4582.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn slow_response_mapping_does_not_count_as_client_idle() {
    let admission = single_slot_admission();
    let guard = admission.acquire(0).await.expect("the first permit is free");
    let idle = Duration::from_millis(25);
    let mut stream = process_streaming_mapped(
        bytes::Bytes::from_static(MINIMAL_IFC.as_bytes()),
        100,
        1000,
        OpeningFilterMode::Default,
        TessellationQuality::default(),
        StreamAdmission::bounded(guard, idle),
        move |event| {
            std::thread::sleep(idle * 3);
            event
        },
    );

    assert!(stream.next().await.is_some(), "the mapped stream must emit a frame");
    assert!(
        admission.acquire(0).await.is_err(),
        "serialization took longer than the idle bound, but no frame was waiting on the client"
    );
    let rest = stream.collect::<Vec<_>>().await;
    assert!(
        rest.iter().any(|event| matches!(event, StreamEvent::Complete { .. })),
        "a continuously drained stream must finish after slow response mapping"
    );
    let released = tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if admission.acquire(0).await.is_ok() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .is_ok();
    assert!(released, "the completed stream returns its permit");
}

/// On a stall the watchdog drops what the client never took. Without this,
/// the freed permit admits a replacement stream while the old one's whole
/// output stays resident, and a client that stalls one stream per window
/// grows memory without bound with every permit reading as free.
/// Regression for #4582.
#[tokio::test(start_paused = true)]
async fn a_stall_drops_the_undrained_output_not_only_the_permit() {
    let admission = single_slot_admission();
    let guard = admission.acquire(0).await.expect("the first permit is free");
    let (waiting_tx, waiting_rx) = watch::channel(Waiting::OnConsumer);
    let cancel = Arc::new(AtomicBool::new(false));
    let (events_tx, events_rx) = mpsc::unbounded_channel::<StreamEvent>();
    for _ in 0..50 {
        events_tx.send(StreamEvent::Start { total_estimate: 0 }).unwrap();
    }
    let events: SharedEvents = Arc::new(tokio::sync::Mutex::new(events_rx));
    spawn_idle_watchdog(Arc::new(guard), waiting_rx, Arc::clone(&cancel), Arc::clone(&events), IDLE);

    tokio::time::sleep(IDLE * 2).await;
    assert!(cancel.load(Ordering::Relaxed));
    let mut rx = events.try_lock().expect("the watchdog does not keep the queue locked");
    assert!(
        matches!(rx.try_recv(), Err(mpsc::error::TryRecvError::Disconnected)),
        "the 50 queued events must be gone and the queue closed, so the stream ends instead of replaying them"
    );
    drop(waiting_tx);
}

/// No `FILE_SCHEMA` declaration at all must default to IFC2X3 rather than
/// panicking or misreporting a newer schema.
#[test]
fn detect_schema_version_defaults_to_ifc2x3_when_undeclared() {
    let content = b"ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;";
    assert_eq!(detect_schema_version(content), "IFC2X3");
}

#[test]
fn detect_schema_version_detects_ifc4() {
    let content =
        b"ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;";
    assert_eq!(detect_schema_version(content), "IFC4");
}

/// `"IFC4X3"` contains `"IFC4"` as a literal substring, so a checker that
/// tests the IFC4 pattern before the IFC4X3 pattern (or that only ever tests
/// IFC4) would misclassify every IFC4X3 file as IFC4. The IFC4X3 branch must
/// be tried FIRST (or matched precisely) so this doesn't happen.
#[test]
fn detect_schema_version_detects_ifc4x3_not_ifc4() {
    let content = b"ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4X3'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;";
    assert_eq!(detect_schema_version(content), "IFC4X3");
}

/// Schema-like text appearing in the DATA section (after the header's
/// `ENDSEC;`) must NOT influence the detected schema — only the HEADER's
/// `FILE_SCHEMA` declaration is authoritative. The HEADER here declares no
/// `FILE_SCHEMA` at all (so the correct answer is the IFC2X3 default); a scan
/// that doesn't stop at the header's `ENDSEC;` would find the `FILE_SCHEMA`-
/// looking text stored as IFC data and misreport IFC4X3.
#[test]
fn detect_schema_version_ignores_schema_like_text_in_data_section() {
    let content = b"ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nENDSEC;\nDATA;\n#1=IFCTEXT('mentions FILE_SCHEMA((IFC4X3)) in a comment field');\nENDSEC;\nEND-ISO-10303-21;";
    assert_eq!(detect_schema_version(content), "IFC2X3");
}
