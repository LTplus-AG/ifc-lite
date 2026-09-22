# @ifc-lite/rules

## 0.2.0

### Minor Changes

- [#5169](https://github.com/LTplus-AG/ifc-lite/pull/5169) [`06a336d`](https://github.com/LTplus-AG/ifc-lite/commit/06a336d512fc4470cb7372b33a5f8eea2aa1c070) Thanks [@louistrue](https://github.com/louistrue)! - New package: the filter-rule vocabulary, the Path-B rule evaluator, and the `.rules.json` information-validation engine (`runRuleSet`), extracted from the viewer's Advanced Filter / Data Validation panel ([#5138](https://github.com/LTplus-AG/ifc-lite/issues/5138) PR 7a) so `packages/cli` can run the identical evaluator against the same rule sets. No React, no store, no DOM.
  
  `@ifc-lite/viewer` is a private, unpublished app and gets no changeset entry — its import paths for this code moved from `lib/search`/`lib/validation` to `@ifc-lite/rules`, but that is an internal refactor with no published-API surface of its own.

### Patch Changes

- Updated dependencies [[`f87bed2`](https://github.com/LTplus-AG/ifc-lite/commit/f87bed29a52610b66b3d0ee510406ce087a66621), [`bef4149`](https://github.com/LTplus-AG/ifc-lite/commit/bef41495ccdcf1dbc8e5024f633c74b44ccef137), [`04ef10f`](https://github.com/LTplus-AG/ifc-lite/commit/04ef10fef50f8e53e96430741afc27a69ebff906)]:
  - @ifc-lite/mutations@2.6.0
  - @ifc-lite/ids@2.0.0
