// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Self-check for the panic strategy this binary was actually built with.
//!
//! `CatchPanicLayer` (see `build_router`) only contains a malformed-IFC panic
//! to the offending request if the build unwinds. Under
//! `[profile.release] panic = 'abort'` the panic is a process abort: the layer
//! never runs, `spawn_blocking` never turns it into a `JoinError`, and every
//! other tenant's in-flight request dies with the process. That precondition
//! is a property of the ARTEFACT, so the release pipeline asserts it against
//! the artefact (`--panic-strategy-selftest`, wired in
//! `.github/workflows/server-binaries.yml`) rather than against the flags that
//! were meant to produce it.

/// Argument that runs the self-check instead of starting the server.
pub const SELFTEST_FLAG: &str = "--panic-strategy-selftest";

/// Line printed by the self-check when the binary unwinds.
pub const UNWIND_VERDICT: &str = "panic-strategy: unwind";

/// Whether a panic in this binary unwinds (`true`) rather than aborting.
///
/// There is no `false` in a built binary: under `panic = "abort"` the panic
/// below kills the process with `SIGABRT` and this never returns. That is what
/// makes it a usable CI assertion: the two observable outcomes are
/// [`UNWIND_VERDICT`] on stdout and a dead process. The `false` arm exists so
/// the function is total. The deliberate panic's message reaches stderr,
/// named as the self-check so it cannot be read as a crash; that is the whole
/// cost of not touching the process-global panic hook here.
///
/// Not unit-tested: `cargo test` builds with the `test` profile, which
/// unwinds, so an in-process assertion could only ever say "true" and the
/// abort direction takes the harness with it. The "Assert the built binary
/// unwinds" step in `.github/workflows/server-binaries.yml` is the test.
pub fn panic_unwinds() -> bool {
    std::panic::catch_unwind(|| {
        panic!("{SELFTEST_FLAG}: deliberate panic, this is the self-check, not a crash");
    })
    .is_err()
}
