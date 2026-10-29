<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# C4-11a content-install lifetime (#7782)

Targets main after C4-10a #8316 was squash-merged as `0ace993cc3`.
The refresh preserves its refusal scopes, mapped-item invalidation on source
replacement, extracted pipeline contracts and the C4-11a reset contract. This
lane does not modify `batch.rs` or adopt C4-11b's slot/mode model. The executable
call-order fixture was committed in `d1be601af1` before reset code changed.

## Traced input orders

`I` = entity index; `C` = referenced maps, instantiated types, mapped-instance
plan and material layers; `S` = source bytes; `F` = installed style finishes;
`G` = pending geometry finishes; `B` = geometry batch; `P` = prepass.
Every sequence is exercised against the actual JS/WASM API by
`scripts/lib/wasm-content-install-contract.mjs`, registered before optional
fixture exits in `scripts/test-wasm-contract.mjs`.

| Client and trace location | Order | Lifetime consequence |
| --- | --- | --- |
| `packages/geometry/src/geometry.worker.ts`: `installFreshApi`, `processBatch`, recovery reinit | settings → I → C → S → F → BFromSource | Source installation retains columns; recovery replays inputs on a fresh API. |
| Same worker: scan-shard source preparation, later `set-entity-index` | S → I → C → F → BFromSource | Index installation must retain source. |
| `packages/geometry/src/index.ts`: sync and streaming wrappers; `style-finishes.ts` | POnce → F → B → cleanup | Prepass invalidates old derived data; finishes follow it. |
| `packages/cli/src/commands/diff-geometry.ts`: `computeGeometryHashes` | S → POnce → BFromSource → cleanup → empty S | Source precedes prepass. Hash path does not install finishes. The final empty S retains its existing diagnostics-reset semantics. |
| `packages/geometry/src/remesh/remesh-core.ts`: `remeshOnApi`, `styleWireOnApi` | POnce → B or wire extraction → cleanup | Reused API must not inherit the last request's styles/finishes. |
| `packages/viewer/src/viewer-html.ts`; create/export/viewer real-WASM test/oracle clients | POnce → optional F → B → cleanup/free | Same one-shot boundary, including clients without a finish setter. |
| `geometry.worker.ts`: `prepass-streaming`; `prepass-source-fingerprint.ts` wrappers | PStreaming → columns/styles/jobs events | Reset before callbacks; callback failure cannot expose the previous index. |
| Same worker: `prepass-streaming-sharded`, original and fingerprint wrappers | stitched columns → PSharded → jobs/prepass columns | Sharded length prevalidation precedes the reset; accepted attempts share streaming lifetime. |
| Same worker: `finalize-styles`; `worker-prepass-source.ts` | I/S already installed → G → finalizeFromSource or finalize(SAB); retry G → finalize(owned) | Finish input is consumed once per successful finalize, re-stashed for retry. |
| Preinstalled finish transaction (explicit input-tier invariant) | S → G → I → finalizeFromSource | Content installation must not abandon the pending transaction. |
| Legacy batch-only API | F → B (lazy I) | Lazy construction is not a new-content boundary; retain this batch's input. |

`packages/parser/src/worker-parser.ts` and `apps/viewer/src/hooks/entityIndexHandoff.ts`
forward index columns to the TS parser; `parser.worker.ts` creates a scan-only
IfcAPI using `scanEntitiesFastBytes`. They do not install a geometry/prepass index
on that API. Renderer references consume batch results; retained source adapter
references describe the frame, not another default prepass installation.

## Reset contract

- `setEntityIndex` (borrowed and owned binding), one-shot prepass, and accepted
  serial/sharded streaming attempts use `begin_content_install`. It expires
  ProductionModel source epochs, invalidates C4-10a BRep signatures, drops the
  previous entity index and every derived cache, and resets diagnostics.
- Derived caches: parts-to-skip, material layers, referenced representation maps,
  instantiated types, type-geometry plan, mapped-instance plan, textures,
  indexed-colour maps, plane-angle units, style colour maps, installed finishes,
  item dedup meshes and mapped-item meshes. Source bytes and the pending sharded
  finish stash remain separate input tiers.
- Rejected/empty external index installs clear old derived state and leave no
  index, allowing a lazy scan. Sharded column-length validation is an existing
  pre-install refusal and retains the current load. The changed callback test
  explicitly expects a lazy scan after an early accepted-attempt failure.
- `setSourceBytes` keeps the existing source-epoch/BRep/diagnostic invalidation
  and drops source-keyed mapped-item meshes,
  retaining the index and columns already installed by workers. It must be
  paired with index/prepass installation for a new file.
- `clearPrePassCache` expires snapshots and drops derived state, source and both
  finish stores, preserving diagnostics and persistent settings.

## Witnesses and boundaries

The native tests decode a textured, typed, layered extension of PLAIN and then
PLAIN itself, a strict subset with colliding ids. They verify rebuilt
texture/type/layer results, stale-source refusal, and discard of every populated
derived slot. The JS/WASM witnesses use the truly different file pair. Additional witnesses cover finish transaction consumption, cleanup,
source/index ordering and persistent settings. Real WASM tests compare reused
and fresh APIs on colliding style signatures, shape and colour changes, authored
finish removal, streaming abort, SAB and owned-buffer retries. Existing C4-10a
BRep collision witnesses and the C4-0 full payload gate remain unchanged.

`behaviour.oracle.patch` is applied in reverse: it removes only the new
`discard(...)` calls in `clear_content_derived`, retaining source-epoch and BRep
signature invalidation, diagnostics, APIs and test wiring. The top CI oracle
branch selects the new native witnesses. `validate.sh mutation` requires actual
a stale-content-cache assertion failure after the epoch assertion passes,
rejects forward application, restores the patch and requires green again.

Performance verdict: correctness change at explicit load boundaries. No
end-to-end worker-pool timing or speedup claim. Successful single-file output is
qualified by C4-0; browser timing and whole-host memory qualification are not
established by these focused tests. Native Rust processing is untouched.


## Recorded qualification

The main refresh is pinned in [validation.json](validation.json). The Rust API
surface, module-size, reference-walk, source-text assertion and test-wiring
checks pass locally. The mutation reverse-applies and rejects forward
application. Both committed WASM declarations match main; the contract entry
point stays at its unchanged 2,095-line budget.

The parent directed this refresh to be pushed and marked ready after the
local gates: GitHub CI is the merge gate and must be fully green. Post-push
native confirmation at `50f8b0cb44` passed workspace all-target clippy and
`cargo test --workspace`. All C4-11a/C4-10a witnesses, C4-0's 15 committed
fixtures, and the native ratchets passed. Successful harness result lines
report 7,515 passes and 48 ignored cases, including doctests and child-test
output; optional-fixture early returns remain coverage gaps. Exact fixture
gaps and immutable receipt/log hashes are in validation.json. The native log
and receipt were recovered to a verified evidence manifest without replaying
the project command.

The parent's later oracle-selector and style-finish resend fixes are preserved
at `15c10854f4`; Rust and Cargo/toolchain inputs still match the native source.
Pop's oracle/WASM follow-up preflight was refused as capacity changed. One
bounded admission waiter remains for combined oracle execution and fresh
retained/default WASM confirmation. Those checks are not reported as passes.
Original request/job IDs, receipt paths and remaining commands are recorded in
validation.json; inspect submitted requests rather than resubmitting them.
No foreign output or job was reclaimed,
interrupted or signalled, and no guard was relaxed.

Historical qualification remains available at the previousEvidence source pin
in validation.json. Its runtime, toolchain, coverage gaps and skips describe
that older source, rather than this merged head. End-to-end worker-pool timing
and whole-host memory remain unmeasured.
