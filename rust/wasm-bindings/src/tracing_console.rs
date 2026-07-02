// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Browser console forwarding for `tracing` events - the wasm counterpart of
//! the native server's `tracing_subscriber::fmt` layer, so the client-side
//! geometry pipeline (the production-critical path) is no longer dark.
//!
//! Compiled ONLY under the `console-tracing` cargo feature, which also turns
//! on the geometry crate's `observability` diagnostics (via
//! `ifc-lite-processing/observability`). The default wasm bundle carries zero
//! tracing code and is byte-identical to before; build a diagnostics bundle
//! with `--features console-tracing` and call `initConsoleTracing("debug")`
//! from JS to light it up. Events map trace/debug -> console.debug,
//! info -> console.info, warn -> console.warn, error -> console.error,
//! matching the level discipline in `csg_diagnostics.rs`.
//!
//! A deliberately minimal `Subscriber` (events only, spans accepted but not
//! tracked): the processing crate's phase spans still gate their `info!`
//! events, and a full span-tree renderer is not worth the bundle bytes here.

use std::fmt::Write as _;
use std::sync::atomic::{AtomicUsize, Ordering};

use wasm_bindgen::prelude::*;

/// Current max verbosity as a usize rank (0=ERROR .. 4=TRACE). A global
/// atomic rather than subscriber state so repeated `initConsoleTracing`
/// calls can CHANGE the level: `set_global_default` only succeeds once, and
/// a level baked into the installed subscriber would silently pin the first
/// call's choice forever.
static MAX_LEVEL: AtomicUsize = AtomicUsize::new(2); // info

fn level_rank(level: &tracing::Level) -> usize {
    match *level {
        tracing::Level::ERROR => 0,
        tracing::Level::WARN => 1,
        tracing::Level::INFO => 2,
        tracing::Level::DEBUG => 3,
        tracing::Level::TRACE => 4,
    }
}

struct ConsoleSubscriber;

struct FieldFormatter {
    out: String,
}

impl tracing::field::Visit for FieldFormatter {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            // message first, unlabelled
            let msg = format!("{value:?}");
            let msg = msg.trim_matches('"');
            if self.out.is_empty() {
                self.out.push_str(msg);
            } else {
                let _ = write!(self.out, " {msg}");
            }
        } else {
            let _ = write!(self.out, " {}={:?}", field.name(), value);
        }
    }
}

impl tracing::Subscriber for ConsoleSubscriber {
    fn enabled(&self, metadata: &tracing::Metadata<'_>) -> bool {
        level_rank(metadata.level()) <= MAX_LEVEL.load(Ordering::Relaxed)
    }

    fn new_span(&self, _span: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        // Spans are accepted (so span-gated events fire) but not tracked.
        tracing::span::Id::from_u64(1)
    }

    fn record(&self, _span: &tracing::span::Id, _values: &tracing::span::Record<'_>) {}

    fn record_follows_from(&self, _span: &tracing::span::Id, _follows: &tracing::span::Id) {}

    fn event(&self, event: &tracing::Event<'_>) {
        let mut fmt = FieldFormatter { out: String::new() };
        event.record(&mut fmt);
        let line = format!("[{}] {}", event.metadata().target(), fmt.out);
        let js = JsValue::from_str(&line);
        match *event.metadata().level() {
            tracing::Level::ERROR => web_sys::console::error_1(&js),
            tracing::Level::WARN => web_sys::console::warn_1(&js),
            tracing::Level::INFO => web_sys::console::info_1(&js),
            _ => web_sys::console::debug_1(&js),
        }
    }

    fn enter(&self, _span: &tracing::span::Id) {}

    fn exit(&self, _span: &tracing::span::Id) {}
}

/// Install the console-forwarding tracing subscriber (idempotent). `level` is
/// the maximum verbosity: `"error" | "warn" | "info" | "debug" | "trace"`;
/// anything else defaults to `"info"`. There is no `RUST_LOG` in the browser,
/// so the level rides this call.
#[wasm_bindgen(js_name = initConsoleTracing)]
pub fn init_console_tracing(level: String) {
    let rank = match level.as_str() {
        "error" => 0,
        "warn" => 1,
        "debug" => 3,
        "trace" => 4,
        _ => 2, // info
    };
    // The level lives in a global atomic, so a REPEATED init call updates
    // verbosity even though set_global_default only installs once.
    MAX_LEVEL.store(rank, Ordering::Relaxed);
    let _ = tracing::subscriber::set_global_default(ConsoleSubscriber);
}
