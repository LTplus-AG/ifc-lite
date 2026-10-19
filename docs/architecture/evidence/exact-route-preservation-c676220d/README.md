<!-- SPDX-License-Identifier: MPL-2.0 -->
# Pre-common-program exact-route preservation: prepared, UNRUN

Verification-only checkpoint in isolated worktree `t3-c676220d`, branch
`t3/exact-route-regression-capture`. No production source, API, arithmetic,
native SDK, runtime, common-program, region or opening-oracle test was changed.
Exact arithmetic remains the permanent default. No build, job, runtime test,
benchmark or base/branch capture was submitted. The parent's active native job
at source `475c5edca5` is independent and was left alone.

## Source pins and ordinary consumer

The cumulative baseline is `772522f9df7a06d5287c1e9934055206fd464866`.
`git show e2e42bbfb8` identifies the first common representation/constructor
program integration and lists that baseline as its sole parent. The first-parent
history also shows later common Boolean, layers, opening and resource changes.
`86adb595c0c6429e1a0c423b962f9b153a1d2d0a` already descends from that integration;
it cannot establish pre-common-program preservation.

The immediate integration parent for this verification layer, and initial
candidate source, is `475c5edca5ab4c8ba99a92874504240b2fecffe3` (its own parent is
`18f0d5d4bfd7698d68719516d2cc1165520d7f84`). The parent can select a later clean
candidate explicitly. Capture it once and compare it against both the cumulative
baseline and this immediate integration parent. A capture of `475c5edca5` compared
to itself only checks repeatability; it provides no layer-attribution evidence.
No historical receipt qualifies a later source.

Both inspected revisions expose the same `process_geometry(&content)` convenience
consumer and result fields. The example calls it once per fresh process, with
its ordinary full-pass/default openings, quality and features. It neither drives
`GeometryRouter` nor constructs an alternative pipeline. Every `IFC_LITE_*`
environment override is refused. The declared Cargo profile is `server-release`
(unwind, preserving ordinary per-element isolation); no optional features are
added. Actual compiler version, flags, worker parallelism, source hashes, fixture
hashes, command arguments and compiler-reported binary hash are retained in each
run receipt. The committed nightly pin is also in `manifest.json`.

## Full output and ordering contract

`exact_route_capture.rs` captures all serde-visible mesh fields, including every
position, normal, index, UV, color, material/property field and decoded texture
byte, plus all texture dimensions, IDs, wrap flags and URL references. It adds
fields serde skips: local bounds, local-to-world and every `InstanceMeta` field.
It explicitly records origin even when all zeros, retaining signed-zero bits.
Exhaustive result/mesh/instance/frame patterns force a decision if those shapes
change. No new public API is needed.

Every f32/f64 is encoded by a custom serializer as its exact IEEE bit string,
before JSON sees it; nonfinite values cause an explicit failure. Every integer is
a typed decimal string, preserving u128 identities through JavaScript. All model
metadata, the original frame variant and its parameters, computed world matrix,
site/building transforms, and all result instance records are retained.

Arrays retain production order and duplicates, including meshes, triangles,
occurrences and diagnostics. No ID sort, triangle canonicalization, tolerance,
deduplication or FNV substitutes for payload comparison. Only object/map keys
have keyed semantics. Array reorder is a difference even if rendered images
would match. Instance tuples use the field order written in their capture key;
mesh-instance tuple order is transform, local transform, canonical transform,
representation identity, instanceable.

All serialized stats are retained. Only the nine explicitly named wall-clock and
point-cache-work fields are moved to `execution_only` and excluded from scene
equality. Refusal counts, dropped triangles, CSG failures and all geometry
diagnostics remain in the compared scene and are summarized in the receipt.
Unchanged pre-existing loss is reported, never certified as loss-free geometry.
No duration in these artifacts supports a timing or performance verdict.

## Fixtures and limits

`manifest.json` pins bytes sourced from the integration parent: the required
committed `issue_2019_wall_two_overlapping_openings.ifc`, committed Haus and building
samples, repeated/nested mapped occurrences, indexed colors, rotated and translated
site frames, and a styled mapped embedded-pixel/UV fixture. The same pinned files
are supplied to both source revisions from this bundle, including fixtures added
after the baseline. Missing or changed fixture bytes fail; nothing silently skips.
The opening fixture is the requested committed source witness, not an independent
analytic or native SDK oracle. The authored mapped/texture fixtures are identified
as such; they do not replace real-model coverage.

Intended fixture labels are not exercised coverage. The actual capture receipt
counts UV arrays/values, textures/decoded bytes, mesh-instance metadata, result instance records, emitted
geometry classes and frame variants. Inspect those counts and raw outputs before
calling any feature covered. The building sample contains type and surface-style
entities; a nonempty orphan/type-library output is still an execution requirement.

Default `process_geometry` disables output instancing. All instance fields are
captured, but empty arrays do not exercise the instance-record mode. This checkpoint
does not add another options path to conceal that gap. A future matched ordinary
instanced-consumer capture is required for that contract. Actual viewer federation,
registry IDs and composed model frames also remain unqualified: separate model
captures cover their individual frames only. This harness does not claim browser,
WASM, imported geometry, generated-artifact, custom-processor or all-capability
closure. These gaps remain release gates under the root production plan.

## Parent execution protocol (commands provided, NOT RUN)

Keep this bundle immutable. Its manifest hashes all seven harness/tool/test source
files. `overlay.patch` is the exact two-file Rust source overlay; its SHA256 is
also recorded. `prepare` copies the identical files after checking their hashes
and refuses existing files or a dirty checkout. Do not use both preparation forms.
No Cargo manifest change or new dependency is needed on either revision.

Create separate clean detached source checkouts outside this implementation tree.
For each source, use its full SHA as `EXPECTED_HEAD`, and a new output directory
outside every checkout. With `BUNDLE` set to this checkpoint's absolute checkout:

```sh
# Lightweight preparation only, once for each clean source checkout:
node "$BUNDLE/scripts/exact-route-run.mjs" prepare "$CHECKOUT" "$EXPECTED_HEAD"

# Parent must submit this command through the existing fleet admission.
# It builds then runs every pinned fixture; NEVER invoke inside a second job.
~/build-workers/ifc-fleet run --cwd "$CHECKOUT" -- \
  node "$BUNDLE/scripts/exact-route-run.mjs" run "$CHECKOUT" "$EXPECTED_HEAD" "$NEW_OUTPUT_DIR"
```

Preserve the parent fleet request/receipt and declare the compact output receipt,
logs and raw captures as artifacts under the existing worker storage policy.
The runner does not acquire or nest reservations and never touches native work.
Use the repository toolchain environment as directed by the fleet. After uncertain
transport, inspect that original receipt; never resubmit automatically.

The build uses `cargo build --locked --profile server-release -p
ifc-lite-processing --example exact_route_capture --message-format=json`.
There are no package-local TS checks. Cargo stderr/artifact events, each process's
stdout/stderr, and a source-bound receipt are preserved even after failure. Each
capture uses `create_new`; an existing output directory is refused. Nonfinite
capture, build error, missing fixture or incomplete source verification leaves
FAILED evidence rather than a successful receipt.

After actual captures, run the small receipt comparator (not a timed benchmark):

```sh
node "$BUNDLE/scripts/exact-route-receipts.mjs" \
  "$BASE_OUTPUT" "$BRANCH_OUTPUT" "$BASE_SHA" "$BRANCH_SHA" \
  "$BUNDLE/docs/architecture/evidence/exact-route-preservation-c676220d/manifest.json"
```

`BASE_SHA` must be one of the two original pinned comparison revisions. Run both
pairs for a later integration candidate. Preserve the comparator stdout/exit code
and hashes beside the fleet receipts. It verifies source pins, toolchain/settings,
full fixture cohort and capture-file hashes before comparing payloads. It reports
the first changed path per model. The per-file `exact-route-compare.mjs` is useful
for diagnosis but alone cannot qualify source identity or complete cohort coverage.
A zero result qualifies only the listed ordered ordinary-consumer outputs; review
nonzero feature coverage and the outstanding limits above separately.

If the inherited baseline does not compile, retain its original failed build and
source hashes. A compiler repair needs a separate, explicit reproduction commit,
patch, rationale and receipt. The runner refuses dirty tracked source and the
receipt comparator refuses a replacement baseline pin. A repaired reproduction
is useful diagnostic evidence but never an unchanged-baseline pass or a waiver.

## Validation status

All Rust example/unit tests and JS behavioral tests are **PROVIDED UNRUN**.
Only `node --check` parsed the five JS tool/test modules successfully; no tests
ran. `scripts/exact-route-compare.test.mjs` supplies bit/UV/texture/frame/instance/
metadata/order/duplicate/loss mutation negatives, including NaN/infinity rejection.
`exact-route-receipts.test.mjs` supplies source/toolchain/options/cohort/tamper
negatives. Their existing root `node-tests` catch-all in `.github/workflows/test.yml`
(`node --test scripts/*.test.mjs ...`) already invokes both; no unwired CI gate or
package script was added. Rust serializer invariant tests run with the example's
test target when the parent authorizes compiled checks.

No actual no-regression verdict exists until the original pinned baseline and
selected candidate execute, the complete raw outputs match, and their source-bound
receipts are reviewed. Full no-loss release qualification additionally requires
closing the documented instancing/federation and consumer coverage gaps.
