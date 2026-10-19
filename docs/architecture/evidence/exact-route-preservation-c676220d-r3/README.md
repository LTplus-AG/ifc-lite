<!-- SPDX-License-Identifier: MPL-2.0 -->
# Dependency compiler-policy provenance correction

Incremental response to `exact-capture-ec802-closure-review-20261019-r2`, whose
summary was supplied by the parent. Frozen checkpoints `7368cb32e9` and
`ec8020e817` and both existing evidence directories remain unchanged. This layer
changes verification tools and their small protocol fixtures only; the complete
raw capture example, exact arithmetic and original source/fixture pins are unchanged.
No Rust/native build, heavyweight test, A/B capture, cache deletion, foreign
configuration edit or fleet job was performed. The parent's active Rust run was
left alone. Independent closure remains pending.

## Every reached Cargo unit is checked

`exact-route-units.mjs` now derives policy provenance for **every** Cargo
`compiler-artifact`, including all reached workspace crates, external crates,
proc-macro/build-script units and the example. Core, geometry and processing must
all occur as Git-bound workspace units; their absence cannot reduce the cohort.
Each record binds package/version, target/source identity, complete profile and
features to exactly one successful terminal compiler trace. The trace records
actual compiler/version/ordered arguments, compile-context digest, source file
fingerprints before/after, inherited Cargo configuration hashes before/after,
generated OUT_DIR inputs and actual linked/output artifact hashes. Workspace
input fingerprints must match the independently verified Git blobs. Unknown
response-file inputs refuse instead of being accepted as unexamined arguments.
Configuration files are hashed, not copied into evidence.

The wrapper records the terminal event after rustc exits. Cargo's reported output
bytes must equal that trace's output bytes, including byte-checked Cargo executable
copies. Every `--extern` input must resolve to a qualified artifact with the exact
bytes the compiler read, unchanged across compilation. The runner stores the
compact `compiler-context.json` and `compiler-artifact-hashes.json` alongside the
existing raw invocation/artifact logs. It does not copy a Cargo target or archive
all dependency libraries. The independent fleet-log binding still seals the final
receipt, which contains the recomputed dependency records.

The receipt comparator reconstructs those records from the raw files, verifies
context against the independent Git/source/toolchain/environment evidence, and
compares each matched unit's full profile, features, effective argument policy,
external source fingerprint and ordered link relationships. Actual artifact hashes
remain individually bound but may change with intentionally different workspace
source. Every compiler argument is policy-relevant except explicit relocation
normalizations: main input/output paths, traced extern artifact paths and dependency
search directories, compiler metadata/output-name hashes, and the incremental
cache directory's location. Incremental flag presence remains compared. Raw
arguments retain all original values. No numerical tolerance or output sorting
was added. The example alone cannot certify any dependency's policy.

Dependency units are explicitly keyed; duplicate/ambiguous keys, changed/unpaired
unit cohorts and links without exactly one qualified artifact owner refuse. A
new/deleted dependency is therefore a visible unresolved policy comparison rather
than a silently exempted crate. This conservative gate does not claim that the
actual pre-migration/candidate dependency cohorts have already been reconciled.

## Cache qualification is deliberately refused without trusted provenance

There is **no retained-trace importer** in this correction. Every Cargo
`fresh: true` unit is unqualified and refuses, even when profile fields match or an
extra JSON field labels a purported trace trusted. Its current artifact bytes,
package/source/configuration/toolchain and actual reached compiler invocation
cannot be inferred from the example or a cache filename. Cached critical and
external dependencies are subject to exactly the same refusal.

This does not disable the managed cache, change Cargo admission, delete artifacts,
clean targets, touch dependency sources, or force a mass rebuild. Cargo still uses
the normal managed target. A naturally fresh admitted build can supply current
traces; an ordinary cache hit may leave the capture campaign honestly blocked.
A future retained-trace protocol requires independently authenticated compile
receipts bound to the actual artifact bytes, source, configuration and toolchain
before it can replace this refusal. No such support or qualification is claimed.
The previous example-only mtime refresh is retained; no dependency freshness is
manufactured. Missing provenance must be resolved under separate reviewed admission,
never by deleting a managed or foreign target to turn this gate green.

## Parent execution and remaining gates

Use the r2 clean-overlay preparation, admitted run and independent fleet-receipt/
output-log procedure, with this correction's frozen bundle and r3 manifest:

```sh
node "$BUNDLE/scripts/exact-route-run.mjs" prepare "$CHECKOUT" "$ORIGINAL_SOURCE_SHA"
# Submit only when the parent's independently reviewed admission is ready:
~/build-workers/ifc-fleet run --cwd "$CHECKOUT" -- \
  node "$BUNDLE/scripts/exact-route-run.mjs" run \
  "$CHECKOUT" "$ORIGINAL_SOURCE_SHA" "$NEW_OUTPUT_DIR"
node "$BUNDLE/scripts/exact-route-receipts.mjs" \
  "$BASE_OUTPUT" "$BRANCH_OUTPUT" "$BASE_SHA" "$BRANCH_SHA" \
  "$BUNDLE/docs/architecture/evidence/exact-route-preservation-c676220d-r3/manifest.json" \
  "$GIT_REPOSITORY" "$BASE_TERMINAL_FLEET_RECEIPT" "$BRANCH_TERMINAL_FLEET_RECEIPT" \
  "$BASE_ORIGINAL_FLEET_LOG" "$BRANCH_ORIGINAL_FLEET_LOG"
```

These are unexecuted Rust/A-B commands. Both original source pins remain required;
a repaired reproduction cannot impersonate either. All raw fields and the v2
schema/options/Git/fleet checks remain enforced. Actual A/B is **UNRUN**, with no
no-regression or full-no-loss verdict. Nonempty instancing, actual federation,
all-consumer/platform qualification and the independent closure remain unwaived.

## Eligible protocol validation

The four root script test files ran directly under the user's explicit allowance
for small pure Node protocol/filesystem/Git fixtures. They do not invoke Rust,
Cargo, pnpm, a package-local TS runner, native tools or model processing. The final
run passed **117 tests, zero failures/skips**. The complete TAP output and a source-
hash-bound result record are retained here. This is protocol evidence, not a Rust
compile, real-model behavior, cache qualification or timing benchmark.

Paired negatives retain the same scene and example profile/policy while changing
geometry, processing or external dependency profile/arguments/features. Receipt
negatives recompute their synthetic hashes and fleet markers, proving rejection
by the dependency comparison itself. Cached-without-trace/trusted-label, missing
or ambiguous compile traces, source/config/toolchain/output/link hash mutations,
generated inputs and missing/unpaired critical units refuse. Existing raw-field,
options, duplicate/order, schema and independent Git/fleet negatives also pass.
All four test files are reached by the existing root `node-tests` catch-all.
