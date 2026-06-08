# @ifc-lite/diff

## 0.2.0

### Minor Changes

- [#939](https://github.com/LTplus-AG/ifc-lite/pull/939) [`90060b7`](https://github.com/LTplus-AG/ifc-lite/commit/90060b7eaad7a07bdab13907c1b52bb24fbc8597) Thanks [@louistrue](https://github.com/louistrue)! - New package `@ifc-lite/diff`: a headless, store-agnostic model-diff engine.
  `diffModels` classifies entities across two revisions as added / modified /
  deleted / unchanged, with a `scope` toggle (`data` | `geometry` | `both`) that
  selects whether attribute/property differences, geometry-fingerprint
  differences, or both count as a modification. Ships `buildDataFingerprint` (a
  canonical, order-independent data hash) and consumes the RTC-invariant geometry
  hashes exposed from the WASM mesh pass.
