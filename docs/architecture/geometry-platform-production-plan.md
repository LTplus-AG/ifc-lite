<!-- SPDX-License-Identifier: MPL-2.0 -->
# Geometry platform: production landing plan

Planning checkpoint: 2026-10-19, parent `01abf2b4d9` plus uncommitted common
retained construction and resource-authority corrections. This is a release plan,
not a qualification receipt. Historical passing runs do not qualify this tree.

## Outcome and non-negotiable contracts

Land one Rust-owned plan/execute/assemble architecture for existing STEP geometry
and imported IFCX/USD geometry, consumed through canonical production boundaries.
Keep the exact arithmetic kernel permanently supported and default. Add explicitly
selected retained execution with original analytic source and complete product
semantics. Do not introduce automatic cross-engine retry, a second model loader,
or an independently maintained geometry implementation in TypeScript.

Every currently supported capability must remain available with its existing
contract. A retained refusal makes a limitation honest; it does not discharge an
in-scope migration requirement. Retained-only limitations must be recorded in the
capability matrix, and any proposed reduction of the agreed target requires an
explicit product decision. It cannot be hidden by relabelling partial output.

Distinguish four artifacts: authored source, evaluated retained objects, display
meshes and exported representations. A construction receipt certifies none of
the enclosing product's openings, layers, appearance or final output by itself.

## Initial production baseline

Integration checkpoint: `4628a3c6f5` (2026-10-19). These observations supersede
planning-time state; each receipt remains bound to its original source.

- Common exact-side product/inner control, source ownership, late presentation,
  Boolean/opening control and canonical consumer integration exist in source.
- Native SDK repairs are integrated. Qualified native source `3af451ceee` completed
  all 254 build/link steps, four CTests and 21 actual SDK region witnesses, with
  unchanged source. Evidence is under
  `native/smlib-adapter/evidence/p0-native-f974d7c7`. This does not qualify Rust
  product execution, browser execution or performance.
- Imported Rust graph ownership and the synchronous compiled target are integrated
  with reproducible provisioning. Seven authenticated pre-migration scene captures
  and eight direct raw-bit cases compare exactly; the child root lane passed 229
  IFCX tests without skips. Evidence and scope limits are under
  `evidence/geometry-platform-imported-current`. Its immediate-parent committed
  artifact is incompatible with its graph protocol; admitted regeneration of that
  parent is still needed for immediate-parent attribution.
- The full workspace at `edaefca319` executed and failed: 86 targets, including 82
  stack-overflow aborts, four geometry assertions and three guard targets. Its clean,
  unchanged-source receipt and hashed output are under
  `evidence/geometry-platform-integrated-validation/workspace-eda-terminal`.
  Compiled debug evidence identifies 34 KiB continuation values and at least
  64–140 KiB execution frames. Lazy owned controller storage and behavioral
  assertion corrections are committed at `4628a3c6f5`; follow-up results are below.
- Common native retained construction exists; full mapped/Boolean/opening/layer
  continuations, browser product transactions and final publication remain open.
  Isolated P1 implementation is underway. It cannot qualify or ship the affected
  default path before P0 is green.
- The independent packaging PR is #7940. Its focused tests pass; full CI and
  approving review are tracked separately. It does not represent platform release.
- Canonical WASM declarations, final artifact regeneration, all-consumer runtime
  validation, cross-platform determinism and end-to-end performance are still
  required on the assembled release candidate.

## Integration update after initial P0 repairs

Source checkpoint `2deba6d5dd` integrates merged mapping/late placement, semantic
empty results, managed native per-object cleanup and the bounded affine runtime.
Parent assembly review caught a duplicated test; the checkpoint removes the stale
copy and keeps the stronger lifetime witness. Affine assembly records are under
`evidence/geometry-platform-integrated-validation/affine-parent-5ef7`.
Twelve combined driver fixtures and changed Rust parsing pass; these checks do
not qualify SDK numerical behavior or Rust types. Affine exclusions remain gaps.

Baseline job `887916da-9ea2-4528-966a-8d90b4cca9e4` completed on earlier source
`9be1dcd3a0`: standalone geometry passed 1,876 tests with one ignored; workspace
reported 6,273 passed, one failed and 47 ignored. The sole failed target was the
processing library's existing two-map cancellation fixture. Repair `bf9f12270d`
preserves entrance cancellation across the actual source scope and retains the
unchanged regression; independent source review passed, runtime rerun is pending.
Clippy did not run after the workspace failure. Original terminal evidence is under
`evidence/geometry-platform-integrated-validation/workspace-9be-terminal`.

Styled/type-map source `2fbb172ddb` is integrated at `89d6a5db77`, with all 26 file
hashes reproduced. Review repairs cover visibility, error classification and real
0/1/3-product fixtures with independent authenticated owners. Its compiled and
numerical qualification remains pending. The corrected workspace request at
`9460a3de7b` was orphaned before admission, with no output or exit status, and has
not been replayed; see `evidence/geometry-platform-integrated-validation/workspace-9460-orphan`.

Actual SDK source `5f39d485ed` compiled/linked all 260 steps and passed four of five
CTests. The main suite failed its new semantic-empty witness before later affine
and region witnesses; the isolated copy-failure CTest passed. Raw SDK IsEmptyModel
checks cleared list pointers and reports false even for a valid vacant BRep.
Shared query/tessellation certificate repair `8441381f54` uses actual topology and
strict void-region flags, with default-vacant/full-space/unknown/wire regressions.
It passed independent source review. Fresh normal SDK request
`auto-78be6c8f65c14c6fa827b54c54f7a2fb`, job `9a733441-6688-4c33-ba4a-abe97a0b5c45`,
is queued on that exact source, followed by real-worker Rust runtime tests only if
CTest passes. These observations are under the `sdk-5f39-empty-failure` and
`semantic-empty-844` evidence directories. No complete SDK numerical pass is claimed.

Common retained operation values, affine bake and Boolean continuations remain in
isolated implementation. Full opening/layer/browser/final publication closure,
regenerated artifacts, all-consumer/platform/model/performance qualification and
the remaining reviewable PR stack are still required. Historical passes never
qualify these later integrated layers.

## Release control and evidence

Use the existing capability inventory as the preservation ledger. For every row,
record baseline behavior, target behavior, owning module, consumer/target matrix,
implementation state, behavioral witness, source commit, generated artifact hashes,
actual run receipt, skips/refusals and unresolved findings. Use separate states:
planned, implemented, reviewed, executed, qualified and released.

Pin a pre-migration behavioral baseline and each review layer's immediate parent.
The former detects cumulative loss; the latter attributes regressions. Compare
the final release candidate against both. Preserve source-bound historical runs;
never relabel them as evidence for a later tree.

Production acceptance requires all preservation rows qualified, all in-scope
retained product requirements closed, all required CI contexts green, no unresolved
correctness/ownership findings and a recorded performance verdict. Missing SDK,
fixtures, target hardware or artifacts means pending evidence, not passing tests.

## Dependency-ordered delivery packages

These are review and validation boundaries of one migration. Split large packages
into reviewable commits/PRs without creating alternative implementations. A shared
base must be committed before isolated dependent work starts. Each layer must be
usable and preserve default behavior when merged: `main` can deploy nightly.
Changes that would expose incomplete behavior stay on the integration stack until
their dependencies and acceptance gate are satisfied.

### P0 — Establish a reproducible integrated baseline

Freeze the current construction/resource correction, review the assembled diff
and repair static gate failures without weakening guards. Inspect all original
failed receipts and maintain a failure-to-fix-to-rerun table. Diagnose the actual
native SDK surface-count failure using actual surface APIs and numerical witnesses;
do not assume unrelated circular-range fixes resolved it.

Checkpoint a clean source tree, acquire fixtures, and run workspace tests and
strict all-target Clippy through fleet admission. Regenerate stale artifacts at
this checkpoint as necessary for meaningful consumer checks; regenerate again
after later source changes. Establish baseline comparison harnesses before
additional semantic changes. Do not continue expanding features on an unexplained
red integrated tree.

Exit: reproducible source/artifact identity; known failures resolved or isolated
with a demonstrated unaffected boundary; green exact-side baseline checks before
merging any affected default-path layer. Retained SDK failures block retained
qualification even if default-path checks pass.

### P1 — Complete common values, mapping and placement

Extend logical retained values through every relevant common accumulation boundary,
including repeated mapped occurrences, product placement and reusable definitions.
The processing ledger owns actual native/browser realizations; geometry owns
logical operations and continuations and never depends on the runtime crate.

Preserve ordered occurrence identity, definition sharing, f64 source/local/world
frames, single unit conversion, RTC and proper rigid-copy semantics. Implement
required non-rigid cases with an explicit representation/conversion contract;
until then they remain unresolved, never silently sampled or skipped. Cache keys
include the selected contract, source/configuration generation and occurrence
semantics. Exact cached meshes cannot discharge retained work.

Exit: actual source-driven repeated/nested mapped tests, millimetre and survey
coordinates, shared definitions with distinct occurrences, expired-source/owner
rejection and result-copy survival after operand release. No final-product API yet.

### P2 — Complete retained Boolean, opening and layer continuations

Use the same reached common program for ordered operands, host cuts, grouped cuts,
half-spaces, empty-host decisions and layers. Carry logical retained values through
these continuations rather than injecting a retained display mesh into the exact
operand path. Preserve lazy source admission, valid DAG multiplicity, diagnostic
ordering, consumed work, provisional rollback and custom processor policy.

At issuance, capture the expected operation, ordered operand slots/objects, f64
frames and original program reply. Validate sealed result identity and live object
leases before linear consumption. Retain each dependency until its last real use.
Keep exact numerical budgets separate from source-walk and worker limits.

Exit: full products with nested/reused operands and external openings, retained
runtime receipts consumed by the original common continuation, and negative tests
for swapped operands, frames, stale handles, duplicate acceptance, budget stops,
partial failures and cancellation. A leaf-only demonstration cannot pass this gate.

### P3 — Finish browser transactions and runtime supervision

Implement browser issue/await/accept over the same operation and pending contract
as native. Restore lexical owner/TLS state before every await, retain the original
reservation and captured resource/stop authority, and revalidate them on resume.
Cancellation must remain callable during an in-flight borrow. Unknown execution
outcomes invalidate the captured domain and cannot publish or be blindly retried.

Exercise actual module Workers, construction and dependency operations, release,
restart, timeout and drop during dispatched work. Prove native process reaping and
bounded scheduling; distinguish transfer limits from process/heap memory bounds.

Exit: actual native and browser product witnesses plus adversarial lifecycle tests,
not just transport fixtures or Node boundary tests. Native and browser each need
their own target qualification.

### P4 — Close fidelity, imported geometry and final publication

Complete placement, layers, IFC appearance, normals/UVs/textures and persistent
face/occurrence provenance required by downstream uses. Track lineage through
splits, copies and Booleans; do not promise stable face identity without proof.
Preserve text, annotations, structural edges, surfaces, instances and extensions
on the existing exact contract. Finish all agreed retained family requirements.

Finish IFCX composition-to-owned-source integration and compare visibility, colour,
inheritance, tombstones, point clouds, transforms, deduplication and source paths.
Keep Rust as geometry control/numerics owner and the existing composer/codecs as
format authority. STEP and imported entries share source-neutral execution
contracts without inventing STEP identifiers for imported data.

Enable final publication only when the common product is terminal-successful,
every required logical value is discharged and every reached coverage obligation
is closed. Route output through canonical presentation/assembly and all existing
consumers. Keep source-only publication explicitly distinct.

Exit: real-model final products and consumer outputs, including material/texture
and instance witnesses; no unresolved placement/opening/layer/appearance requirement
can accompany a result advertised as a complete product.

### P5 — Generate and package the actual release artifacts

Regenerate the imported Rust WASM/static JavaScript target with the pinned
translator, then verify source and artifact hashes. Preserve synchronous APIs and
exercise supported no-WebAssembly/CSP environments; do not handwrite a JS fallback.
Remove local temporary-tool-path assumptions from reproducible clean-host setup.
Regenerate canonical WASM through `scripts/build-wasm.sh`, commit generated types,
refresh intentional API snapshots and create appropriate changesets/documentation.

Stage pinned SDK assets through the canonical staging command. Verify native
helper discovery, fixed/self-hosted asset routing, worker/helper/module dependency
closure, offline installations, actual npm tarballs and Python wheels. Check
license/redistribution requirements and ship notices. Default exact installations
must not acquire accidental GPU, OpenUSD or external SDK prerequisites.

Exit: clean install-and-use tests from packaged artifacts outside the developer
checkout, supported bundlers and supported native platform matrix. Cross-compiling
or producing a wheel alone is insufficient install/runtime evidence.

### P6 — Qualify and release the assembled candidate

Run the matrix below against one immutable candidate. Review findings include the
exact source scope; fixes invalidate affected evidence and require scoped reruns.
Then replay required checks on the rebased/merged tree using the repository's
normal CI mechanisms. No green historical child run substitutes for integration.

Exit: the signed-off capability ledger, reproducible artifacts, complete consumer
matrix, performance verdict and tested release/recovery runbook.

## Qualification matrix

| Lane | Required evidence |
| --- | --- |
| Rust/default exact | `cargo test --workspace`; `cargo clippy --workspace --all-targets -- -D warnings`; applicable feature/doctest lanes, extension semantics, resource/unwind and public API checks. |
| TypeScript/viewer | Root `pnpm build`, `pnpm typecheck`, `pnpm test`, applicable lint/docs/API/ratchet gates; primary and federated canonical loads with one and multiple models. |
| Actual WASM/browser | Canonical build, `pnpm test:wasm-contract`, real browser Worker product execution, cancellation/restart, rendering and packaged asset requests; no unexpected SDK fetch on ordinary load. |
| SDK | Native CTest, real Rust subprocess integration, WASM boundary plus actual browser numerical/product witnesses. Required SDK tests must demonstrably execute rather than return early. |
| Imported | Current generated artifact verification; field-level baseline comparisons; real IFCX/USD composition/export/reopen; points, graph cycles/fanout, repeated instances and synchronous no-WASM host behavior. |
| Native consumers | CLI, server, C FFI unwind profile, SDK and Python build/install/use; supported OS/architecture and wheel matrix, including helper/asset discovery where applicable. |
| Fidelity | Real authored models spanning every affected capability; counts, topology, volume, bounds, units/frames, instances, appearance, textures, metadata, diagnostics and export/reopen behavior. Missing fixture channels require new witnesses. |
| Determinism | Exact predicates, correctness harness, native/arm64 export and mesh pins, wasm32 manifests, existing committed-reference checks. Re-pin only reviewed intentional changes. |
| Performance | Interleaved base/branch full worker-pool runs: parse/geometry/total, memory, bytes/artifact and startup impact, with output identity and fixture hashes. Include FZK, ISSUE_129 and feasible heavy CSG. |

Compatibility outputs retain their existing exact/byte contracts. New retained
tessellations can differ in triangulation: compare topology and geometry using
declared source/quality-derived tolerances fixed before reviewing results. Record
their representation and conversion lineage. Never widen tolerances merely to
make an observed failure pass. Set performance acceptance against existing
repository ceilings and a documented per-scenario budget before measurement;
an unexplained default-path regression blocks release. Record the verdict in the
performance ledger, including a neutral or negative result.

Extend existing CI path triggers to cover common program, processing transaction,
imported geometry, packaging and browser changes. The inspected geometry-platform
workflow currently exercises native and Node SDK boundaries, not actual browser
product execution. Wire required witnesses into executed jobs; a new script or
package command alone is not a gate. Report fixture/SDK skips separately.

## Review stack and coordination

Use P0 through P6 as the dependency spine. Parallel work can cover numerical SDK
diagnosis, imported artifact/consumer closure, packaged assets and preservation
witnesses while the common value/control owner implements P1/P2. Browser runtime
work can proceed after the common pending contract freezes. Appearance and export
work can proceed against a frozen lineage contract. One integration owner applies
incremental patches, preserves parent corrections and owns the assembled verdict.

Do not fork multiple implementations of common values, pending transactions or
publication. Separate implementation and independent review rounds; carry prior
findings/responses forward. Every delivery supplies exact base/source hashes,
incremental delta, evidence scope and residual blockers. Review source and actual
behavior, not test counts alone. Delete superseded paths as they are replaced.

No new issue is required by this program's user instruction. Before opening a
review stack, inspect the current queue check's actual mode and use the maintainer's
supported no-issue route where necessary; do not fabricate an issue reference or
bypass branch protection. No PR, push, merge or deployment is performed by writing
this plan.

## Operational release and recovery

1. Freeze one candidate and immutable source/artifact manifests. Qualify fresh
   install, cache upgrades, long sessions, repeated loads and federation. Run the
   final exact-preservation and explicit retained-product corpora on that candidate.
2. Inspect current main rules/workflows again. On 2026-10-19 the main rules require
   a PR, aggregate build/test, queue/review signals, committed-reference parity and
   a merge queue. These are observations, not a permanent copied gate list.
3. Merge only independently deployable qualified layers. Complete platform release
   requires P0–P6; landing a safe default-path layer is not a migration-complete claim.
   Publish versioned packages, wheels and native assets through existing workflows
   in dependency order. Match consumer versions and asset hashes; reject mixtures.
4. Validate the built viewer and packaged consumers on the exact main candidate.
   Deployment currently advances `production` from main at 05:45 UTC or through
   its manual workflow. A main merge can therefore ship the next night; unfinished
   default behavior must never rely on a later activation step for safety.
5. Record load success/failure, missing/partial products, diagnostics, worker
   restart/cancellation, latency/memory and asset-load failures for the qualified
   corpus and release smoke tests. Reuse existing reporting; do not add another
   unowned telemetry pipeline. Retained output is explicitly selected throughout.
6. Rehearse recovery: disable the newly exposed retained entry if necessary,
   return clients to a known-good version, and repair a default-path regression
   with a tested forward revert. The production branch forbids non-fast-forwards;
   do not plan to force-reset it. Retain immutable prior artifacts; do not overwrite
   versions or silently switch a running operation between engines.
7. Run the release corpus after deployment and after a fresh clean installation.
   Close the program only after production smoke tests and the capability ledger
   agree. Carry no unowned "later" fidelity obligations into a completion claim.

## Immediate execution order

First finish and review the existing common-construction/resource correction;
checkpoint it without folding in unrelated changes. Validate the current tree and
diagnose the actual SDK failure. Next complete mapping/frames and retained
Boolean/opening/layer control, then browser transaction consumption. In parallel,
prepare fidelity witnesses and reproducible imported/package builds. Close final
publication and consumers, regenerate final artifacts, qualify the immutable
candidate, then follow the existing release/deployment channels.

Fleet admission is standing authorization for eligible heavy validation. The
2026-10-19 planning observation is Pop admission allowed, PC reachable and Mac
disabled; recheck at submission. Respect locks, active jobs and refusals. Inspect
original receipts after uncertain outcomes; never duplicate unknown submissions
or delete foreign work to recover capacity. Capacity is an execution constraint,
not permission to waive a release gate. Calendar estimates should follow the first
green integrated baseline and actual SDK diagnosis, rather than assume them away.
