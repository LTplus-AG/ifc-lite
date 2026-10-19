<!-- SPDX-License-Identifier: MPL-2.0 -->
# Exact-route capture correction: source-only, closure pending

This corrects independent review of frozen checkpoint
`7368cb32e97ee17f1881c14bf5ed4b4471c73711`. The original evidence directory and
commit remain unchanged. This directory carries a new v2 manifest, exact Rust
source overlay, source correction patch and review response. All behavioral tests,
compilation, independent closure and actual A/B captures remain **UNRUN/PENDING**.
No job was submitted; the parent's `51c2` workspace request was not duplicated.
Exact arithmetic remains the permanent default. Nonempty output-instancing and
actual federation coverage remain release gaps, without waiver or timing claim.

The original source rationale and nine fixture byte pins are retained: cumulative
base `772522f9df7a06d5287c1e9934055206fd464866`, first common-program integration
`e2e42bbfb8bd087a386450a0ab643bcb061c133c`, immediate integration parent
`475c5edca5ab4c8ba99a92874504240b2fecffe3`. Choose the later candidate explicitly;
compare it to both original pins after independent review closes this correction.
A baseline compiler repair remains a separate reproduction, never an original-base
pass. No native/runtime/common-program/region/oracle tests or production API changed.

## Corrected admission and source evidence

Set `BUNDLE` to the frozen corrected harness checkout. Use fresh isolated detached
source checkouts at the original selected revision, and output directories outside
all source checkouts. Preparation now **commits only the exact two-file overlay**
to make the execution checkout clean for fleet evidence. It does not compile:

```sh
node "$BUNDLE/scripts/exact-route-run.mjs" prepare "$CHECKOUT" "$ORIGINAL_SOURCE_SHA"
```

Record the returned execution commit. Git independently verifies the original
commit/tree and every execution blob. The complete execution tree must be exactly
the original tree plus missing, pinned overlay files; no replacement, deletion,
foreign source edit or arbitrary repair is accepted. If the original already
contains the exact overlay, no commit is added. Both before and after execution,
working bytes are checked against the verified blobs and Git must report clean.
The original behavioral source and actual execution commit/tree are separate,
explicit receipt fields. The fleet runs the **execution commit**, not a label
asserting that it ran the unmodified original tree.

Submit through the parent's existing fleet admission only, retaining the original
terminal worker receipt. The runner emits exactly one final receipt-SHA256 marker
to stdout. The worker
hashes its complete output log, binding that marker to its terminal receipt.
Preserve that original log plus the compact logs, raw captures, saved capture
binary and fleet evidence under the standing storage policy:

```sh
~/build-workers/ifc-fleet run --cwd "$CHECKOUT" -- \
  node "$BUNDLE/scripts/exact-route-run.mjs" run \
  "$CHECKOUT" "$ORIGINAL_SOURCE_SHA" "$NEW_OUTPUT_DIR"
```

These commands are provided, NOT executed. The host-bound Node command follows
the fleet launcher's local-admission route; no remote availability of `BUNDLE` is
assumed. Keep the selected source and bundle paths available on the admitted host.
No unsupported `ifc-fleet --artifact` option is required: the output-log digest is
the independent binding. Do not nest reservations or resubmit an uncertain request.
Inspect its original receipt instead. A failed/incomplete job is not a capture pass.

For comparison, supply a Git repository containing both original/execution commits
and the **independently retrieved, original terminal fleet receipts and their full
output logs**. The capture
receipt cannot select those authorities. Do not synthesize or edit a worker receipt:

```sh
node "$BUNDLE/scripts/exact-route-receipts.mjs" \
  "$BASE_OUTPUT" "$BRANCH_OUTPUT" "$BASE_SHA" "$BRANCH_SHA" \
  "$BUNDLE/docs/architecture/evidence/exact-route-preservation-c676220d-r2/manifest.json" \
  "$GIT_REPOSITORY" "$BASE_TERMINAL_FLEET_RECEIPT" "$BRANCH_TERMINAL_FLEET_RECEIPT" \
  "$BASE_ORIGINAL_FLEET_LOG" "$BRANCH_ORIGINAL_FLEET_LOG"
```

The comparator independently resolves all source trees and blob hashes from Git;
recomputes the complete source-hash map; requires successful completed fleet runs;
checks clean, equal sourceBefore/sourceAfter, sourceUnchanged, empty dirty digest,
all four toolchain-input blobs, cwd and the command argument suffix; and requires
the terminal receipt's output-log hash plus exactly one final marker to bind the
actual capture receipt's bytes. A truthy tree/hash map, a source label, matching forged values in the two capture receipts, or a
nonterminal worker receipt is insufficient. Worker tools must match the captured
compiler identities. The trust boundary is the parent's original fleet receipt
and selected Git objects; this tool does not authenticate arbitrary fabricated
JSON as a real fleet record.

## Compiler and capture contracts

All `CARGO_PROFILE_*` variables are refused, including unknown names and empty
values. Existing RUSTFLAGS/encoded flags, target flags/linkers/runners, compiler
selection, toolchain and worker-thread settings are recorded. Additional compiler
wrappers are refused because they could change arguments after observation.
The pinned verification wrapper logs each reached compiler executable, its actual
`-vV` identity and full ordered arguments; Cargo `-vv`, artifact/profile events and
the saved executable are hashed. Codegen/target/cfg policy and compiled example
profile/features are compared. Main example source mtime is refreshed, without
changing bytes, to force an observed compilation; a cached/unobserved example
fails rather than borrowing earlier arguments. Fresh dependency compilation is
not claimed for cached Cargo artifacts; their artifact/profile events remain
recorded. No timing result is qualified by this instrumentation.

`exact-route-v2` keeps all original raw-bit output and original array order and
multiplicity. Nullable serde-skipped mesh/texture/metadata/diagnostic fields are
now explicit nulls; zero origin/class and refusal counts stay explicit. Thus
absence cannot impersonate `None` or zero. Schema validation checks every required
field, scalar type/range and finite float encoding; position/normal/UV/index/texture
lengths and index ranges; full instance tuples and template references; frame
variant/tag/parameter/matrix shape; metadata/georeference and diagnostics fields;
and consistency of mesh/vertex/triangle totals. Both captured option strings must
match the frozen manifest AND the ordinary-consumer protocol constant. Identical
paired truncation, skeletal meshes, malformed metadata or altered options refuse
before equality. Array order/duplicates remain compared without canonicalization.

## Validation and remaining work

Only JavaScript syntax, whitespace, patch parsing and hash metadata checks are
eligible here. Tests are supplied **UNRUN**, including real small temporary Git
object fixtures, independent worker-receipt mutations, paired payload/options
mutations and profile/compiler negatives. Existing root node-tests wiring already
includes the three `scripts/exact-route-*.test.mjs` files. Test fixture Git objects,
worker JSON and compiler logs are explicitly synthetic; none is runtime evidence.
The Rust serializer tests and actual example are uncompiled/unexecuted.

Freeze this correction for independent closure before integration or A/B work.
No no-regression or full-no-loss verdict exists. Later admitted original-base and
branch execution, exact full-output comparison, reviewed nonzero feature coverage,
and the outstanding federation/instancing qualifications are still required.
