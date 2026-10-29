# C4-11b completing layer (#7782)

Stack: #8329 on structural #8328, itself on C4-11a #8320. No merge authorization.
Baseline: `06cf74244610e5272ffbff53b54db88e1eac0675`.

`api/mod.rs`: 949 → 492 lines in the structural layer; prepass.rs: 583 → 98.
The 501-line pre_pass_streaming_impl row and prepass module row are deleted;
module digest is re-pinned downward. Scan/meta, event payloads, worker columns
and post-scan emission have separate homes, each under 150 lines. JS APIs,
committed wasm declarations and batch_parity_expected.json are unchanged.

## Measurement and tests

Pop native targeted run `auto-b36c3a8cdeea4fbcbe6f2ccfa8950d20`, source
`e330204b24210da06d47caa407bf59abbd28651e`: six C4-11 tests passed, including
C4-11a resets. Native metadata handoff (allocation calls, requested bytes):

| In-tree fixture | Rows | Base handoff | Shared handoff |
| --- | ---: | ---: | ---: |
| c4_bare_type_map_7782.ifc | 16 | 3, 920 | 1, 56 |
| c4_type_geometry_modes_7782.ifc | 33 | 3, 1720 | 1, 56 |

The test uses the exact former populated-row snapshot and current decoder
handoff under a thread-local counting allocator, not a timing benchmark. It
excludes the initial table allocation, scanning, metadata resolution, final
columns and JS events; no whole-prepass or worker-pool speedup is claimed.
Haus and duplex were absent in that initial targeted run and explicitly skipped.
The later validation script provisions all manifest fixtures from the host cache.

Both oracle patches reverse-apply. The extracted workflow step passes `bash -n`
on both heads. The second selector is FIRST after acceptance-harness-8112 and
keys on the ADDED prepass_index.rs; the predicate also matches relative to the
structural branch, independently of the first layer's patch addition.

## Fleet history

All commands use `~/build-workers/ifc-fleet run --cwd
/home/louistrue/.t3/worktrees/ifc-lite/t3-0d2321cb -- …`; task IDs are explicit.

- slots-r1 (`--storage-task c4-11b-slots-r1`), `cargo test -p ifc-lite-wasm --lib c4_11`,
  auto-c06403d4ca1c47e4a145d372eeb216ec at 5f9ff0796e: compile failed; corrected
  wire-payload field owner in 35eb14e3c7. No production tests ran in that attempt.
- prepass-r1 (`--storage-task c4-11b-prepass-r1`), `cargo test -p ifc-lite-wasm --lib c4_11 -- --nocapture`,
  auto-b36c3a8cdeea4fbcbe6f2ccfa8950d20: six pass, counts above.
- Same task, `--route fleet`, `bash tests/evidence/c4-11b-prepass/validate.sh native`,
  auto-fe6892ef440b4b2583c03d939a6fd3c7 at d62a75ad17: clippy found two needless
  borrows; corrected at b02a8108e0. Workspace/oracles did not run in that attempt.
- Same native command at b02a8108e0, auto-a0331bbf508946bdb18c1590a99ba868:
  storage job-open refused before project start (original receipt reconciled).
- Same task and route, `bash tests/evidence/c4-11b-prepass/validate.sh wasm`,
  auto-ffae4ffb8e5e482c8a2a9e456d232afe at b02a8108e0: in progress.

The first task's close attempt failed at remote manifest-release; source, logs,
receipts and unresolved storage remain preserved. No foreign process or output
was touched. Pending full-suite, fresh-WASM and mutation execution are not passes.
