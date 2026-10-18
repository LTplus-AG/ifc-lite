<!-- SPDX-License-Identifier: MPL-2.0 -->
# Authored planning and execution-boundary receipts

These receipts extend the [foundation receipts](../geometry-platform-foundation/)
without rewriting them. The source manifest identifies the uncommitted candidate;
this is integration evidence, not production activation or complete IFC coverage.

The real browser runner is `native/smlib-adapter/browser/test.html`, served from the
Emscripten build directory. `browser.json` records actual Chromium execution using
two independent module workers, ownership/epoch checks and kernel-derived mesh
invariants. Fault fixtures run a synchronous infinite loop or initialize against
a nonexistent WASM asset. Both must fail within one second, remain unavailable
until explicit restart, and then pass the real kernel contract. Missing assets
were served as an HTML error document by this development server; the recorded
WebAssembly compile failure is expected. No COOP/COEP isolation was required.

Native supervision tests use the real executable for geometry and a deterministic
partial-protocol peer for blocking-I/O faults. They verify queued deadlines,
cancellation without a waiter, backpressure, restart affinity and Linux process
reaping. This does not prove OS memory limits, process-pool scheduling or automatic
model replay. The workflow runs all runtime tests, plus native and Node CTests;
actual browser runner execution is recorded here and is not yet a CI job.

Authored-source tests preserve existing extrusion/swept-disk definitions and
mapping/unit contracts. The real ArchiCAD FZK consumer emits a JSON plan; its
summary records counts and a digest rather than committing model-derived output.
All products retain unverified full-representation coverage. This layer does not
yet lower the complete operation DAG or evaluate IFC products through SMLib.

`validation.json` records commands, outcomes and log digests. Default-path
performance checks compare the separate base checkout against this candidate
using the whole-worker-pool probe. Timing remains a shared-host diagnostic;
ordered output hashes and counts establish preservation for those two fixtures,
not a latency, retained-memory or SMLib performance improvement.
