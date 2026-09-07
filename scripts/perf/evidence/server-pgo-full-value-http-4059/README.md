# Full-value actual-server PGO: rejected

The held-out 22-model screen did not meet the frozen continuation threshold, and the 263 MB model failed the unchanged diagnostic gate. No five-pair continuation or shipping compiler flag follows. This is a distinct experiment from the counter-only server screen and the qualified native processing probe; their results are not pooled.

`screen.json` retains all 27 model pairs, exact gates, order, startup and readiness measurements, and every sampled RSS value. The primary held-out result includes the failed diagnostic case; the qualified subset is listed separately. Training, historical, expanded and independent-large cohorts have explicit membership. The largest model regressed in readiness and sampled RSS. The independent arithmetic and diagnostic review is retained in `independent-audit.json`.

All 54 fresh-process arms completed cold loading and cache replay, and their servers were reaped. Full geometry batch and data-model bytes matched across both arms and cache replays. On the 263 MB model, three Complete diagnostic paths report CSG failures changing from 194 to 196; metadata and symbolic data match. That diagnostic failure remains disqualifying (#4067). Neither exact geometry nor variation already seen within baseline runs waives it.

## Artifact and training scope

`provenance.json` records fresh artifacts and profile identities, the unchanged corrected stock source, fixed five public training fixtures and nonzero value/profile coverage. Control and use binaries use identical production source, allocator, default features and the downloadable Darwin release recipe. Training alone adds `generator-only-shutdown.patch`: graceful SIGINT shutdown lets main return normally and LLVM write full value profiles. No geometry or HTTP handler implementation changes.

The generator-only connection wrapper causes one axum connection-task CFG mismatch, discarding up to 36,656 profile counts. There are 148 missing-function diagnostics and no value-site mismatches; scanner, decoder, producer and serialization hot functions have no compatibility warning. The full diagnostics are in `compiler-compatibility.json`, with weak/comdat mismatch reporting explicitly enabled. This is not a whole-profile-match or warning-free claim.

## Reproduce the distinct candidate

Use the repository-pinned nightly and its LLVM 21.1.5 `llvm-profdata`. Check out public corrected source [`1b95c6652`](https://github.com/LTplus-AG/ifc-lite/commit/1b95c6652f49409ed102a693e67c8cba7da4f3ae); provenance retains the original measured commit and verifies identical Rust/server/compiler inputs, without claiming whole-tree identity. Retain one untouched control/use checkout and a separate generator checkout. Apply only `generator-only-shutdown.patch` to the latter. Verify all compiled source hashes match except `apps/server/src/main.rs`; preserve both source snapshots and the patch.

Set SOURCE, GENERATOR_SOURCE, EXPERIMENT and PROF_DATA_TOOL explicitly. Start with new, empty target and profile directories. From the respective checkout, the exact common build command is:

```bash
CARGO_UNSTABLE_BUILD_STD=std,panic_abort cargo build --release --package ifc-lite-server --target aarch64-apple-darwin
```

Use separate CARGO_TARGET_DIR values for each build. Control RUSTFLAGS is empty. Generator RUSTFLAGS is `-Cprofile-generate=<EXPERIMENT>/raw`. Unlike continuous counter-only training, do not add section-alignment flags or `%c` to LLVM_PROFILE_FILE. Train exactly the five `training` rows from provenance, once each, with a new per-process `<label>-%p.profraw` path. Exclude smoke profiles and every held-out fixture.

The published [v2 transport and witness tools](../server-pgo-darwin-2026-09-07/README.md) reproduce the cold upload and same-process hash-only replay workload. In a separate training-only copy of `run.py`, apply `corrected-training-harness-shutdown.patch` and copy `training_shutdown.py` beside it. The original `training-harness-shutdown.patch` remains an unchanged historical artifact, not the corrected reproduction recipe. The corrected recipe initializes the upload connection before the request, closes both connections even after a request error, preserves close failures, and sends SIGINT in a finally block. Both deferred and nondeferred success require normal exit zero. Do not apply it to timed control/use runs. Require exact raw and semantic cold/cache equality against validated stock-control captures for the same five fixtures before accepting their profiles.

Merge only those five fresh profiles with the matching `llvm-profdata merge`. Use `llvm-profdata show --all-functions --counts --ic-targets --memop-sizes` to confirm nonzero indirect-call and memory-operation values and scanner/decoder/producer/serialization coverage. Require no LLVM runtime errors during training. Preserve profile hashes, complete compiler diagnostics and every failed attempt.

Build the stock use checkout with RUSTFLAGS `-Cprofile-use=<EXPERIMENT>/merged.profdata -Cllvm-args=-pgo-warn-missing-function -Cllvm-args=-no-pgo-warn-mismatch-comdat-weak=false`. Verify source identity and binary hashes again. Audit all CFG/value-site mismatches; do not suppress a hot-path mismatch to qualify the artifact.

Run the published paired HTTP driver against the fixed 27-SHA corpus with these new artifact provenance files. Keep the same alternating order, fresh process/application cache, exact output/cache/diagnostic gates and capacity guard. Do not combine these runs with the native or counter-only evidence.

## Observer and storage limits

Cold means a fresh server process and empty application cache over loopback; OS page cache is not purged. Upload, wire persistence and observer overhead are included. Startup plus readiness is recorded separately from request-to-readiness. RSS is sampled every 50 ms; tiny cases are underresolved and support no aggregate memory claim. This is not browser, internet-latency, physical-disk cold or cross-target qualification.

The measured screen used a private v3 offline memo wrapper. `offline-equivalence.json` records byte-identical v2 outputs for four small and four largest-model captures, including stale/corrupt-reference refusal. V3 reuses only exact raw inputs under the same verifier identity; current Complete metadata, diagnostics and cleanup gates are recomputed. Its source is not claimed published here. The published v2 verifier independently recomputes the same semantic contract from retained raw captures; v3's reduced offline cost is not an application speedup.

Both timed arms and server cleanup finish before the offline child starts; that child and verified COW retention finish before the next pair. All 27 pairs completed within the existing reserve guard, without deleting unique evidence or changing the protocol. Both actual-server PGO candidates are rejected under their predeclared gates. The bounded qualification is complete, with no shipping integration.

Post-measurement review hardened reproduction only: the original paired driver checked five unique training hashes but did not reject a sixth duplicate row; the published driver now requires exactly five rows. All five recorded training processes were distinct and exited normally, so measured profiles/results remain unchanged. The historical training patch omitted exceptional upload cleanup and could report nondeferred success after a nonzero exit; its corrected successor is explicitly separate. Run the public harness tests plus `python -m unittest discover -s . -p "test_*.py"` here for real-child-process shutdown and failure-policy invariants.
