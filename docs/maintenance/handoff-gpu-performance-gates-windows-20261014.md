<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Windows continuation: performance gates

The user explicitly requested moving execution from the Mac to the Windows perf PC because cross-machine browser routing was inefficient. Continue the same work; this is not a new audit or competing implementation. The user authorizes useful parallel agents, proven DRY fixes, browser verification, PR creation/shepherding, and admin merge **only when truly ready**. Preserve other sessions' work, all strict admission rules, and the original evidence. Do not close these issues on partial implementation.

## Claims and source

Session `gpu-performance-gates` claimed ready issues #6993, #7036 and #6975, with assignee louistrue and label `claimed:session-gpu-performance-gates`. The previous owner explicitly retired. Recheck live ownership before modifying anything; comment that this is the user-authorized Windows continuation of that claim.

- Main pinned for preparation: `f128e821d719b949b598fe325248d11fde861c62`.
- PR #7601, branch `t3code/gpu-performance-gates`, head `ad562fba084ab6cc9d20b5953ee695ffe091f4ec`: frame-evidence admission prerequisite for #6975. Ready for review, **not merge ready**.
- Existing draft #7474: `db4f478aa6c56181332b2f06e0a4aab1c4f17309`, base main.
- Existing draft #7475: `25c90e43d626e1c5cacfeeba32062b18ea363bd0`, based on #7474's branch. Both default off. Original heads preserved under `backup/session-gpu-performance-gates/7474-before-refresh-20261014` and `/7475-before-refresh-20261014`.
- Useful unfinished oracle correction: branch `backup/session-t3code-7195d1eb/6975-oracle-windows-handoff`, commit `7678ed3f7bbe34fc2cf40e0f05bc803e487095fb`. Its parent contains the patch-equivalent #7601 admission source; cherry-pick **only 7678ed3** onto #7601 after inspecting the delta. Do not merge the entire backup ancestry.

Register all three PR URLs with the new Windows thread using `link_pull_request`, then verify `list_thread_pull_requests` before finishing.

## First action: finish #7601 properly

The old deterministic workflow accepted any six fixture/scenario groups, even with only one metric each. The candidate validates all 96 metric rows and canonical load readiness, reuses shared GPU-health classification, retains failed evidence and refuses device-loss/replacement/page-error contamination. Qualification happens after measured windows; schema 2 is a separate traced cohort. No ceiling or throughput claim.

Qualified exact-head evidence for ad562:

- Actual [browser frames run 38620031605](https://github.com/LTplus-AG/ifc-lite/actions/runs/38620031605) **SUCCESS**, both FZK and Snowdon, 96 rows, canonical completion, one device each, zero losses/replacements/page errors. Downloaded artifact also passes the actual validator CLI.
- Root full serial `pnpm typecheck`, including tail audit and frame-script programme, passed. Root `pnpm lint`, test-wiring, module-size and source-text assertions passed.
- Fourteen behavioral/CLI controls pass. Bypassing the actual validator gives 12 failures; exact restoration gives 14 passes. This inverse is local evidence, not a hardware result.
- Independent source review addressed page-creation cleanup and readiness concerns. Exact-head Claude review [comment 6176354652](https://github.com/LTplus-AG/ifc-lite/pull/7601#issuecomment-6176354652) is CLEAN; inspect actual review threads and current statuses yourself.

Blocking original Test run [38620025888](https://github.com/LTplus-AG/ifc-lite/actions/runs/38620025888): `Changed tests observe production` job 116050510218 reports INCONCLUSIVE. Its browser observer hardcodes `test:e2e:ci`, which selects no tests from the changed frame spec. This is not a product assertion failure and cannot be ignored.

The unpublished-to-PR correction at 7678ed3 supports the existing registered `test:benchmark:frames` observer using actual `--list` attribution, provisions headless-shell for that spec, and follows the existing guarded initial-module mutation pattern so deleting the new CLI does not turn the inverse into a module-load failure. Ten focused controls pass, including real listing of two frame tests and refusal of an unknown spec; mutation reverse-apply check passes. **Full oracle execution, hosted provisioning, full checks and substantive review of this correction remain unqualified.** Inspect the existing pattern and do not weaken/exempt the gate. Keep production modules under 400 lines.

Finish and validate that correction, update #7601, run current-head full CI and the actual deterministic workflow, answer all review findings, then merge only if genuinely ready. Avoid editing PR bodies while original full CI is active; comments hold later evidence. Existing source change makes no public package API change and needs no changeset.

## Windows workspace and runtime already prepared

`/tmp/ifc-lite-gpu-performance-gates-7195` is an isolated detached WSL worktree at ad562 with frozen dependencies installed. It has the copied production viewer, source-built WASM and catalogue FZK/Snowdon fixtures. Its tracked status was clean after extraction.

- Runtime archive: `/tmp/ifc-gpu-gates-runtime-7195.tar.gz`, SHA256 `3077bb4bbb367b1aac3be24db107c26f0dfe08f8326300799a7eb429b219b392`.
- WASM: `40cffea58f313ab8777fc36bf00f0b90e9aa253d0103dad2e8b96573db05c7e2`, built through `scripts/build-wasm.sh` from pinned Rust sources. Production source is unchanged between f128 and ad562.
- Windows preparation log: `/tmp/ifc-lite-gpu-performance-gates-7195-prepare.log`.
- Native attempt log: `/tmp/ifc-lite-gpu-performance-gates-7195-native.log`.
- Native raw results: `/tmp/ifc-lite-gpu-performance-gates-7195-native/`.

The actual native command used the existing frame rig with one FZK sample, `--require-gpu-timing --require-physical-display --require-host-idle`, under `/tmp/ifclite-perf.lock`. At 19:16 UTC it **refused before Chrome launch**: other Rust/TypeScript/WASM graphs were active, Windows CPU readings were 72/62/70 percent against a 10-percent ceiling. No model or native GPU sample ran; zero qualifying nights. Preserve that receipt, do not relax guards or stop foreign jobs. A free flock alone does not mean an idle host. Establish a finite quiet window before another attempt.

The Mac's T3 preview first attached to Windows, then repeatedly reported macOS despite Windows being foregrounded. A single Mac FZK load completed with native Apple Metal and real counters, but it is only diagnostic and does not satisfy the requested Windows cohort. Do not relabel it. Temporary Mac servers/tunnels are being stopped; the Windows worktree and archive are self-contained.

## Remaining issue acceptance

### #6993

Implementation is already on main, including #7548. No new accounting defect was found. Complete two fresh Windows-native FZK and two Snowdon loads through the canonical viewer input with exact source/runtime/fixture hashes and actual console/trace witnesses. Fixed cohort: `?perfTrace=1&geomWorkers=4&meshCache=0&perf.benchmarkUploads=1&perf.batchSizing=%7B%22targetMs%22%3A8000%2C%22minJobs%22%3A64%2C%22maxJobs%22%3A64%7D`.

Require parser (or canonical cache) completion, geometry stream completion, ended root and scene.finalize. Compare settled GPU allocation/static-upload and sender transfer vectors, plus real select/hover/Lens commit deltas. Reuse `tests/benchmark/interaction-commits.ts`; mutable write totals and per-load commits are scheduling-dependent. Keep forced recovery qualification separate from healthy counts/timing. The folded external-instance/device-loss scope remains a closure hold; healthy hardware does not prove Chromium's cause.

### #7036

The existing stack integrated onto f128, with only a README conflict preserving both docs. Geometry/parser/load-trace tests passed 2,557 with 11 fixture-dependent skips. Full serial root typecheck passed 126 tasks and audited 4,139 test files. This is CPU integration evidence, not native pool acceptance. Lower fresh Test run is 38622720829; upper review-signal run is 38622721397. The upper lacks full Test lanes while based on the lower; retarget to main only after lower is accepted.

Still prove canonical 1/N model behavior with both flags, repeat/replacement/federation, ordered flat and instanced output identity, actual retained-worker reuse/disposal, crash/abort/resource retries, actual idle/peak/resident memory and interleaved real-GPU four-fixture A/B. Eligible warm loads must create/init zero workers; threshold-retired large heaps deliberately do not reuse. Booked WASM bytes are not resident memory. Reuse existing invariants rather than writing another oracle. Keep drafts default off until complete.

### #6975

Timestamp integration and calendar/profile controls are already present. Preserved native-night source is at `backup/session-0d879cc0/6975-native-night-source-596`, e0e2183, but is an unfinished 43-file snapshot, not a ready PR. Seven consecutive genuine future admitted physical-GPU nights are mandatory before calibrating an alert threshold. No such nights have completed. Do not backfill, count same-day reruns as nights, or import fabricated calendar rows.

Historical deterministic artifacts varied enough that no honest ceiling was seeded. After admission is robust, establish same-build repeatability and wire only supported metrics into `browser-frames` compare/lower. Orbit adaptive draw/render counts stay informational. Record actual measured verdicts in the performance ledger; do not claim a speedup from worker readiness or counters alone.
