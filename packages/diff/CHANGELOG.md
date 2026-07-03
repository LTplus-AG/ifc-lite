# @ifc-lite/diff

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
