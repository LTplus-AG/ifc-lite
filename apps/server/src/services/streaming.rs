// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Streaming geometry processing with Server-Sent Events.
//!
//! Thin bridge over the canonical `ifc_lite_processing` pipeline: the
//! blocking task runs `process_geometry_streaming_filtered_with_options`
//! (the same code path as `POST /api/v1/parse` and the wasm
//! `processGeometryBatch` boundary) and forwards its batch callbacks through
//! an unbounded channel as [`StreamEvent`]s.
//!
//! This file used to host a third, bespoke geometry pipeline with its own
//! scan, style index (SurfaceColour-only, no material chain, no indexed
//! colour maps), no aggregate void propagation, no submeshes and no type
//! geometry — meshes streamed from `/parse/stream` could differ from every
//! other surface (alignment audit). Supersede means delete: it is gone, and
//! the streaming endpoints inherit every pipeline feature (and bug fix)
//! automatically, including `opening_filter` support which the bespoke
//! pipeline never had.

use crate::admission::AdmissionGuard;
use crate::services::cache::DiskCache;
use crate::types::StreamEvent;
use async_stream::stream;
use futures::Stream;
use ifc_lite_processing::{
    extract_symbolic_data_with_provenance, process_geometry_streaming_filtered_with_options, OpeningFilterMode,
    StreamingOptions, TessellationQuality,
};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, watch};

mod admission;
pub use admission::StreamAdmission;

/// The response stream's event queue, shared with the watchdog so that on a
/// stall it can drop what the client never took.
type SharedEvents = Arc<tokio::sync::Mutex<mpsc::UnboundedReceiver<StreamEvent>>>;

/// Which side the response stream is waiting on, published to the watchdog
/// around every `yield`. Only a stall while parked `OnConsumer` is the
/// client's fault: a large model can go minutes between batches, and that
/// wait is `OnProducer`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Waiting {
    OnProducer,
    OnConsumer,
}

/// Release the stream's share of the permit, and stop the parse, once the
/// client has gone `idle` without taking the frame it was handed.
///
/// The watchdog OWNS that share. It ends, releasing it, when either the
/// generator drops its sender (the stream finished or the connection went
/// away, so no task lingers) or a whole window passes with the generator
/// parked `OnConsumer` and no state change since. `changed()` wakes on every
/// `send`, so a client that keeps taking frames keeps the window resetting.
///
/// Why a task the runtime drives, rather than a body timeout layer, for two
/// independent reasons read off tower-http's `TimeoutBody::poll_frame`:
///
///  - it creates and polls its `Sleep` INSIDE `poll_frame`. When the client
///    stops reading, its socket buffer fills and hyper stops polling the
///    response body at all, so that timer is never polled either and never
///    fires. Only something driven independently of the body observes a stall.
///  - it times the BODY's production of a frame, not the client's
///    consumption of one, so it would also fire on a legitimately slow parse
///    and cancel exactly the requests that need the permit most.
///
/// On a stall it also drops the events still queued for the stalled client.
/// The permit coming back admits a replacement stream, so leaving the old
/// stream's output resident would let a client that stalls one stream per
/// window grow memory without bound while every permit reads as free. The
/// client that stalled reads a truncated stream ending in an `Error` frame if
/// it ever comes back, which is the honest answer.
fn spawn_idle_watchdog(
    share: Arc<AdmissionGuard>,
    mut waiting: watch::Receiver<Waiting>,
    cancel: Arc<AtomicBool>,
    events: SharedEvents,
    idle: Duration,
) {
    tokio::spawn(async move {
        let _share = share;
        loop {
            match tokio::time::timeout(idle, waiting.changed()).await {
                // Sender dropped: the stream ended or was dropped, and its
                // own share went with it. Ours goes now.
                Ok(Err(_)) => return,
                Ok(Ok(())) => continue,
                Err(_elapsed) => {
                    // `Timeout` polls `changed()` BEFORE its sleep, so a
                    // `send` landing between those two polls is a state that
                    // changed inside the window and has not been observed
                    // yet: a frame handed off after a long producer gap, not
                    // a stall. Ask once more before deciding.
                    match waiting.has_changed() {
                        Err(_) => return,
                        Ok(true) => continue,
                        Ok(false) if *waiting.borrow() == Waiting::OnConsumer => {}
                        // Idle on the producer's side: not the client's doing.
                        Ok(false) => continue,
                    }
                    cancel.store(true, Ordering::Relaxed);
                    // Releasing the permit lets a NEW stream be admitted, so
                    // what this stream already produced must go too, or a
                    // client that stalls one stream per window accumulates
                    // an unbounded number of un-reserved, undrained buffers.
                    // The generator is parked in its `yield` and cannot do
                    // this itself; it holds the lock only inside `recv`,
                    // which is never where a stall is declared.
                    let dropped = match events.try_lock() {
                        Ok(mut rx) => {
                            rx.close();
                            let mut n = 0usize;
                            while rx.try_recv().is_ok() {
                                n += 1;
                            }
                            n
                        }
                        Err(_) => 0,
                    };
                    tracing::warn!(
                        idle_secs = idle.as_secs(),
                        dropped_events = dropped,
                        "Streaming client consumed no frame within the idle bound; dropping the stream's share of its admission permit and its undrained output, and cancelling the parse (the permit frees when the parse stops)"
                    );
                    return;
                }
            }
        }
    });
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Detect the declared IFC schema from the STEP header.
///
/// Schema-like text in DATA values or comments must not influence metadata.
pub(crate) fn detect_schema_version(content: &[u8]) -> &'static str {
    let header_end = find_bytes(content, b"ENDSEC;").unwrap_or(content.len());
    let header = &content[..header_end];
    let Some(schema_start) = find_bytes(header, b"FILE_SCHEMA") else {
        return "IFC2X3";
    };
    let declaration = &header[schema_start..];
    let declaration_end = declaration
        .iter()
        .position(|byte| *byte == b';')
        .unwrap_or(declaration.len());
    let declaration = &declaration[..declaration_end];

    if find_bytes(declaration, b"IFC4X3").is_some() {
        "IFC4X3"
    } else if find_bytes(declaration, b"IFC4").is_some() {
        "IFC4"
    } else {
        "IFC2X3"
    }
}

/// Generate streaming geometry events backed by the canonical pipeline.
///
/// Takes the raw IFC bytes (issue #1023): localized non-UTF-8 byte sequences
/// in the HEADER must not block otherwise valid models, so no `String`
/// conversion happens anywhere on this path.
#[cfg(test)]
pub fn process_streaming(
    content: bytes::Bytes,
    initial_batch_size: usize,
    max_batch_size: usize,
    opening_filter: OpeningFilterMode,
    tessellation_quality: TessellationQuality,
    admission: StreamAdmission,
) -> Pin<Box<dyn Stream<Item = StreamEvent> + Send>> {
    process_streaming_mapped(
        content,
        initial_batch_size,
        max_batch_size,
        opening_filter,
        tessellation_quality,
        admission,
        |event| event,
    )
}

/// Generate streaming geometry events and finish response-specific CPU work
/// before the watchdog starts charging client-idle time for each frame.
///
/// A `StreamExt::map` outside [`process_streaming`] runs while the inner
/// generator is suspended at `yield`, which is already classified as
/// [`Waiting::OnConsumer`]. Parquet serialization can take longer than the
/// idle bound without the client having received anything to consume. Keeping
/// the mapper inside this generator makes that work producer time; only the
/// mapped, ready-to-send frame is timed as consumer work.
pub fn process_streaming_mapped<T, F>(
    content: bytes::Bytes,
    initial_batch_size: usize,
    max_batch_size: usize,
    opening_filter: OpeningFilterMode,
    tessellation_quality: TessellationQuality,
    admission: StreamAdmission,
    mut map_event: F,
) -> Pin<Box<dyn Stream<Item = T> + Send>>
where
    T: Send + 'static,
    F: FnMut(StreamEvent) -> T + Send + 'static,
{
    let StreamAdmission { guard: admission, idle_timeout } = admission;
    // Zero is a caller bug, not a reason to stall the stream.
    let initial_batch_size = initial_batch_size.max(1);
    let max_batch_size = max_batch_size.max(1);

    let (tx, rx) = mpsc::unbounded_channel::<StreamEvent>();

    // Disconnect-aware cancellation: when the SSE client hangs up, the
    // receiver drops, the batch callback notices via `tx.is_closed()`, and the
    // streaming core stops between chunks instead of meshing the rest of the
    // model for nobody (a full-size parse used to keep burning a core and its
    // memory slot to completion).
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let cancel_for_task = std::sync::Arc::clone(&cancel);

    // The admission permit must be held until BOTH sides are done: the
    // blocking producer (on disconnect the stream drops first, but the task
    // keeps its memory/CPU until the cooperative cancel takes effect) AND the
    // response stream (the unbounded channel can hold every emitted batch
    // after a fast producer exits, so dropping the permit at task exit would
    // let a replacement parse be admitted on top of the undrained buffers).
    // An Arc'd guard held by both releases on whichever finishes last.
    let admission = admission.map(Arc::new);
    let admission_for_task = admission.clone();

    // ...with a CEILING on the response stream's half. A response body is
    // dropped when the connection closes, and nothing closes the connection
    // of a client that simply stops reading: it can open
    // `max_concurrent_parses` streams, stop draining them, and every later
    // parse request from anyone is shed with 503 OVERLOADED. `TimeoutLayer`
    // does not cover this - it races its sleep against the HANDLER future,
    // which returned as soon as the response was built. So when a bound is
    // configured the stream's share of the permit is OWNED by the watchdog,
    // which releases it on the stream's end or on a stall, whichever comes
    // first; without one the generator holds the share itself, as before.
    let events: SharedEvents = Arc::new(tokio::sync::Mutex::new(rx));
    let (waiting_tx, waiting_rx) = watch::channel(Waiting::OnProducer);
    let stream_share = match (idle_timeout, admission) {
        (Some(idle), Some(share)) => {
            spawn_idle_watchdog(share, waiting_rx, Arc::clone(&cancel), Arc::clone(&events), idle);
            None
        }
        (_, share) => share,
    };

    let handle = tokio::task::spawn_blocking(move || {
        let _admission = admission_for_task;
        let cache_key = DiskCache::generate_key(&content);

        let mut started = false;
        let mut batch_number = 0usize;
        let mut last_type = String::new();

        let result = process_geometry_streaming_filtered_with_options(
            &content,
            opening_filter,
            StreamingOptions {
                initial_batch_size,
                throughput_batch_size: max_batch_size,
                tessellation_quality,
                // Batches are forwarded as they are emitted — retaining them
                // in the ProcessingResult would double peak memory.
                retain_emitted_meshes: false,
                cancel: Some(std::sync::Arc::clone(&cancel_for_task)),
                ..StreamingOptions::default()
            },
            |meshes, processed, total| {
                if tx.is_closed() {
                    cancel_for_task.store(true, std::sync::atomic::Ordering::Relaxed);
                    return;
                }
                if !started {
                    started = true;
                    let _ = tx.send(StreamEvent::Start {
                        total_estimate: total,
                    });
                    let _ = tx.send(StreamEvent::Progress {
                        processed: 0,
                        total,
                        current_type: "indexing".into(),
                    });
                }
                if let Some(mesh) = meshes.last() {
                    last_type = mesh.ifc_type.clone();
                }
                if !meshes.is_empty() {
                    batch_number += 1;
                    let _ = tx.send(StreamEvent::Batch {
                        meshes: meshes.to_vec(),
                        batch_number,
                    });
                }
                let _ = tx.send(StreamEvent::Progress {
                    processed,
                    total,
                    current_type: last_type.clone(),
                });
            },
            // Styling is eager on this path (`fast_first_batch` defaults to
            // false), so colour updates never fire.
            |_| {},
            |_| {},
        );

        if cancel_for_task.load(std::sync::atomic::Ordering::Relaxed) || tx.is_closed() {
            // Client gone: the partial result must not be presented as a
            // completed parse - skip Complete AND the symbolic extraction
            // (which re-scans the file). The is_closed check also covers a
            // disconnect after the LAST batch, where the callback can no
            // longer observe it.
            tracing::info!("SSE client disconnected; streaming parse stopped early");
            return;
        }

        if !started {
            // Zero-geometry model: the batch callback never ran. Emit Start
            // so consumers still observe the Start → Complete contract.
            let _ = tx.send(StreamEvent::Start { total_estimate: 0 });
        }

        // 2D symbolic stream (IfcAnnotation + IfcGrid) on the same blocking
        // thread — parity with the synchronous endpoints (issue #900).
        // Georeferencing already rides in `result.metadata`.
        let symbolic_data = extract_symbolic_data_with_provenance(&content);

        let _ = tx.send(StreamEvent::Complete {
            stats: result.stats,
            metadata: result.metadata,
            cache_key,
            mesh_coordinate_space: result.mesh_coordinate_space,
            site_transform: result.site_transform,
            building_transform: result.building_transform,
            symbolic_data,
        });
        // `tx` drops here, closing the channel and ending the stream below.
    });

    Box::pin(stream! {
        // Both drop when the stream ends or is dropped: the share directly,
        // the sender by ending the watchdog that owns the share.
        let _stream_share = stream_share;
        let waiting = waiting_tx;
        let mut completed = false;
        // The lock is held only across `recv`, never across a `yield`, which
        // is what lets the watchdog take it on a stall.
        while let Some(event) = { let mut rx = events.lock().await; rx.recv().await } {
            completed |= matches!(event, StreamEvent::Complete { .. });
            let event = map_event(event);
            // Parked on the CONSUMER from here until the yield returns; the
            // watchdog only counts a stall in this state. A failed send means
            // the watchdog already fired and is gone, which is fine.
            let _ = waiting.send(Waiting::OnConsumer);
            yield event;
            let _ = waiting.send(Waiting::OnProducer);
        }
        // Surface a panicked/cancelled blocking task as a stream error
        // instead of silently truncating the SSE stream. These frames park
        // the generator on the consumer exactly like the ones above, so a
        // client that stalls on the very last frame (a producer panic on a
        // malformed file is the likely one) is still seen as stalled.
        if let Err(e) = handle.await {
            let event = map_event(StreamEvent::Error {
                message: format!("Streaming geometry task failed: {e}"),
            });
            let _ = waiting.send(Waiting::OnConsumer);
            yield event;
        } else if !completed && cancel.load(Ordering::Relaxed) {
            // The watchdog cut the parse short. A client that disconnected
            // never reads this; one that stalled and came back must not
            // mistake a truncated stream for a finished model.
            let event = map_event(StreamEvent::Error {
                message: "Streaming parse cancelled: no frame was consumed within the idle bound".into(),
            });
            let _ = waiting.send(Waiting::OnConsumer);
            yield event;
        }
    })
}

#[cfg(test)]
#[path = "streaming_tests.rs"]
mod streaming_tests;
