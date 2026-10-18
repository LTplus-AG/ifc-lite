# Source-owner round 2 shared-root integration

Applied to root HEAD b3a441ec17e1619066ee14e15bdcc915975d42bd with preexisting uncommitted resource and boolean terminal changes. No commits, resets, rebase, publication, Cargo, builds, tests, heavy jobs, or fixture operations. No historical receipt was promoted to assembled-source qualification.

## Applied source

The exact reviewed combined source patch was archived as incoming.patch. Before mutation, 56 owned/new/renamed paths were recorded in before-manifest.json, with original bytes under before/ and their existing tracked diffs under before-owned.diff. Fifty path patches applied cleanly. Three overlapping files were manually integrated: rust/core/src/lib.rs, rust/processing/src/element.rs and element/owned_session.rs.

Forty-six of the 53 delivered paths match the child bytes exactly after integration. The seven deliberate differences are docs/api/rust.md (existing parent documentation), core/lib.rs (resource_stop module retained), element.rs (all parent/source/resource/presentation test modules plus new mismatch regression), model_context.rs (narrow derived presentation Arc getters), owned_session.rs (resource guards/visibility plus presentation context), session_protocol.rs (Stopped payload plus MismatchedSource), and scripts/perf/README.md (existing parent/resource ledger entries).

SourceBundle canonical construction, opaque semantic cache transfers, raw-import revocation, explicit trusted authoring revisions, borrowed prepass compatibility install and original duplicate cache behavior are preserved from the reviewed child. The old processing entity-index test file is deleted by its move to core/source_index_tests.rs; the source layer has one index builder, no parallel loader.

## Manual preservation decisions

- Kept core resource_stop module and existing execution-owner/source resource machinery; added the actual source_index/source_bundle modules and SourceCache/TrustedDecoderInputs exports.
- Added MismatchedSource to the existing protocol enum without deleting Stopped payload/matching or resource terminal handling.
- OwnedProductExecution checks actual decoder source before planning, executing, accepting and finishing, with a post-final-callback check. Rejected source replies return their original packet before assembly.
- Kept pub(super) canonical visibility for the accounted sibling consumer, public owned producer with_source_resources wrapper and its current stopped_output guard, state.presentation_context binding and all derived-only presentation getters. A numerical packet does not regain the full model/source context.
- Added accounted_session::context_error mapping for expected MismatchedSource to AccountedProductionError::Context; it no longer falls into the invariant panic arm.
- Added source_accounted_tests.rs: actual foreign same-size bundle and same-source empty raw-import authority revocation both reject before registered extrusion calls and leave usage/leases untouched, then a correct factory decoder runs the real extrusion and compares canonical output. This test is uncompiled and unexecuted.
- Added both original source_context_tests and new source_accounted_tests module declarations without replacing parent resource/presentation declarations.

## Static validation and limits

All 47 existing/new owned Rust paths parsed successfully using the prepared rustfmt binary with --emit stdout and skip_children=true; no formatting changes were written. Results are parse-checks.json. git diff --check returned success. These checks establish parse/patch integrity only; they do not establish name/type correctness, test success, Clippy, WASM/Python/browser behavior, performance or memory qualification.

Module budgets were not edited because the parent owns final ratchet reconciliation. Observed shrink candidates: rust/core/src/decoder.rs has682 lines under recorded701; rust/processing/src/processor/mod.rs has1072 under recorded1078. No allowance was raised. Preserve their current resource siblings during final accounting.

The source child validation at307c remains historical: workspace had one appearance test failure; final factory setup correction and d.ts were not rerun after guard refusal. The integrated source has no green compile/test result. Current fleet constraints remain unchanged.

## Generated WASM declaration

Only packages/wasm/pkg/ifc-lite.d.ts was applied from the reviewed combined patch. Its delta originated from the child's canonical scripts/build-wasm.sh run and matches the delivered child artifact. No generated declaration was hand-edited and no other pkg artifact was touched. Exact hashes/provenance are in declaration-provenance.json. A final shared-source rebuild/contract lane remains required.

## Artifacts

- before-manifest.json and before/: exact pre-mutation owned-path bytes/hashes.
- incoming.patch and patch-checks.json: reviewed input and per-path clean/conflict admission.
- source-only-integration.diff: changes from captured working-tree bytes, including new/deleted files.
- result-owned-root.diff and whole-root-working.diff: tracked current root diffs; foreign untracked work is not represented or modified.
- after-manifest.json and after/: resulting owned-path content, hashes, and exact-child deviations.
- parse-checks.json: syntax-only results.

No active sibling-owned resource account/core continuation/boolean files were edited by this port beyond sourcepatch's authorized module exports/protocol overlap. Concurrent sibling changes are not represented as this agent's modifications. Parent remains responsible for a coherent final source freeze and qualification.
