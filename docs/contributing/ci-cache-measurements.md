# CI cache and viewer balancing measurements

This records the bounded follow-up to [#10279](https://github.com/LTplus-AG/ifc-lite/issues/10279).
CI step durations below are wall time, not CPU time or billing-weighted minutes.

## Decisions

- The native Linux server PR lane uses the host standard library (#10365).
  Cross builds and release archives retain their existing configuration.
  The `server-release` unwind profile and binary panic assertion remain required.
- Generated `tsconfig.tests.json` files no longer invalidate production Turbo
  build keys (#10407). The actual Turbo regression still requires production
  source/configuration changes to invalidate the key.
- Viewer tests use 14 duration-packed shards with two-way file concurrency
  enabled by `VIEWER_TEST_CONCURRENCY`. #10399 refreshed the existing duration
  manifest when the job still used 16 shards. Both layouts cover the full suite.
- Retained Rust uses one Cargo archive owner for the native and WASM target
  tree, rather than restoring/saving the same paths twice. The setup action
  already installs the required Rust toolchain and exposes its exact cache hit.
  Keep the existing `rust-retained-runtime` namespace (the larger restored
  archive) to reuse compatible objects instead of forcing an empty cache.
  No time saving is asserted for this correction.
- Keep retained, default, no-default-feature, each CSG gate, combined gates,
  and native/browser coverage distinct. CSG still cleans only geometry artifacts
  between test legs to bound disk; compatible dependency objects stay available.
  Do not broaden cache sharing across incompatible flags, profiles or targets.

## Actual viewer follow-up

The successful full queue qualification for #10399 was
[run 43755900013](https://github.com/LTplus-AG/ifc-lite/actions/runs/43755900013)
(the batch PR was #10459). All 16 viewer shards passed without the retry step.
The following values come from each job's initial
`Run pnpm --filter @ifc-lite/viewer run test` step timestamps:

| Run | Manifest | Minimum step (s) | Maximum step (s) | Sum of 16 steps (s) |
| --- | --- | ---: | ---: | ---: |
| [43619533838](https://github.com/LTplus-AG/ifc-lite/actions/runs/43619533838) | Before refresh | 524 | 1006 | 12308 |
| [43596705777](https://github.com/LTplus-AG/ifc-lite/actions/runs/43596705777) | Before refresh | 613 | 1125 | 13540 |
| [43755900013](https://github.com/LTplus-AG/ifc-lite/actions/runs/43755900013) | Refreshed | 585 | 1041 | 13467 |

The observed maximum falls inside the earlier range; the historical packing
prediction did not establish an equivalent improvement on fresh CI. Source,
runner load, caches and batch contents differ. This is not a controlled A/B
measurement and supports no percentage saving. Refresh the weights for both
modes when file durations drift:

- For concurrency 2, use two or three successful full runs while their
  `viewer-file-timings-N` artifacts are available. Pass each run with
  `--concurrent-run`. The refresher validates full, exact file coverage and
  takes median whole-file durations across the supplied runs.
- For serial weights, run two or three successful full runs with
  `VIEWER_TEST_CONCURRENCY` unset. Submit them in a maintenance window and
  restore the variable after they finish. Pass each serial run with `--run`
  to refresh the TAP-derived weights.

Both sets of flags can be supplied to the same
`node scripts/refresh-viewer-test-durations.mjs` command, and `--dry-run`
previews what it would use. Refreshing one mode preserves the other mode's
weights for files still present.

If viewer concurrency 2 needs to be rolled back, unset
`VIEWER_TEST_CONCURRENCY`. This switches the 14 viewer jobs to serial
execution and raises their caps from 25 to 35 minutes. To restore the previous
runner layout, also restore the 16-job matrix, both `TEST_SHARDS` settings and
the manifest count in the same change. PR review signal and the dirty-PR scanner
derive their expected check names from a literal matrix list. Post-merge replay runs
that skip all shards provide no balancing evidence.

Reproduce the inventory with
`gh api repos/LTplus-AG/ifc-lite/actions/runs/RUN/jobs?per_page=100 --paginate`,
selecting successful `Viewer tests (shard N)` jobs and the exact step above.
Subtract `started_at` from `completed_at`; exclude setup, retries and post steps.

The move from 16 to 12 shards followed four successful hosted queue runs on
2026-11-25 and 2026-11-26 with `VIEWER_TEST_CONCURRENCY=2`. The old layout
used 145–167 summed test-step minutes. Scaling the serial file weights to
each observed shard's wall time and replaying duration packing projected
slowest steps of 15.8 minutes for 10 shards, 14.2 for 11 and 13.1 for 12.
These estimates use shard-level wall times because concurrent TAP output
is buffered. The viewer jobs report the number of files completed alongside
the step durations for direct comparison on a full run. The first 12-shard
run passed all 3,081 files and took 10.0–15.9 minutes per shard. The
second 12-shard run used shard-calibrated weights and still reached 15.7
minutes. It published whole-file timings for all 3,081 files. The 14-shard
layout packs these measured timings after normalizing each source shard
against historical test-body timings for the same files. Serial execution
uses the serial weights. Full viewer runs publish file-level durations in
`viewer-file-timings-N` for future repacking.

## Rust measurements

The original sampled retained jobs restored both archives successfully. The
`ci-rust-retained` archive was 2,192 bytes and `rust-retained-runtime` was
585,140,119 bytes. Their CLI build/report steps took 697/668 seconds; their
combined Rust test/Clippy steps took 653/609 seconds. Compilation appeared after
restore, but these mixed steps cannot establish how much time was execution or
whether dependency objects were reusable. An archive hit is not a compiled
artifact hit. These observations are documented in the issue's
[cache assessment](https://github.com/LTplus-AG/ifc-lite/issues/10279#issuecomment-6893603341).

The retained and CSG jobs now invoke `scripts/ci-rust-metrics.mjs` and publish
`rust-ci-metrics-JOB-ATTEMPT` JSONL artifacts for 14 days, plus job summaries.
The CSG matrix includes the gate in each artifact name
(`rust-ci-metrics-csg-accept-gates-GATE-ATTEMPT`).
Each row records source SHA, run, attempt, job, full command, phase, elapsed
seconds, exit status and exact archive hit (`true`/`false`), `warm-target` or
`unknown`. Cargo compilation and Clippy rows also count `compiler-artifact`
messages with `fresh: true` versus rebuilt artifacts. The ratio is artifact
count weighted, not byte or time weighted; it does not mean sccache hits.
Cargo's [documented JSON protocol](https://doc.rust-lang.org/cargo/reference/external-tools.html)
is the source of these counts.

For `cargo test`, compilation uses the same arguments plus `--no-run`; only after
success does the original Cargo test command run. The second phase deliberately
includes Cargo's warm freshness check and doctest compilation/execution. It is
labelled `execute-with-cargo-and-doctests`, never pure test execution. Cargo keeps
control of test discovery, filters, runners, examples and doctests. Clippy keeps
its own phase and `-D warnings`. Browser boundary, WASM build, root CLI build and
CLI report commands have separately labelled `command-total` rows; their nested
compilation is not misrepresented as pure test time. Failures remain failures;
JSONL is uploaded even on failure.

Use full successful qualifications, not replay-only runs, to compare the same
feature commands. Inspect compile seconds and artifact reuse separately from
execution seconds and archive restore/save steps. Compare exact and fallback
restores, and later warm qualifications, before claiming any cache saving. Further
sharing is justified only by compatible artifact reuse and end-to-end results,
without deleting any feature configuration or acceptance test.

The real, dependency-free Cargo regression exercises cold/warm freshness,
single/combined features, no-default-features, filtering, doctests, compiler
errors, test failures and Clippy. It explicitly skips when Cargo is absent;
that skip does not qualify the Rust telemetry. Run it with the pinned toolchain:
`node --test scripts/ci-rust-metrics.test.mjs`.

## First production retained telemetry

[Run 43829144636](https://github.com/LTplus-AG/ifc-lite/actions/runs/43829144636/job/133170363605)
passed the retained job on merge source `637cc88439731b074ef7cf75d6afe082e8283382`
(PR head `d771ec359`). Its `rust-ci-metrics-rust-retained-1` artifact contains
25 successful rows covering all 13 native Cargo commands and four boundary,
WASM-build, CLI-build and CLI-report commands. The single Cargo archive restore
reported an exact hit. Totals from the JSONL, rounded only for presentation:

| Phase | Rows | Seconds | Fresh artifacts | Rebuilt artifacts |
| --- | ---: | ---: | ---: | ---: |
| Native test compilation | 8 | 542.07 | 885 | 264 |
| Cargo execution including doctests | 8 | 150.64 | — | — |
| Clippy | 5 | 160.05 | 579 | 439 |
| Boundary/build/report totals | 4 | 1025.25 | — | — |

Artifact counts across invocations are not unique crate counts. The first
retained geometry test compilation reused 109 artifacts and rebuilt 188; later
processing test compilations reused 97/101 and 100/111 artifacts respectively.
The first geometry execution/doctest phase took 124.84 seconds, versus 321.43
seconds for its compilation. The mixed build/report work splits into browser
boundary 117.67 seconds, WASM build 484.08, root CLI build 421.38 and CLI report
2.11. Thus the earlier combined step was not a measure of test execution.

The archive is useful, but an exact archive hit does not imply every feature's
workspace and test binaries are reusable. Keep compatible dependency objects in
the existing tree and retain each feature configuration; these results do not
justify combining them or assuming that another archive prefix removes linking
and feature compilation. The original two runs lack this phase breakdown and
used different sources/runners, so this is neither an A/B speedup claim nor
proof of a regression. CSG qualification remains a separate required assessment;
this PR's ordinary full run correctly skipped that queue-only lane.
