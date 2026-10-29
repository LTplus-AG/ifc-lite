<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# C4-11a content-install lifetime (#7782)

Stack base: C4-10a `6b977a14eee2a276e71ea46f8b5184f8fd6395a8`, draft #8316,
stacked on #8309. This lane does not modify `batch.rs` or adopt C4-11b's slot/mode
model. The executable call-order fixture was committed in `d1be601af1` before
reset code changed.

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
- `setSourceBytes` keeps the existing source-epoch/BRep/diagnostic invalidation,
  retaining the index and columns already installed by workers. It must be
  paired with index/prepass installation for a new file.
- `clearPrePassCache` expires snapshots and drops derived state, source and both
  finish stores, preserving diagnostics and persistent settings.

## Witnesses and boundaries

The native tests decode a textured, typed, layered file and an unrelated file
with colliding ids, verifying rebuilt texture/type/layer results and stale-source
refusal. Additional witnesses cover finish transaction consumption, cleanup,
source/index ordering and persistent settings. Real WASM tests compare reused
and fresh APIs on colliding style signatures, shape and colour changes, authored
finish removal, streaming abort, SAB and owned-buffer retries. Existing C4-10a
BRep collision witnesses and the C4-0 full payload gate remain unchanged.

`behaviour.oracle.patch` is applied in reverse: it removes only content reset
from `begin_content_install`, retaining APIs and test wiring. The top CI oracle
branch selects the new native witnesses. `validate.sh mutation` requires actual
assertion failures, restores the patch and requires green again.

Performance verdict: correctness change at explicit load boundaries. No
end-to-end worker-pool timing or speedup claim. Successful single-file output is
qualified by C4-0; browser timing and whole-host memory qualification are not
established by these focused tests. Native Rust processing is untouched.
