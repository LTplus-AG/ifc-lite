# Sparse fingerprint behavior oracle (#8114)

`behaviour.oracle.patch` has the normal change orientation and must be applied
**in reverse**. It preserves every type, signature, export and test seam. Four
expression mutations lose one hole per counted insertion, exchange canonical
JSON null and stableSerialize empty-slot tokens, omit the recoverable component
TypeError for a single outer hole, and return iterator `done` without Boolean
conversion (restoring numeric conversion at the u32 host boundary).

No production code or workflow is changed by this evidence commit.
The workflow currently uses an explicit `if`/`elif` selector list, not automatic
patch discovery. Consequently this patch requires an explicit `--mutation`
argument; adding this directory alone does not fix the CI selector.

The local gate entry point is `scripts/check-test-revert-oracle.mjs`:

```sh
node scripts/check-test-revert-oracle.mjs --base origin/main --head HEAD \
  --mutation tests/evidence/sparse-fingerprints-8114/behaviour.oracle.patch \
  --test rust/diff/src/fingerprint_counted_tests.rs \
  --test rust/diff/src/fingerprint_sparse_tests.rs \
  --test rust/diff/tests/fingerprint_parity.rs \
  --test rust/diff/tests/fingerprint_utf16.rs \
  --test packages/wasm/test/diff-parity.test.mjs --ci --json
```

The gate does not rebuild the WASM binary after mutating Rust. For actual
Node observation, `run.sh OUTPUT_DIRECTORY` reproduces baseline, reverse patch,
mutated execution and restoration with a fresh diff WASM build on every arm.
Run through `~/build-workers/ifc-fleet run --storage-task TASK --cwd CHECKOUT --
bash tests/evidence/sparse-fingerprints-8114/run.sh OUTPUT_DIRECTORY`.
It runs the complete native diff crate and the changed Node parity file;
Node assertion failures and Rust test failures are required, not compilation
or import failures. The geometry/diff memory isolation test needs a separate
geometry bundle and may skip; disclose that separately from sparse coverage.

## Measured result (Pop, 2026-10-27)

`results.json` pins source, commands, original request/job IDs and SHA256 hashes
of the six complete test logs. Source `3f48fabad05f` has production tree
`beafb3d2698a`; subsequent evidence-only updates add these results and normalize
generated trampoline declarations in the reproducer as build-wasm.sh does.

- Baseline: native **121 passed**, zero failed/ignored; Node **31 passed**,
  zero failed/skipped. Exit codes 0/0.
- Reverse-applied mutant: native library **57 passed, 10 failed**, exit 101;
  Node **22 passed, 9 failed**, exit 1, zero skipped. Cargo stops after the
  failing library target, so integration targets are not claimed on this arm.
- Restored: native **121 passed**, zero failed/ignored; Node **31 passed**,
  zero failed/skipped. Exit codes 0/0.

Native witnesses include `issue_8042_all_five_locations_retain_hole_cardinality`,
`issue_8042_sparse_json_and_stable_tokens_are_distinct`, and
`issue_8114_hole_runs_serialize_hash_measure_and_compare_like_materialized_holes`.
Node witnesses include missing component TypeErrors, absent/empty/hole hash
mismatches, and 1e3/1e5-hole parity mismatches (`ERR_ASSERTION`). The iterator
completion witness rejects the numeric-coercion sentinel. These are runtime
failures after successful compilation/import, not the former missing-method
capability gap. A combined mutation proves observation of the changed behavior;
it does not attribute each failing assertion independently to each expression.

All three arms rebuilt the diff WASM from their current Rust source. The root
Turbo dependency build also supplied geometry WASM and TypeScript oracle JS,
so even the geometry-memory isolation test ran, with no Node skips.
The initial clean-checkout attempt failed before tests because Turbo was not
installed; the recorded complete run includes frozen-lockfile installation.
The PC attempt was refused before execution by its backing-storage guard.

The test run restored all four mutated source files. Direct wasm-pack also
added six generated trampoline declarations; these were identified in the
checkout diff and removed during cleanup. No such generated output is committed.

The immutable worker receipt reports `processExitCode: 0` but wrapper exit 1
(`qualified command changed source`) solely for those generated declarations.
The post-cleanup checkout is clean. This receipt is preserved as recorded;
the GREEN/RED figures above are test-command outcomes, not a claim of a green
source-cleanliness wrapper. The reproducer now normalizes the declarations.
