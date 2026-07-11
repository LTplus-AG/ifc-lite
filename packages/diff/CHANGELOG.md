# @ifc-lite/diff

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
