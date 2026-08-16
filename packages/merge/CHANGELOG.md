# @ifc-lite/merge

## 0.4.2

### Patch Changes

- Updated dependencies [[`5086c57`](https://github.com/LTplus-AG/ifc-lite/commit/5086c5729b6ae8ad967aafa91d96dfdb37327599)]:
  - @ifc-lite/diff@0.7.0
  - @ifc-lite/ifcx@2.3.6

## 0.4.1

### Patch Changes

- [#2278](https://github.com/LTplus-AG/ifc-lite/pull/2278) [`6635ddf`](https://github.com/LTplus-AG/ifc-lite/commit/6635ddfa91911b0fbc489452c02cf19e232201c3) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `componentKeyForAttribute` silently misclassifying a custom-named (not `Pset_`/`Qto_`-prefixed) property or quantity set, breaking whole-set tombstone lookups for it, and fix a member deletion on such a set being routed to a different component than the value it targets — so the member survived the delete.

  `componentKeyForAttribute` bucketed a `bsi::ifc::v5a::<Set>::<Member>` attribute as `pset:<Set>`/`qset:<Set>` only when `<Set>` matched a literal `Pset_`/`Qto_` prefix, falling back to a one-off-per-attribute `attr:<key>` bucket for any other name. `packages/mutations/src/change-set-to-ops.ts` builds `pset:<name>`/`qset:<name>` component keys unconditionally from the mutation type, for any author-chosen name, and `@ifc-lite/collab`'s structured-attribute inflation already disambiguates a custom set name by value shape (typed record -> pset, plain finite number -> quantity) — its own doc comment describes that as a convention "the merge engine's `pset:`/`qset:` component keys... already share", which this package didn't actually hold up.

  The observable break: `apps/viewer/src/lib/layers/publish.ts`'s `buildDeltaNodes` resolves a whole-component tombstone (`DELETE_PROPERTY_SET`/`DELETE_QUANTITY_SET`) by looking up the base state's members under `pset:<name>`/`qset:<name>`. For a custom-named set, that lookup found nothing (the members lived under `attr:<key>` instead), so zero attributes were nulled — deleting a custom-named property set silently did nothing at all, no error, no diagnostic.

  `componentKeyForAttribute` now takes the attribute's value and disambiguates a custom set name by the same shape rule `@ifc-lite/collab` uses. A `null` value (an in-flight single-member deletion, as opposed to a whole-component tombstone) still carries no shape to go on, so that path is unchanged.

- Updated dependencies [[`a220406`](https://github.com/LTplus-AG/ifc-lite/commit/a2204062ba1fc555e4529896cbc82efccc7a5146), [`c866bee`](https://github.com/LTplus-AG/ifc-lite/commit/c866bee62a7d6e40b15a7de63948354cbbe049a7), [`262b9df`](https://github.com/LTplus-AG/ifc-lite/commit/262b9df485e4bfd3760f73c30d93bb518e599b72)]:
  - @ifc-lite/ifcx@2.3.4

## 0.4.0

### Minor Changes

- [#1987](https://github.com/LTplus-AG/ifc-lite/pull/1987) [`ed63063`](https://github.com/LTplus-AG/ifc-lite/commit/ed63063c952bd1804ce83922da80635f03c77193) Thanks [@louistrue](https://github.com/louistrue)! - **diff**: widen `stableHash` from 32-bit to 64-bit FNV-1a (offset basis `0xcbf29ce484222325`, prime `0x100000001b3`, the same offset basis and prime as `rust/processing/src/determinism.rs`, though not byte-compatible with it: this walks UTF-16 code units and the Rust side hashes bytes, so only ASCII input agrees). Output is now 16 zero-padded lowercase hex chars instead of up to 8.

  `matchUnpairedByContent` treats `dataHash` equality as identity — its 1:1 branch retires a real `added` and a real `deleted` — and 32 bits was too narrow for that: collisions between plausible IFC content were findable by enumeration, and exposure grows with the square of the number of fingerprints compared.

  **diff**: `buildDataFingerprint` and `buildComponentFingerprints` no longer hash the assigned type's `GlobalId`; an assigned type is now identified by its `name` and its IFC class. `IfcTypeObject` is an `IfcRoot`, so a from-scratch re-export regenerates the _type's_ GlobalId along with every product's — which changed the content hash of every _typed_ element (walls, doors, windows: most of a real model) on exactly the re-export where nothing substantive changed, and made those elements unable to content-match. `TypeAssignmentInput.globalId` is kept as a field and still accepted, it just no longer participates in any hash. The trade is a real loss of discrimination: two _different_ type entities that share a name and an IFC class now look identical, so re-pointing an element between them does not move its `dataHash`. That needs duplicate type names within one class, and only shows on elements otherwise identical in every attribute, property and quantity.

  **Every fingerprint value changes.** `stableHash`, `buildDataFingerprint`, and `buildComponentFingerprints` all return different strings for the same input than they did before. Nothing in this repo persists these values — base and head are always fingerprinted by the same build, so a normal diff or merge is unaffected — but any caller that has stored fingerprints across sessions and compares old values to new ones must recompute them. Comparing a pre-upgrade hash with a post-upgrade one reports everything as changed.

  **merge**: `snapshotOf` is built on `@ifc-lite/diff`'s `stableHash`, so the `hash` on every `ComponentSnapshot` it returns — and on the `ComponentSnapshot`s carried by `MergeConflict` — changes value with this release. Nothing about the API's shape or its equality semantics changes: two snapshots of the same attributes still hash equal, and a merge or conflict detection run entirely on this version behaves exactly as before. **Stored snapshots do not compare equal across the upgrade**: a hash persisted by an older version will not match the one this version computes for the same attributes, and any comparison that spans the two reports a spurious difference. Recompute rather than migrate. This is an explicit `minor` rather than the automatic dependency `patch` changesets would otherwise apply, because the observable output of a public export changed.

  The collision guards in `diffModels` (bucket by `ifcType`, require `components` agreement) are unchanged, as is the documented residual: a collision confined to `attr:core` still cannot be detected, because FNV-1a's per-character update is a bijection on its state at any width. `buildComponentFingerprints` deliberately drops the type's `GlobalId` too, rather than keeping it as extra collision evidence: the guard's soundness rests on components hashing slices of exactly what `dataHash` hashes whole, and a `type-assignment` sub-hash that saw the GlobalId would veto the genuine re-export matches this release enables.

### Patch Changes

- Updated dependencies [[`d42fbf1`](https://github.com/LTplus-AG/ifc-lite/commit/d42fbf1c7a4abed637b7e80e28cbed69088bc943), [`0adb741`](https://github.com/LTplus-AG/ifc-lite/commit/0adb7413b869c9d50bdcdae5c00a730d17c2823f), [`0adb741`](https://github.com/LTplus-AG/ifc-lite/commit/0adb7413b869c9d50bdcdae5c00a730d17c2823f), [`dc000cf`](https://github.com/LTplus-AG/ifc-lite/commit/dc000cff25a647d2a224f34a063f84b3d2d84ca8), [`2716893`](https://github.com/LTplus-AG/ifc-lite/commit/2716893ac9d825fc529f3fd8164d9a6f766e87f8), [`620f4d2`](https://github.com/LTplus-AG/ifc-lite/commit/620f4d2100b397d33d2e61440950b7a31660dbb8), [`7261f1a`](https://github.com/LTplus-AG/ifc-lite/commit/7261f1a6a8595350d3ec400212e293a8924d57bf), [`ed63063`](https://github.com/LTplus-AG/ifc-lite/commit/ed63063c952bd1804ce83922da80635f03c77193)]:
  - @ifc-lite/diff@0.6.0

## 0.3.2

### Patch Changes

- Updated dependencies [[`15f5335`](https://github.com/LTplus-AG/ifc-lite/commit/15f53357f30a38d6aef7c9e4394c14400f5222e5)]:
  - @ifc-lite/diff@0.5.0

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
