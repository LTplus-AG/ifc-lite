# @ifc-lite/merge

## 0.3.1

### Patch Changes

- [#1742](https://github.com/LTplus-AG/ifc-lite/pull/1742) [`da19eb6`](https://github.com/LTplus-AG/ifc-lite/commit/da19eb6e6f56384112b71344178d0a317b9986c5) Thanks [@louistrue](https://github.com/louistrue)! - Merging a candidate that is already on the target ref now no-ops (fast-forward with the ref unchanged) instead of refusing with unrelated-base. Published drafts land on their home ref with a declared base equal to the composition they were authored against, which need not be representable on the ref, so re-merging them previously dead-ended. Registry merge previews now also report `ancestor_matched` so clients can warn before an execute would be refused.

## 0.3.0

### Minor Changes

- [#1732](https://github.com/LTplus-AG/ifc-lite/pull/1732) [`5e90494`](https://github.com/LTplus-AG/ifc-lite/commit/5e904942e3fd167d0d0e1a9c37b391d638eb6932) Thanks [@louistrue](https://github.com/louistrue)! - Registry webhooks + auto-merge (08-review.md §8.7, 10-registry.md §10.4): the registry emits HMAC-SHA256-signed events (layer pushed, ref moved/merged, review opened/updated/commented) to configured consumers, and `RefPolicy.autoMerge` merges conflict-free, all-checks-green candidates with a declared base unattended on push — fail-closed with `requireHumanApproval` and for baseless candidates.

## 0.2.0

### Minor Changes

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - Layer PRs foundation (docs/architecture/layer-prs):

  - **ifcx**: deletion-overlay tombstones (`ifclite::deleted`) with shadow/resurrect semantics and child-path shadowing in both composition engines; `bakeLayers` tombstone-free materialization; canonical serialization with blake3 content addressing (`computeLayerId`, `computeStackHash`); provenance manifest v1 (`createProvenanceManifest`, `getProvenance`/`setProvenance`, `validateProvenance`).
  - **diff**: opt-in per-componentKey sub-hash mode (`buildComponentFingerprints`) and `changedComponents` on diff entries; the whole-blob `dataHash` default is unchanged.
  - **extensions**: scope-claim grammar — capability expressions extended with entity selectors (`model.mutate:Pset_FireSafety*@IfcWall&storey=EG`), with grant-coverage and op-level enforcement matching.
  - **mutations**: `changeSetToOps` expressId→GlobalId bridge with blake3 content-derived identity fallback recorded for the manifest `identity_map`.
  - **collab**: `extractMinimalLayer` now expresses deletions (entity tombstones plus `null` removals), closing the documented additive-only deferral; new `publishLayer` freezes a draft into an immutable, content-addressed, provenance-stamped layer.
  - **merge** (new package): three-way merge engine over (entity, componentKey) states with explicit conflict records, resolution application, merge-layer emission with `manifest.merge`, revert (inverse-op layers), and rebase.

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - Layer registry v1 (10-registry.md):

  - **merge**: the ref-merge flow (fast-forward, three-way planning, ref-policy enforcement, unrelated-base refusal) moved into `@ifc-lite/merge` as store-agnostic `mergeIntoRef`/`resolveAncestor`/`checkRefPolicy` over a `LayerRefStore` interface — the CLI and the registry run one decision procedure.
  - **collab-server**: opt-in `layerRegistry` mounts `/api/v1/layers|refs|reviews` — push with a server-side blake3 integrity gate (id recomputed, provenance validated), pull by id, refs with policies (policy-protected refs move only through the merge endpoint, where required checks and approval rules run), and review (PR) objects. Authorization derives from the websocket `authenticate` hook like the blob route: one token scheme for sync, blobs, and the registry; writes require write capability.
  - **cli**: `layer merge` now delegates to the shared flow (behavior unchanged).

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - Three-way planning meets the 05 §5.7 budget: a prefix projection fast path plans two 50k-op layers over a 1M-entity model in ~0.6s (was ~11.6s). When ours/theirs extend the ancestor stack, only suffix-touched paths are folded and hashed; untouched components share references and short-circuit on reference equality. Tombstone-bearing stacks keep the reference full extraction, with a differential fuzz suite enforcing equivalence between the two paths. Adds real-model partition fuzz (hello-wall + WekaHills fixtures) and `pnpm --filter @ifc-lite/merge bench`.

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - The layer-diff JSON is now one shared contract: `diffStackStates`/`diffLayerStacks` (`StackDiff` shape, deterministically ordered) live in `@ifc-lite/merge`, and the CLI `layer diff` command and the MCP `diff_layer` tool consume the identical implementation — the two previously separate copies had already drifted on ordering. A byte-exact contract test pins the wire shape the review UI will consume.

### Patch Changes

- Updated dependencies [[`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486)]:
  - @ifc-lite/ifcx@2.3.0
  - @ifc-lite/diff@0.4.0
