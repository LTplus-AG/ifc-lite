// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Which thread a parse route's whole-model encode ran on (#4634, #4696).
//!
//! Under `#[tokio::test]` the runtime is `current_thread`, so its one worker
//! IS the test's thread, and every `spawn_blocking` closure runs on some other
//! thread. A route logs an event right after the encode, carrying the
//! request's `cache_key`, and the recording layer here notes the thread each
//! such event came from. An encode on the worker (the defect) puts the event
//! on the test's own thread.
//!
//! One layer for the whole test binary: `set_global_default` can succeed only
//! once per process, so every route test shares this recorder.

use std::sync::{Arc, Mutex, OnceLock};
use std::thread::ThreadId;
use std::time::Duration;
use tracing_subscriber::layer::SubscriberExt;

/// What `cache_keys::cache_symbolic_data` logs, under the sidecar's key, once
/// the stream it encoded has been written.
pub(super) const SYMBOLIC_CACHED: &str = "Symbolic data cached";

/// `(message, cache_key, thread)` for every event that carries a `cache_key`.
type EventThreads = Arc<Mutex<Vec<(String, String, ThreadId)>>>;

struct RecordEventThread(EventThreads);

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for RecordEventThread {
    fn on_event(&self, event: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        #[derive(Default)]
        struct Fields {
            message: String,
            cache_key: Option<String>,
        }
        impl tracing::field::Visit for Fields {
            fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
                match field.name() {
                    "message" => self.message = format!("{value:?}"),
                    "cache_key" => self.cache_key = Some(format!("{value:?}")),
                    _ => {}
                }
            }
        }
        let mut fields = Fields::default();
        event.record(&mut fields);
        if let Some(cache_key) = fields.cache_key {
            self.0
                .lock()
                .unwrap()
                .push((fields.message, cache_key, std::thread::current().id()));
        }
    }
}

/// Install the recording layer as the process-wide `tracing` subscriber,
/// once. Global rather than thread-scoped because the events under test are
/// emitted from blocking-pool threads, which a `with_default` scope on the
/// test thread would never see. Call it BEFORE sending the request.
pub(super) fn record_event_threads() {
    recorder();
}

fn recorder() -> EventThreads {
    static RECORDER: OnceLock<EventThreads> = OnceLock::new();
    RECORDER
        .get_or_init(|| {
            let seen: EventThreads = Arc::new(Mutex::new(Vec::new()));
            let subscriber =
                tracing_subscriber::registry().with(RecordEventThread(Arc::clone(&seen)));
            tracing::subscriber::set_global_default(subscriber)
                .expect("no other test in this binary installs a global tracing subscriber");
            seen
        })
        .clone()
}

/// The threads that logged `message` for `cache_key` so far.
pub(super) fn threads_that_logged(message: &str, cache_key: &str) -> Vec<ThreadId> {
    recorder()
        .lock()
        .unwrap()
        .iter()
        .filter(|(m, key, _)| m == message && key == cache_key)
        .map(|(_, _, thread)| *thread)
        .collect()
}

/// Wait until `message` has been logged for `cache_key`, and return the
/// threads that logged it. Some of these events come from a detached cache
/// task, so the response alone does not mean they have fired. Sleeping here
/// also yields this test's runtime, which is what lets a task spawned on it run.
pub(super) async fn await_threads_that_logged(message: &str, cache_key: &str) -> Vec<ThreadId> {
    for _ in 0..400 {
        let threads = threads_that_logged(message, cache_key);
        if !threads.is_empty() {
            return threads;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("{message:?} was never logged for cache_key {cache_key}");
}

/// Assert that none of `threads` is this test's thread, i.e. the runtime's
/// only worker.
pub(super) fn assert_off_the_worker(threads: &[ThreadId], what: &str) {
    let worker = std::thread::current().id();
    assert!(
        !threads.is_empty() && threads.iter().all(|thread| *thread != worker),
        "{what} ran on the async worker (this test's thread, {worker:?}) instead of the blocking pool: {threads:?}"
    );
}
