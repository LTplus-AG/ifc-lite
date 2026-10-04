# Canonical symbolic parse outcome correctness (#6537)

This packet preserves the finite lifecycle qualification of a viewer-private passive observer at base `8570465acd2f68ef9b6f6e180d86af4636f52454`. It distinguishes actual dispatch failure from genuine successful empty, preserves the existing empty-on-failure drawing projection, and refuses incomplete, stale or overbudget observations.

Current weak-token v3 source passed 52 root Turbo cases: 18 new lifecycle controls and 34 existing cache/dispatch controls. Plain root `pnpm typecheck` passed, including its 3365/3365-test-file audit across 57 packages. Scoped denied-warning lint, module size, wiring, source-assert, license, syntax and diff gates passed. The root test graph necessarily built the viewer; `WASM_BUILD_MODE=fetch` fetched its prerequisite WASM. There was no Rust compilation or browser/model/performance run.

The finite inverse changed only null-dispatch classification from failure to success; the empty flat and assertions stayed unchanged. All 18 new controls ran: 11 passed and seven raised genuine `ERR_ASSERTION` failures, each observing success instead of failure. No skips, cancellations or module/load failures occurred. Guaranteed `finally` restoration returned all nine paths byte-exact to frozen v3. The same uncached viewer test task then passed all 18. This demonstrates sensitivity to false-success classification, not real IFC/WASM parser correctness.

Historical evidence remains distinct and verbatim: v1's source-only tests were unrun and its source-text gate refused missing dependencies; the initial real v2 suite passed 50/52 with a callback import-depth error and a bucket fixture missing elevations. Correcting those fixture inputs preserved strict assertions and production source. V2 green evidence retained strong binding references; v3 replaces these with weak identity tokens. The original v2 packet's inherited `totalSourceBytes: 76470` is inaccurate; its authoritative member manifest sums to 77365. No historical packet was rewritten.

`manifest.json` pins each original member's byte count/hash and the deterministic gzip archive. `replay.py` safely extracts into a private temporary directory, verifies all original bytes, and replays the decisive raw counts, assertions, source identities and audit receipts:

```sh
python3 scripts/perf/evidence/symbolic-parse-outcomes-6537/replay.py
```

The held Worker seam drives real dispatch/cache/bucketer/store/page-consumer paths. It does not run a real WASM parser or establish authored IFC semantics, text fidelity, glyph uploads, atlas readiness, submitted frames, GPU appearance, pixels or a performance benefit. The observer never initiates parsing/rendering, walks authored data on passive reads, intercepts writes, or changes the timed comparator/authored-text guard. Completion is bounded producer evidence, not complete IFC semantic identity. Archived resources are correctness-admission receipts, not measurement samples.
