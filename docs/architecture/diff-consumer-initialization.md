# Diff consumer initialization (#8042)

The Rust facade keeps diff, fingerprint, lineage, sidecar and hash operations
synchronous. Its caller first awaits the shared `initDiff()` export from
`@ifc-lite/diff`. Repeated callers use the same runtime initialization; consumers
must not cache a rejected promise, catch initialization failure as an empty diff,
or load a second copy of the bindings. There is no application top-level await.

## Application boundaries

| Consumer | Initialization boundary | Synchronous work covered |
| --- | --- | --- |
| CLI content diff | `contentDiffCommand`, before incoming sidecars and fingerprints | `buildFileFingerprints`, sidecar/lineage helpers, `diffModels` and report sidecars |
| CLI table rekey | `rekeyCommand`, before reading/parsing the lineage | `parseLineageSidecar`, `rekeyRows` / `rekeyByLineage` |
| CLI layer commands | `layerDiffCommand`, `layerMergeCommand`, `layerRevertCommand`, `layerRebaseCommand` | shared merge diff/planning/inverse/rebase and `snapshotOf` |
| MCP model comparison | `model_diff.handler`, for `by_content` only, before session overlays are captured | `buildModelFingerprints`, `contentDiff` / `diffModels` |
| MCP layer review | `diff_layer`, `dry_run_merge`, `list_conflicts` async handlers | `diffStackStates`, `planThreeWayMerge` |
| Viewer comparison | `buildEntityFingerprints` | data/component hashes and placement hashes; canonical `prepareComparison` callers and cached synchronous `comparePreparedPair` re-diffs |
| Viewer sidecar import/export | `comparedModelIdentities`, before returning pinned identities | parse/validate/serialize identity and lineage sidecars, including saved results without a fresh comparison |
| Viewer local layer merges | `previewMergeInto`, `executeMergeInto`, before the local merge | `mergeIntoRef` and snapshots; registry merges initialize on the server |
| Viewer layer contribution | `computeLayerContribution` | `diffLayerStacks` and snapshots |
| Collab registry | authorized layer-push / ref-merge POST routes, before writes | explicit review merges and push-triggered `runAutoMerges` |
| Cross-match harness | async `fingerprintFile` | CLI fingerprint adapter, then synchronous `realMatcher` in the same process |

The viewer's other runtime imports (`identitySidecar`, `suggestions`, accepted
identity helpers and compare row labels) use synchronous facade helpers or
constants. Comparison-derived helpers run after preparation. Independent sidecar actions
await `comparedModelIdentities`; initialization failure returns its existing
error union for display and a subsequent action retries.

`worldPlacementFingerprint` hashes a composed placement only in fingerprint
extraction. Other consumers of `composeWorldPlacement` do not invoke `stableHash`.
Type-only diff imports across compare views, stores, reports, geometry and MCP
adapters require no initialization.

`@ifc-lite/merge` has one production diff import: `component-state.snapshotOf`
uses `stableHash`. `three-way`, `state-diff` and `inverse` call `snapshotOf`;
ref flow, rebase and merge-layer orchestration reach those modules transitively.
`extractStackState` itself stores raw component maps and does not hash. Therefore
layer publishing, scope verification and viewer `buildDeltaNodes` that merely
extract state do not require initialization. The threejs example has a private
fingerprint implementation; its mentions of `@ifc-lite/diff` are documentation,
not runtime imports. It is outside this consumer change.

## Synchronous caller obligations

These entrypoints retain their signatures and cannot await initialization:

- Diff facade APIs, CLI `buildFileFingerprints`, MCP
  `buildModelFingerprints` / `contentDiff`, viewer `worldPlacementFingerprint`
  and `comparePreparedPair` when called with independently constructed inputs.
- Merge `snapshotOf`, `diffStackStates`, `diffLayerStacks`,
  `planThreeWayMerge`, `planFromStates`, `opsForComponentChange`, inverse/revert,
  rebase and `mergeIntoRef`, including synchronous CLI wrappers/re-exports.
- Direct synchronous fixtures and tests. CLI/MCP adapter tests and real merge
  tests use an actual runtime `beforeAll`; the viewer's existing test preload
  registers a `node:test` async `before` hook for saved-comparison, placement and
  layer fixtures. No new test substitutes fake bindings. The existing deliberate
  hash-collision test remains a collision injection test.

External library consumers initialize explicitly, or use `initDiffSync` with
preloaded bytes/a compiled module. No synchronous library API starts a hidden
async load or falls back to a TypeScript engine.

## Runtime loading and standalone tools

The shared runtime resolves `@ifc-lite/wasm/diff_bg.wasm` to file bytes under
Node, where `fetch(file:)` is unsupported. Browser initialization uses the
wasm-bindgen asset URL. Initialization failure clears the shared pending promise
so a later application request can retry; readiness is set only after successful
instantiation. Importing the facade does not initialize it.

Vector generators load the preserved TypeScript oracle from
`packages/diff/test/oracle` through `scripts/lib/diff-oracle.mjs`. They never
regenerate expected results using the Rust implementation under test.
`scripts/diff-real-fixture-parity.mjs` initializes the public facade before
building fingerprints and compares Rust results against that independent oracle.
The standalone merge benchmark also initializes before planning.

## Verification

CLI `diff-initialization.test.ts` runs fresh Node processes against built
production modules. It checks that synchronous hashes reject before init,
invalid WASM loading fails, and canonical content-diff and layer commands recover
through shared initialization. Runtime tests cover concurrent callers and retry;
consumer tests initialize the actual WASM module before checking their model and
merge invariants. These tests require a freshly built independent diff runtime.
Browser asset resolution and retry must also be verified against the built viewer;
Node-only initialization checks cannot establish browser loading behavior.
