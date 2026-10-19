<!-- SPDX-License-Identifier: MPL-2.0 -->
# Reviewed dependency graph reconciliation

Second separate repair after frozen `3a1e7f7b1277` (binary binding). Frozen
`c9d3c7cba0`, its 117-pass evidence, and every prior evidence folder are unchanged.
This layer changes verification scripts and pure metadata fixtures only. The Rust
capture consumer, defaults and exact arithmetic remain unchanged. No heavy job,
Rust/native build/test, actual model capture, cache deletion or foreign config
edit was performed. The parent's source and active work were left alone.

The old equal-unit-cohort check cannot qualify the intended pre-common baseline:
`772522f9df7a06d5287c1e9934055206fd464866` precedes the first common program.
At inspected integration source `475c5edca5ab4c8ba99a92874504240b2fecffe3`, geometry
reaches imported geometry, and processing reaches geometry runtime. Runtime was
already a workspace member, but newly reaches this consumer. Its native normal
edge is geometry; imported geometry has no dependencies. Processing also declares
`triangulation-alt`; Cargo may emit a different feature *declaration* check even
with the same enabled features. `source-graph-plan.json` retains the original Git
trees, actual manifest contents/hashes, lock hashes, and explicit expected native
units/edges. Its inspected native transition adds no external dependencies. This
is source inspection, not a compiler run. A later branch source requires new pins.

## Exact reviewed witness

Ordinary equal-graph comparison remains available. A changed graph instead requires
an independent reviewed graph file **and an independently supplied SHA256**. A
receipt cannot select or authorize that file or digest. The witness contains both
independently verified source commits/trees, complete source-map digest, compile-
context digest (including configuration), root/package manifest and Cargo.lock
pins, every reached unit's full profile/features/ordered compiler policy/package
source digest, owning workspace manifest, and every ordered dependency edge.
Added and removed unit keys are explicit. Every actual side must equal the literal
expected side; missing units/edges, unknown additions and changed added-unit
policies cannot reuse an existing witness. No new unit evidence is discarded.

Common workspace profiles and enabled features must match. All compiler arguments
still match except explicit bound artifact/path relocations, the exact witnessed
added/removed extern edges, and optional exact per-unit `--check-cfg` feature-
declaration transitions. Common edge order remains significant. Changed edges and
feature declarations require a changed owning Git-bound package manifest. A
feature-declaration allowance records both literal `cfg(feature, values(...))`
arguments and its manifest path; it cannot waive `--cfg`, codegen, profile, enabled
features, arbitrary check-cfg expressions, or unchanged-manifest changes.

One-sided workspace units must belong to explicitly listed workspace packages;
the initial list is only imported geometry and geometry runtime. Common external
units require identical source, manifest, profile, features, compiler policy and
edges. Any external addition/removal/change needs its exact unit key explicitly
listed in `externalTransitions`, with complete literal before/after expectations
in the source/Cargo-lock-bound sides. Real successful compiler provenance is still
mandatory for every unit, including externals. This is an exact expected transition,
not an exemption for a package name or all new dependencies. The inspected native
campaign expects an empty external-transition list.

## Feasible capture and review sequence (all Rust/A-B steps UNRUN)

First obtain independent source/protocol closure on this frozen correction. Prepare
both original source revisions with the same added Rust overlay using the runner's
`prepare` command and this r5 manifest; use separate clean worktrees and new output
directories. On the parent's admitted execution window use the established fleet
command from r3, preserving both independent terminal fleet receipts and original
output logs. Both capture receipts must be complete before proposing a graph:

```sh
node "$BUNDLE/scripts/exact-route-graph.mjs" \
  "$BASE_OUTPUT/receipt.json" "$BRANCH_OUTPUT/receipt.json" "$NEW_GRAPH_DRAFT"
```

The command only writes an **unreviewed draft**, exclusively to a new file. It does
not verify or authorize receipts. Independently review its complete unit policies,
source/manifest/lock pins and actual terminal traces, reconcile its explicit
added/removed keys and edges with the actual selected Git manifests, and declare
only the exact source-supported feature-declaration or external transitions.
Freeze that reviewed file and its independently computed SHA256 in the parent's
execution evidence. Then qualify the actual receipts and output equality:

```sh
node "$BUNDLE/scripts/exact-route-receipts.mjs" \
  "$BASE_OUTPUT" "$BRANCH_OUTPUT" "$BASE_SHA" "$BRANCH_SHA" \
  "$BUNDLE/docs/architecture/evidence/exact-route-preservation-c676220d-r5-graph/manifest.json" \
  "$GIT_REPOSITORY" "$BASE_FLEET_RECEIPT" "$BRANCH_FLEET_RECEIPT" \
  "$BASE_ORIGINAL_FLEET_LOG" "$BRANCH_ORIGINAL_FLEET_LOG" \
  "$REVIEWED_GRAPH" "$INDEPENDENT_EXPECTED_GRAPH_SHA256"
```

The comparator reconstructs compiler units from terminal logs, validates original
Git/overlay bytes and fleet evidence, requires exact witness agreement, enforces
common policy checks, then validates full captures/options and compares ordered
raw outputs. A candidate source repair may only be a separately identified
reproduction; it cannot impersonate the original baseline. No reviewed graph for
real captures exists yet. No no-regression/no-loss or benchmark claim is made.

## Cargo shapes and remaining limits

Small fixtures model Cargo's host build-script copied executable, proc-macro shared
library passed as a downstream extern, and bare `--extern proc_macro`. That single
reserved sysroot extern now requires a successful actual-compiler target-libdir
query (including selected target/sysroot), one uniquely named proc_macro rlib,
byte hashes before/after, and equal bound toolchain-library bytes across sides.
Other bare externs refuse. Managed-cache policy is unchanged: cached units without
a trustworthy retained trace refuse; no retained-trace importer, forced rebuild,
cache deletion or admission bypass was added. These Cargo shapes pass only the
synthetic protocol fixtures; genuine host/proc-macro builds, duplicate host/target
unit identities and real cached-artifact qualification remain unproved.

Actual A/B, inherited-baseline compile viability, real nonempty instancing and
federation, and independent closure remain UNRUN/unwaived. Source files remain
under 400 lines with MPL headers. New tests run in the existing root workflow
`scripts/*.test.mjs` catch-all. The graph CLI is deliberately offline and does not
run as a CI gate. Pure Node protocol evidence and exact source/patch hashes are
retained alongside this document; no repo TS package command was bypassed.

Final eligible command: `node --test --test-reporter=tap scripts/exact-route-*.test.mjs`.
`final-protocol-tests.tap` records **148 passed, zero failed/skipped** for the frozen
source hashes in `protocol-results.json`. Earlier `development-tests.tap` and
`protocol-tests.tap` are iteration logs; they do not qualify the final source and
are not substituted for the final run. Test durations are runner diagnostics,
not benchmark results. `git diff --check` also passed.
