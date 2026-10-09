# Canonical capture render refusal (#6709 / #6711)

Checked source: `6a2e61b5bf2c3048283d2f4bdd585f402108ef3e`.
Baseline: `54fe4908e88eb7d37937535e504fbe3f47d5de6d`.
Main `29a1648b3ea56a346012b65ab3b7e41ecd598e8f` was merged normally.
The baseline adds the same controls to the published capture implementation;
its renderer and capture gateway retain the production behavior reviewed at
`a0df20fc0cb00098cbc9d9266659223fd4d02468`.

The [review finding](https://github.com/LTplus-AG/ifc-lite/pull/6711#issuecomment-6084670397)
identified that `Renderer.render()` contains skipped frames and synchronous
failures, so returning without throwing does not prove a new frame submitted.
The capture gateway nevertheless waited and read the canvas. The additive
`renderWithResult()` now reports submission through the original canonical
render body; `render()` retains its void API. A false result prevents camera
metadata, completion waits, presentation and readback. Existing lease cleanup,
options, preferences and renderer containment policy remain shared.

These controls run the actual mounted animation loop, BCF/capture/report paths
and canonical Renderer command encoding through `queue.submit`. GPU interfaces
are controlled, completion is deferred explicitly and rAF is controlled.
Canvas readback is a JSON observation sentinel, not a physical GPU PNG.
No timings in this archive are performance acceptance.

Actual root Turbo runs, under reservation `3b6a17dd-6965-4a8d-9c37-f0b58c87edf2`:

- Baseline: 23 tests, two positive controls pass, 21 assertions fail. All 20
  seeded refusal controls at DPR2/DPR1 read the old submission after no new
  submission; the queued recovery assertion also fails. The two positives
  seed a canonical submission and prove deferred completion ordering.
- Corrected: all 188 affected viewer tests pass; renderer has 2,058 passes and
  two existing optional fixture skips. All 20 refusals have zero reads and
  completion waits; camera metadata is also unreachable. Both DPR positives,
  queued recovery and the original six capture controls pass. The latter's
  assertion file is unchanged and now uses the fuller GPU-interface fixture.
- Full root `pnpm typecheck`: 119 Turbo tasks and 3,866 test files in 62 packages
  pass, including both root postchecks. A supported execution-only Turbo
  concurrency setting is archived and restored in `finally`.
- Module size, source-text assertions, frame waits, test wiring, API check and
  refresh, root lint and all three documentation checks pass. API refresh
  produces no snapshot change. The renderer minor changeset and guide cover
  the new class method.

The first baseline attempt did not request its idle seed frame. Twenty cases
failed their seed precondition; it is preserved as **invalid refusal evidence**.
A test-only canonical `requestRender()` correction precedes both accepted arms.
The original failed run, classification and correction are retained.

Published-head hosted CI at `a0df20fc` failed on the ribbon screenshot test,
whose canvas-only fixture omitted viewport registration, and two unrelated
group-test timeouts. The corrected ribbon test uses the shared UI capture
boundary, controlled presentation and the download event, preserving its PNG
and telemetry assertions. The normal main merge includes upstream #7367's
group-test correction; this lane makes no unrelated timeout edits. Hosted
viewer shards 4 and 6 were cancelled. Fresh final-head CI remains required.

[`archive-index.json`](./archive-index.json) records original and compressed
bytes and SHA-256 hashes. Every gzip entry was decompressed and verified.
`raw/` contains commands, actual logs, summaries, source/runtime pins, the
review receipt and explicit cleanup/release; `hosted-ci/` contains the observed
failed jobs and diagnosis. No owned process remained at release. No browser,
server or physical GPU cohort started, and no process was killed.

Physical GPU rasterization, HiDPI navigation/capture quality, CSS picking,
transition costs and idle interleaved base/head performance remain unverified.
The earlier primary-model CPU equivalence archive remains qualified to its
original heads and scope. It was not rerun and provides no GPU/performance
proof. The PR remains draft for fresh CI and the campaign root's final review.
