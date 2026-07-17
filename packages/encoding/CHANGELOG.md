# @ifc-lite/encoding

## 1.14.11

### Patch Changes

- [#1773](https://github.com/LTplus-AG/ifc-lite/pull/1773) [`0d400ed`](https://github.com/LTplus-AG/ifc-lite/commit/0d400edd61a71108c2affd0923fb561affbfe9fe) Thanks [@louistrue](https://github.com/louistrue)! - Harden IFC string decoding, material-usage resolution, the worker scanner, and the binary cache.

  - encoding: `decodeIfcString` no longer throws a `RangeError` on a `\X4\` sequence whose 8-hex value exceeds the Unicode maximum (`0x10FFFF`); it now emits U+FFFD instead. The previous throw propagated uncaught through the columnar batch-name path and aborted the entire model load. Surrogate values in `\X4\` and lone surrogates in `\X2\` also decode to U+FFFD now (surrogate pairs split across `\X2\` groups still combine), matching the Rust decoder (`char::from_u32` / `String::from_utf16_lossy`) so both parse paths yield identical strings.
  - parser: `onDemandMaterialMap` is now list-valued, so a second `IfcRelAssociatesMaterial` targeting the same element is preserved instead of last-wins overwritten. `buildMaterialUsageIndex` gains a relationship-graph fallback for server-loaded stores: it works on the real server store shape (empty `source` buffer, facade relationship graph with closure-only accessors), with `collectMaterialLeaves` surfacing each definition as one opaque full-weight leaf when no source is available. An empty index built from a store with no material inputs at all is no longer memoised (so a later-populated store can rebuild). `IfcMaterialConstituent` weights now always sum to 1: siblings without an explicit `Fraction` share the remainder instead of collapsing to weight 0, sets where explicit fractions already fill the whole are renormalised (`{1.0, unset}` -> 2/3, 1/3 rather than 1.5x totals), and non-finite or non-positive fractions/layer thicknesses are treated as unset.
  - parser: the inline worker scanner's type-name cache now byte-verifies on a hit (matching `tokenizer.ts`), so a 32-bit hash collision can no longer alias two distinct type names on the default scan path.
  - parser: batch GlobalId+Name extraction now collapses STEP doubled single-quotes (`''` -> `'`), matching `EntityExtractor`, so names like `John''s Wall` render correctly.
  - cache: the writer no longer sets the dead `HasSpatial` header flag (no Spatial section is written or read), and the string-table read path preserves positions via `StringTable.fromArray` instead of re-interning (which deduped, shifting later indices when a duplicate was present). On-disk format is unchanged.

## 1.14.10

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

## 1.14.9

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

## 1.14.8

### Patch Changes

- [#1500](https://github.com/LTplus-AG/ifc-lite/pull/1500) [`a46dcdf`](https://github.com/LTplus-AG/ifc-lite/commit/a46dcdf68d05e8cdec4199167647f2dfa3c62cb6) Thanks [@louistrue](https://github.com/louistrue)! - fix(encoding): stop `\S\` decoding from diverging / panicking on multi-byte input

  The `\S\C` STEP escape (code point of `C` plus 128) is spec-defined for a single
  ASCII `C`, but a malformed-but-UTF-8 file can put a multi-byte `C` there.
  `decodeIfcString` now reads `C` as a whole code point (advancing past a surrogate
  pair) instead of one UTF-16 unit, so it no longer leaves a dangling surrogate and
  stays in parity with the Rust `decode_ifc_string`, whose matching fix also stops
  a multi-byte `C` from panicking mid-slice (which aborts the wasm instance). Pinned
  by a new non-BMP `\S\` case in the shared `ifc_string_vectors.json` fixture.

## 1.14.7

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.

## 1.14.6

### Patch Changes

- [#494](https://github.com/louistrue/ifc-lite/pull/494) [`ec0d3a0`](https://github.com/louistrue/ifc-lite/commit/ec0d3a0e4c7f9eaeb26ab0a724fd76d955e52ac5) Thanks [@louistrue](https://github.com/louistrue)! - Remove recursive package `prebuild` hooks and run TypeScript via `pnpm exec` so workspace builds resolve correctly on Windows.

## 1.14.5

### Patch Changes

- [#461](https://github.com/louistrue/ifc-lite/pull/461) [`6ce40dd`](https://github.com/louistrue/ifc-lite/commit/6ce40ddb0cace5f83c2438d2d4c4bd47703468f7) Thanks [@louistrue](https://github.com/louistrue)! - Clean up package build health for georeferencing work by fixing parser generation issues, making export tests resolve workspace packages reliably, removing build scripts that masked TypeScript failures, tightening workspace test/build scripts, productizing CLI LOD generation, centralizing IFC GUID utilities in encoding, and adding mutation test coverage for property editing flows.

## 1.14.4

### Patch Changes

- [#357](https://github.com/louistrue/ifc-lite/pull/357) [`40bf3d0`](https://github.com/louistrue/ifc-lite/commit/40bf3d00cb5d5ef3512b96cd5e066442adcaab87) Thanks [@louistrue](https://github.com/louistrue)! - Improve IFC STEP string handling by implementing robust decode support for `\\S\\`, `\\X\\`, `\\X2\\...\\X0\\`, `\\X4\\...\\X0\\`, and `\\P.\\` directives, and add `encodeIfcString` for producing STEP-safe string escapes.

## 1.14.3

## 1.14.2

## 1.14.1

## 1.14.0

## 1.13.0

## 1.12.0

## 1.11.3

## 1.11.1

## 1.11.0

## 1.10.0

## 1.9.0

## 1.8.0

## 1.7.0

### Minor Changes

- [#196](https://github.com/louistrue/ifc-lite/pull/196) [`0967cfe`](https://github.com/louistrue/ifc-lite/commit/0967cfe9a203141ee6fc7604153721396f027658) Thanks [@louistrue](https://github.com/louistrue)! - Add @ifc-lite/encoding and @ifc-lite/lists packages

  - `@ifc-lite/encoding`: IFC string decoding and property value parsing (zero dependencies)
  - `@ifc-lite/lists`: Configurable property list engine with column discovery, presets, and CSV export
  - Both packages expose headless APIs via `ListDataProvider` interface for framework-agnostic usage
  - Viewer updated to consume these packages via `createListDataProvider()` adapter
