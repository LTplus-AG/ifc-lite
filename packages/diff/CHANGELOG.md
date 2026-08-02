# @ifc-lite/diff

## 0.5.0

### Minor Changes

- [#1961](https://github.com/LTplus-AG/ifc-lite/pull/1961) [`15f5335`](https://github.com/LTplus-AG/ifc-lite/commit/15f53357f30a38d6aef7c9e4394c14400f5222e5) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Add opt-in content-keyed matching to `diffModels` for comparing model revisions where GlobalIds are unreliable (issue [#1891](https://github.com/LTplus-AG/ifc-lite/issues/1891)). A model re-exported from scratch gets entirely new GlobalIds, so the existing GlobalId-keyed diff reports every element as deleted-and-added even when nothing substantive changed.

  Pass `{ matchUnpairedByContent: true }` to run a second pass, after the normal key-based pass, over the entities that came out `added`/`deleted`. It buckets them by `EntityFingerprint.dataHash` and reports the result via the new `ModelDiff.contentMatches: ContentMatch[]` field:

  - exactly one leftover base entity and one leftover head entity sharing a data hash is an unambiguous match, reported as `renamed` (geometry hash also agrees — only the identity changed) or `moved` (it doesn't). The corresponding `added`/`deleted` pair is removed from `entries`/`byKey`/`counts` in favor of this single record. Under `scope: 'data'`, where the caller has excluded geometry from the comparison, every 1:1 match is reported as `renamed` rather than deriving `moved` from an out-of-scope signal.
  - more than one candidate on either side is `duplicated` (one base entity, several head entities), `deduplicated` (several base entities, one head entity), or `ambiguous` (more than one on both sides).

  **Collision policy.** `dataHash` is a 32-bit FNV-1a value — collisions between genuinely different content are reachable rather than theoretical, and the tests pin three real ones. The 1:1 path is the only destructive one — it retires a real `added` and a real `deleted`. It therefore also requires the two entities to agree on `ifcType` (already part of the hashed payload, so this can never reject a genuine match) and, when both sides supply `components`, on every component sub-hash. This narrows the window without closing it: FNV-1a's per-character update is a bijection on its 32-bit state, so a collision between two entities differing only in `Name` also collides `attr:core` and is undetectable here. The component check bites when the differing content sits in a pset/qset slice. Ambiguous groups retire nothing, so a collision landing in one only costs an extra candidate to inspect.

  **Ambiguity policy.** Ambiguous/duplicated/deduplicated groups are reported as-is — every candidate on both sides, via `ContentMatch.base`/`.head` — and the original `added`/`deleted` entries are left untouched in `entries` rather than collapsed into a guessed pairing. The alternative considered and rejected was picking the first candidate on each side (`candidates[0]`-style); the repo shipped exactly that class of silent-pick bug last week ([#1923](https://github.com/LTplus-AG/ifc-lite/issues/1923)), and there is no principled way to decide _which_ base entity became _which_ head entity when several share a content hash. Resolving the group to a specific pairing, if desired, is left to the caller.

  `DiffState`/`DiffEntry` are deliberately unchanged — a content match is reported only via the new `contentMatches` field, never by inventing a new `DiffEntry.state`, so an existing exhaustive `switch`/`Record` over `DiffState` elsewhere in a consumer keeps compiling unmodified.

  Split and Merged (detecting a _partial_ geometric overlap between one entity and several others, as requested in [#1891](https://github.com/LTplus-AG/ifc-lite/issues/1891)) are deliberately not implemented: they need a geometric-similarity threshold and a policy for partial overlap that has no single correct answer. Left for a follow-up once that policy is decided.

  Default `false` (unset) — existing callers of `diffModels` get byte-identical results; this is purely additive.

  Not wired into the viewer's Compare panel, the MCP `diff` tool, or the CLI in this change — those are separate reviews.

## 0.4.0

### Minor Changes

- [#1027](https://github.com/LTplus-AG/ifc-lite/pull/1027) [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486) Thanks [@louistrue](https://github.com/louistrue)! - Layer PRs foundation (docs/architecture/layer-prs):

  - **ifcx**: deletion-overlay tombstones (`ifclite::deleted`) with shadow/resurrect semantics and child-path shadowing in both composition engines; `bakeLayers` tombstone-free materialization; canonical serialization with blake3 content addressing (`computeLayerId`, `computeStackHash`); provenance manifest v1 (`createProvenanceManifest`, `getProvenance`/`setProvenance`, `validateProvenance`).
  - **diff**: opt-in per-componentKey sub-hash mode (`buildComponentFingerprints`) and `changedComponents` on diff entries; the whole-blob `dataHash` default is unchanged.
  - **extensions**: scope-claim grammar — capability expressions extended with entity selectors (`model.mutate:Pset_FireSafety*@IfcWall&storey=EG`), with grant-coverage and op-level enforcement matching.
  - **mutations**: `changeSetToOps` expressId→GlobalId bridge with blake3 content-derived identity fallback recorded for the manifest `identity_map`.
  - **collab**: `extractMinimalLayer` now expresses deletions (entity tombstones plus `null` removals), closing the documented additive-only deferral; new `publishLayer` freezes a draft into an immutable, content-addressed, provenance-stamped layer.
  - **merge** (new package): three-way merge engine over (entity, componentKey) states with explicit conflict records, resolution application, merge-layer emission with `manifest.merge`, revert (inverse-op layers), and rebase.

## 0.3.2

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

## 0.3.1

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

## 0.3.0

### Minor Changes

- [#1559](https://github.com/LTplus-AG/ifc-lite/pull/1559) [`d942bed`](https://github.com/LTplus-AG/ifc-lite/commit/d942bedffe31d0a682c1aa8bb9fe3e3dc0f63104) Thanks [@louistrue](https://github.com/louistrue)! - Add `excludeTypes` to `diffModels` - a blacklist of IFC classes to leave out of the comparison entirely (issue [#1470](https://github.com/LTplus-AG/ifc-lite/issues/1470)). An entity whose `ifcType` matches is dropped from both revisions before matching, so it never appears in `entries`, `byKey`, or `counts`. This is how the viewer's Compare panel lets a user ignore connective noise like `IfcOpeningElement` (the void a removed window leaves behind), which reads as a spurious deletion on its own. Matching is case-insensitive and trims whitespace; the applied, normalized blacklist is echoed on the result as `ModelDiff.excludedTypes` (empty when nothing was excluded). Backward compatible: omitting `excludeTypes` is unchanged behaviour.

## 0.2.1

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.

## 0.2.0

### Minor Changes

- [#939](https://github.com/LTplus-AG/ifc-lite/pull/939) [`90060b7`](https://github.com/LTplus-AG/ifc-lite/commit/90060b7eaad7a07bdab13907c1b52bb24fbc8597) Thanks [@louistrue](https://github.com/louistrue)! - New package `@ifc-lite/diff`: a headless, store-agnostic model-diff engine.
  `diffModels` classifies entities across two revisions as added / modified /
  deleted / unchanged, with a `scope` toggle (`data` | `geometry` | `both`) that
  selects whether attribute/property differences, geometry-fingerprint
  differences, or both count as a modification. Ships `buildDataFingerprint` (a
  canonical, order-independent data hash) and consumes the RTC-invariant geometry
  hashes exposed from the WASM mesh pass.
