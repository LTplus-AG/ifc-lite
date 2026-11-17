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
- Viewer tests retain 16 isolated shards and their complete inventory. #10399
  refreshed the existing LPT duration manifest; no second selector was added.
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
measurement and supports no percentage saving. Retain the existing shard count
and selector; refresh from several successful full runs when measurements drift,
rather than adding shards or optimizing one noisy sample. Post-merge replay runs
that skip all shards provide no balancing evidence.

Reproduce the inventory with
`gh api repos/LTplus-AG/ifc-lite/actions/runs/RUN/jobs?per_page=100 --paginate`,
selecting successful `Viewer tests (shard N)` jobs and the exact step above.
Subtract `started_at` from `completed_at`; exclude setup, retries and post steps.

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
