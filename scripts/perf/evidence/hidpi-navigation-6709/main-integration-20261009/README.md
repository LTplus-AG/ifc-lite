<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Current-main capture qualification (#6709 / #6711)

Checked source: `39214f80e0f21925f46fb8b1779c7f22d9b41f32`. Its merge
parents are published `539e00dee57e10603d1676d821b8842548175ff5` and main
`cae06a94985fd31dd9ab2c9a5b61cd4bb723ba8e` (merged #7361). The integration
was a normal conflict-free merge. Capture, canonical render options,
animation loop and renderer production code are unchanged from the reviewed
capture-refusal implementation. The following archival commit changes evidence
only; it is not another implementation revision.

The previous hosted failure was the #7139 independent-federation
classification assertion. Current main supplies the canonical optional-Cost
admission correction; this lane did not change an unrelated assertion,
transport limit, timeout or exporter. The original federation assertion and
all six new #7360 cost-envelope controls pass in the actual root Turbo run.

Under reservation `1a44d59b-d73c-4ec5-872f-b2771956b46c`, after #7109's
explicit cleanup/release, validation ran serially with two CPU cores, a 6 GiB
Node heap and one Rust build job:

- Root `pnpm test --filter=@ifc-lite/viewer --filter=@ifc-lite/renderer
  --concurrency=1 --env-mode=loose`: 55 Turbo tasks passed. The affected viewer
  run had 204 tests, 203 passes, no failures and one absent-Revit-fixture skip.
  The Haus fixture was present and catalog-hash verified, so the original
  federation failure and native Cost controls actually executed.
- The 3,954-byte catalogued Revit fixture was then copied from an existing
  campaign checkout without changing the source copy. A root Turbo rerun of
  only `selection-classifications` passed all 10 tests with no skips, including
  the previously skipped control. The original skip remains in the first log.
- Renderer: 2,060 tests, 2,058 passes, no failures and two retained skips:
  opt-in >2^24-vertex memoization (~340 MB), and WGSL origin readback requiring
  a real WebGPU adapter unavailable in Node.
- Full root `pnpm typecheck`: 119 Turbo tasks and all 3,867 test files across
  62 packages, including the audit and frames compiler postchecks. Its supported
  execution-only Turbo concurrency setting was restored byte-for-byte.
- All nine source/API/lint/documentation gates passed. Root lint reports
  9,887 files covered with zero errors; existing unrelated warnings remain.

The canonical capture controls retain DPR2/DPR1, actual renderer encoding
through controlled GPU interfaces, seeded old-frame refusals, deferred queue
completion, controlled rAF, BCF metadata pairing and overlapping exports.
They prove controlled integration and submission/refusal ordering. Readback
uses a JSON observation sentinel; these runs do not establish physical GPU
rasterization, PNG quality, CSS picking or performance. Their durations are
test execution timings, not a frame-rate verdict.

Cleanup/release was recorded at `2026-10-09T20:25:51.997638+00:00`: all owned
stages terminal, all seven sampled process identities absent, no remaining
checkout processes, no browser or server started, nothing killed or deleted.
Only the matching lock was removed; #7369's setup remains next. Existing
candidate, fixtures and prior evidence were preserved.

`manifest.json` records stored/raw lengths and SHA-256 for all 36 gzip entries.
Every entry was decompressed and verified. They include actual command logs,
the initial fixture skip and successful targeted followup, source/runtime and
fixture pins, exact typecheck configs, gate results and cleanup/release receipts.
Earlier capture-refusal and primary-model CPU-equivalence archives retain
their original measured heads and qualified scope; CPU equivalence was not
rerun here and supplies no GPU/performance proof.

Fresh hosted CI for the newly published head must be assessed separately.
Native-GPU interleaved navigation including transition frames, DPR1 control,
unchanged loaded geometry and CSS picking, restored idle/capture dimensions,
and idle base/head performance remain outstanding. The campaign root owns
final integration review and merge; #6516 loading-regression resolution is
not established by this lane.
