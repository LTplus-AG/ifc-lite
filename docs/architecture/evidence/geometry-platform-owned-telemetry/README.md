<!-- SPDX-License-Identifier: MPL-2.0 -->
# Owned route telemetry and root unwind evidence

Status: implemented, **uncompiled and unrun**. Eight source files parse with the
pinned formatter in stdout-only mode. No heavy validation was submitted while
the fleet disk guard refused admission. Source hashes and parse results are in
`source-and-syntax.json`; they do not prove Rust types or executed behavior.

Detached route telemetry now owns a vector of scalar events instead of boxed
callbacks. The four existing production record sites retain their original
counter increments, order, Relaxed atomics and feature conditions. Nested commit
still appends into the current parent transaction; discard and unwind drop only
the current buffer. The lexical transaction remains thread-bound. The detached
event vector contains no TLS guard, source, router or callback.

The new isolated telemetry invariant checks nested acceptance and discard,
original panic propagation, immediate publication after unwind, actual event
handoff from another thread and feature-enabled prism counter values. It also
requires the detached type to satisfy Send and Sync. This does not make ordinary
source/extension capabilities transferable or establish a public migration API.

A separate real capped-kernel root-unwind regression checks that the lexical
failure guard drains actual failures before the ordinary finalizer, then the
production acceptance path resumes the identical panic payload and publishes
attributed evidence once. The actual mixed staged-child rejection witness is
still open: it must positively establish a real residual failure in that
production route, rather than construct a disposable child by hand.

All new assertions remain unrun. Performance, allocation traffic and memory are
unqualified; removing a boxed representation is not an end-to-end measurement.
