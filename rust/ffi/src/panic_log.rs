// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The panic log: a process-wide hook that appends the in-flight IFC paths,
//! the panic message and a backtrace to `%TEMP%/ifc_lite_panic.log`.

use std::backtrace::Backtrace;
use std::io::Write;
use std::sync::{Mutex, Once};

/// Paths of the IFC files whose parses are in flight, so the panic hook can
/// name the offending file. Process-wide, not thread-local: the parse runs on
/// pool workers and the hook runs on whichever one panicked. Registered for
/// the call's duration by [`InFlightPath`]; with parses from several host
/// threads at once every in-flight path is listed, since the shared pool may
/// be running any of their jobs on the panicking worker. The hook, not the
/// `catch_unwind` site, reads it because a `panic = "abort"` build never
/// reaches the catch site.
static IN_FLIGHT_PATHS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// RAII registration of one parse's path in [`IN_FLIGHT_PATHS`]. Dropping it,
/// including during the unwind of a caught panic, removes the entry again.
pub(crate) struct InFlightPath(String);

impl InFlightPath {
    pub(crate) fn register(path: &str) -> Self {
        let path = path.to_string();
        IN_FLIGHT_PATHS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(path.clone());
        Self(path)
    }
}

impl Drop for InFlightPath {
    fn drop(&mut self) {
        let mut paths = IN_FLIGHT_PATHS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(i) = paths.iter().position(|p| *p == self.0) {
            paths.remove(i);
        }
    }
}

/// The in-flight paths joined for the panic log, or `<unknown>` when nothing
/// is registered. A blocking `lock` is safe in the hook: holders only push,
/// remove or join, none of which panics.
pub(crate) fn in_flight_paths_for_log() -> String {
    let paths = IN_FLIGHT_PATHS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if paths.is_empty() {
        "<unknown>".to_string()
    } else {
        paths.join(", ")
    }
}

static PANIC_HOOK_INIT: Once = Once::new();

/// Installs a process-wide panic hook exactly once.
///
/// The hook appends the IFC path being parsed, the panic message/location and a
/// captured backtrace to `%TEMP%/ifc_lite_panic.log`, then chains to the previous
/// hook (preserving the default stderr output). Panic hooks run *before* the runtime
/// unwinds or aborts, so this leaves a breadcrumb identifying the file even in a
/// `panic = "abort"` build where `catch_unwind` cannot recover.
pub(crate) fn ensure_panic_logging() {
    PANIC_HOOK_INIT.call_once(|| {
        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let path = in_flight_paths_for_log();
            let backtrace = Backtrace::force_capture();
            let log_path = std::env::temp_dir().join("ifc_lite_panic.log");
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
            {
                let _ = writeln!(
                    file,
                    "==== ifc-lite panic ====\nfile: {path}\n{info}\nbacktrace:\n{backtrace}\n",
                );
            }

            previous_hook(info);
        }));
    });
}
