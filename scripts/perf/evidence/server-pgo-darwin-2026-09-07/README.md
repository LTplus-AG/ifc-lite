# Actual Darwin server PGO: both screens rejected

The native processing probe has a qualified corpus result in the [separate record](../native-pgo-current-2026-09-07/README.md). The [counter-only HTTP screen](../server-pgo-counter-http-4059/README.md) did not meet its continuation threshold and retained one failed diagnostic gate. It did not continue to five pairs. The distinct [full-value generator-only-shutdown screen](../server-pgo-full-value-http-4059/README.md) also failed its continuation gates; its results are not pooled with this profile. No shipping readiness or profile-use flag change is claimed here.

## What has passed

Five fixed public fixtures trained a fresh instrumented server after the JSON cache roundtrip correction (#4064). Each completed cold geometry/data-model delivery and exact same-process cache replay. Profiles are continuous counter-only, with no value-profile data. All three compiled-source hash maps match despite a later documentation-only commit. Artifact, compiler, source, training and profile evidence is in `pre-screen-provenance.json`.

LLVM 21 value-site warnings do not discard branch profiles: `populateCounters()` and `setBranchWeights()` precede `annotateValueSites()`, whose mismatch returns only from the value annotation helper. The [matching upstream source](https://github.com/llvm/llvm-project/blob/llvmorg-21.1.5/llvm/lib/Transforms/Instrumentation/PGOInstrumentation.cpp) and its digest/line references are recorded. Missing-function diagnostics and value-site warnings remain visible; this is not a warning-free build claim.

## Measurement limits

Cold means a fresh server process, empty application cache and raw IFC upload. The operating-system page cache is not purged; preflight fixture hashing can warm it. Local loopback HTTP includes upload, wire persistence and observer overhead; it does not measure internet latency or physical-disk cold reads. Cold readiness ends at complete data-model receipt; cache publication/replay has separate timestamps. Memory is sampled server RSS, not physical footprint.

Both timed arms finish and their server processes are reaped before offline decoding or evidence retention. The offline child exits before the next pair. One operator owns the timing host; no concurrent builds, profiling, compression or heavy hashing. A single pair is a screen, not a qualified five-pair estimate. The held-out 22 cohort is primary; all 27 and fixed training 5 are secondary.

## Reproduction source

`reproduce/` contains the actual HTTP transport, full wire/data-model witnesses, tests and paired driver, plus parameterized build/training/profile tools. `harness-source-map.json` identifies exact private-origin hashes and published hashes, including explicit path-parameter adaptations. These are manual evidence tools, not production entry points or CI performance gates. User IFC files and generated wire evidence are never committed.

Use Python 3.9 or newer and the recorded dependencies in `reproduce/requirements.txt`; use the repository-pinned Rust toolchain and its matching `llvm-profdata`. Darwin training additionally needs the documented 16 KiB profile section alignment. Do not reuse profiles across source changes or infer other target/compiler behavior.

Provide an experiment `plan.json` with sourceCommit, profileKind and exactly five training rows `{label, path, publicSha256}`. `corpus.example.json` documents the fixture manifest schema; replace example paths with local files. The driver requires exactly 27 unique fixture hashes and a training subset of 5. `capacity-projection.example.json` contains measured label/SHA-linked capacity budgets; storage requirements must be re-evaluated for different fixtures.

From this directory, with SOURCE, EXPERIMENT, COMMIT, CORPUS and PROF_DATA_TOOL set explicitly by the operator:

```bash
python reproduce/build_server.py --source "$SOURCE" --experiment "$EXPERIMENT" --expected-commit "$COMMIT" control
python reproduce/build_server.py --source "$SOURCE" --experiment "$EXPERIMENT" --expected-commit "$COMMIT" generate
python reproduce/train.py --experiment "$EXPERIMENT"
python reproduce/audit_profile.py --experiment "$EXPERIMENT" --llvm-profdata "$PROF_DATA_TOOL"
python reproduce/build_server.py --source "$SOURCE" --experiment "$EXPERIMENT" --expected-commit "$COMMIT" use
python reproduce/screen_http_v2.py --manifest "$CORPUS" --training-plan "$EXPERIMENT/plan.json" --base-provenance "$EXPERIMENT/control-provenance.json" --candidate-provenance "$EXPERIMENT/use-provenance.json" --projection capacity-projection.example.json --out "$EXPERIMENT/http-screen" --cpu-window-confirmed
```

These commands intentionally refuse existing build targets/profiles/output directories. Keep failures instead of silently retrying or overwriting. The APFS retention helper only operates on explicitly released generated evidence; it verifies exact bytes and keeps distinct paths/inodes. Run its tests and inspect capacity permits before use on another filesystem.

Run witness tests with `python -m unittest discover -s reproduce -p 'test_*.py'`; retention tests separately use `-s reproduce/retention`. They encode actual Arrow/Parquet data and mutate payload fields. No source-text assertions or private IFC fixtures are required.

The counter-only verdict is recorded separately, with all failures. The bounded qualification in #4059 is complete with both actual-server candidates rejected. `pre-screen-provenance.json` is the immutable initial counter-only preparation snapshot, including its then-pending status.
