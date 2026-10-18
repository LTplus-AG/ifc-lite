# Retained authored preservation round 2

Status: implemented correction source; **not compiled or geometry-qualified**.
Exact Rust remains the default and permanent path. Retained evaluation requires
an explicit request; it never retries through another engine or loader.

This layer applies the original retained evaluator incremental patch on the
source/context/resource parent, then corrects undelivered native results,
cleanup retirement and browser upload ownership. A response envelope owns the
actual process until a successful wait claim. Both failed send and unread
response destruction retire that process. Shared child liveness invalidates
retained receipts on observed exit; old work cannot retire a replacement.
Mesh-release failure retires the process even when returning an earlier error.

Model-bound source admission uses `OwnedMeshProductionContext::admit_authored_plan`
on its leased authenticated decoder. It reuses the canonical source index and
existing analytic walker, caching immutable definitions once per snapshot.
A bound numerical document carries only a small lifecycle token, not the source
bundle, bytes, decoder or appearance maps. Explicit model invalidation expires
its work; dropping the model alone preserves the existing snapshot contract.

The explicit native executor uses private issued tickets and immutable runtime
realizations. Acceptance requires its exact pending ticket and live runtime
receipt, then borrows the original numerical packet into the existing document
display assembler. Caller-created completions cannot enter this acceptance API.
Standalone `AuthoredRetainedDocument` and `RetainedCompletion::new` remain
explicitly host-trusted adapters. Rejected receipts return intact. Dropping a
bound delivered/published owner retires its captured worker domain, including
other handles in that domain; callers must account for this conservative lifetime.
The pending slot is weak, so dropped tickets and terminal failures free admission
for a new explicit request. No automatic replay occurs.

The existing curve interpreter now retains original typed trim selectors,
MasterRepresentation, SenseAgreement, composite traversal/order, basis/placement
coefficients and plane-angle scale separately from interpreted radians. Ordered
outer/inner loops remain source geometry. The single native decoder supports
bounded line/circle/arc numerical region uploads, with SDK temporary curve RAII.
The new native and browser geometry witnesses have not run. Rust source admission
therefore still refuses circles, holes and general curved regions. This is **not
a complete consumed curve/profile evaluator**. The child report's proposed
nonunit IfcLine DirectionRatios defect was not substantiated by parent review:
the analytic RequireBoth trim path normalizes DirectionRatios before applying
Magnitude. A scaled-direction invariant is still needed; the separate mesh
compatibility path must be assessed on its own contract.

Copied-transform Boolean/opening dependencies, final net products, general
rational curves/swept disks, smooth normals, persistent IFC face provenance,
appearance/UV attribution and retained USD remain incomplete or explicitly
refused. Existing exact/default appearance, layers, metadata, instances, IFCX and
mesh USD paths are preserved in source; fresh consumer regression runs are still
required. This adapter does not replace the common ProductProgram source owner.

Parent review restored standalone duplicate-record behavior within the same
walker and inventory collector. Standalone extraction retains all scanned source
definitions and relationship facts, with the historical last successful instance
per product; model-bound analysis follows its actual decoder/cache once per ID.
The standalone and malformed-relationship invariants remain meaningful. Parent
review subsequently found that the duplicate-prewarm test assumed a cache state
the authenticated decoder forbids. Its first-record expectations are withdrawn;
see the [witness correction](curved-parent-f7d-review/witness-correction.md).
The corrected candidate tests canonical duplicate admission and actual supported
decoder configuration changes. They remain unrun and await integration.

An additional per-object lifetime defect remains open in this checkpoint:
releasing a copied raw solid handle can leave its process alive, so process
liveness alone cannot establish that the retained solid still exists. The next
implementation task owns registered object leases and release-before-acceptance
qualification. A separate audit must ensure new original-coefficient capture
limits cannot reject geometry supported by the existing analytic API.

Ten small JavaScript protocol/lifecycle fixture checks pass; these are not SDK
geometry evidence. Rust syntax parsing and metadata checks pass without a build.
Fresh native CMake/CTest, workspace Cargo, Clippy, real WASM/browser SDK, Python,
root Turbo and end-to-end performance/memory qualification remain outstanding.
Pop admission refuses with guard78. PC storage reached100%; a combined request
left a zero-byte request record and has unknown execution outcome. That original
request is preserved and must not be resubmitted.

A future admitted native/workspace command must set one explicit build directory
and use the same path for the actual Rust worker, for example:

```sh
export IFCLITE_ADAPTER_BUILD="/tmp/ifclite-retained-$(git rev-parse HEAD)-native"
bash native/smlib-adapter/qualify.sh native
export IFCLITE_SMLIB_WORKER="$IFCLITE_ADAPTER_BUILD/ifclite_smlib_worker"
test -x "$IFCLITE_SMLIB_WORKER"
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Run the entire sequence through `ifc-fleet run`, with source and admission verified
first. This is a corrected future command, not permission to retry an unknown
request. Full end-to-end performance and memory verdict: **UNQUALIFIED**.
