# @ifc-lite/encoding

## 2.0.0

### Major Changes

- [#2501](https://github.com/LTplus-AG/ifc-lite/pull/2501) [`b4b3e0c`](https://github.com/LTplus-AG/ifc-lite/commit/b4b3e0cfa8ffa9185e96dc266dd6fdc3fef34797) Thanks [@louistrue](https://github.com/louistrue)! - Stop decoding STEP strings a second time at display

  `parsePropertyValue` decoded its input, but every producer of a property value
  already decodes exactly once at the parse boundary — `EntityExtractor` /
  `columnar-parser-attributes.ts` on the TypeScript path,
  `AttributeValue::from_token` on the Rust/WASM and server paths.

  That double decode was harmless while `decodeIfcString` passed `\\` through
  untouched. Since [#2394](https://github.com/LTplus-AG/ifc-lite/issues/2394) the decoder correctly collapses `\\` to `\`, which makes
  it non-idempotent: an authored UNC path `\\server\share` is stored, exported and
  round-tripped correctly but was **displayed** as `\server\share`. `C:\temp` is a
  fixed point of the decoder, which is why the defect hid on the common case.

  Making the decoder idempotent is not the alternative: idempotence requires
  treating an already-decoded `\` and an authored, still-doubled `\\` alike, which
  is exactly the ambiguity [#2394](https://github.com/LTplus-AG/ifc-lite/issues/2394) removed. The invariant is "decode once, at the
  parse boundary".

  **Behaviour change for callers outside this repo.** If you were handing
  `parsePropertyValue` a _still-encoded_ STEP literal, it decoded it for you and
  now returns it unchanged: `'Br\X2\00FC\X0\cke'` comes back as written rather
  than as `Brücke`. Decode at your parse boundary instead —
  `parsePropertyValue(decodeIfcString(literal))` — with `decodeIfcString` still
  exported for exactly that. Every in-repo caller (the viewer's property and
  quantity cards, `filter-match`, `@ifc-lite/lists`) sits downstream of a parse
  path that already decoded, so none of them changes meaning. The package README's
  `parsePropertyValue` entry is corrected in this PR; it said "raw STEP property
  values", which is what made the second decode look intended.

  Bump level: `major`, on a >= 1.0 package. No export is added, removed or renamed
  and no signature changes — but the DOCUMENTED INPUT changes, and that is the
  distinction against the earlier `patch` corrections this package has shipped.
  [#2394](https://github.com/LTplus-AG/ifc-lite/issues/2394) (`decodeIfcString` collapses `\\`), [#1773](https://github.com/LTplus-AG/ifc-lite/issues/1773) (`\X4\` out-of-range throws →
  U+FFFD) and [#1500](https://github.com/LTplus-AG/ifc-lite/issues/1500) (`\S\` multi-byte) each fixed what the function returned for
  the SAME documented input; here the README moves from "raw STEP property values"
  to "a parsed STEP property value", so a caller who followed the old README and
  kept working code now gets a wrong answer with no error. A silent break needs a
  louder version than a loud one, and the migration is one call:
  `parsePropertyValue(decodeIfcString(literal))`.

## 1.16.0

### Minor Changes

- [#2497](https://github.com/LTplus-AG/ifc-lite/pull/2497) [`7c686f9`](https://github.com/LTplus-AG/ifc-lite/commit/7c686f9ac39f78a707dc083c798b6ef3d255e171) Thanks [@louistrue](https://github.com/louistrue)! - `parseStepValue` decodes ISO 10303-21 backslash directives, and the decoder that does it now lives in one place ([#2490](https://github.com/LTplus-AG/ifc-lite/issues/2490)).

  **What changes for a caller.** `@ifc-lite/data`'s `parseStepValue` un-doubled the two lexical doublings (`''` and `\\`) with a directive-blind pair of regexes and stopped there, so a string literal taken from a real IFC file came back with its directives intact: `'\X2\00FC\X0\'` returned those nine characters where the shared decoder returns `ü`, and `'\X2\00FC\X0\\'` returned `\X2\00FC\X0\` where it should return `ü\`. `\X\HH`, `\S\x` and `\Px\` were equally untouched, and the same gap applied inside a list, since `parseStepList` recurses through the same function. All of those now decode. Values written by this module's own escaper are unaffected — it emits non-ASCII raw and never emits a directive, so every `\\` it produces really is a doubled reverse solidus and the round trip was, and remains, exact. That is why this was invisible from inside the package: the reader was the exact inverse of the writer, and only a literal from somewhere else could tell them apart. `parseStepValue` is a public export, so that is a supported way to reach it.

  **Why the escaper does not move with it.** The pair is still closed. Emitting non-ASCII raw stays valid against the new reader — there are no backslashes to double and nothing to decode — and the directive-precedence rule in the shared scan is what keeps a value that merely LOOKS like a directive round-tripping as literal text: `\X2\00FC\X0\` written out as `\\X2\\00FC\\X0\\` reads back as those characters rather than decoding to `ü`. Switching the writer to emit `\X2\` directives would also round-trip, and is a separate decision about output bytes rather than a correctness fix.

  **One decoder instead of two.** The implementation is now `decodeStepStringLiteral`, exported from `@ifc-lite/encoding` (the additive API, hence the minor there). `packages/parser/src/source-header.ts` had written the same scan privately in [#2486](https://github.com/LTplus-AG/ifc-lite/issues/2486) after its own directive-blind regex corrupted non-ASCII header fields on round trip; that copy is deleted and both readers call the shared one. Its behaviour is unchanged — the code moved verbatim — so header parsing is byte-for-byte what it was. Two independent copies of a decoder this subtle is exactly how the second directive-blind regex survived, and the resolution is genuinely not two passes: a doubling pass run first eats a directive's own terminator whenever an escaped backslash follows it (`\X2\00FC\X0\` + `\\` ends in three backslashes), leaving an unterminated `\X2\` that never decodes.

  **A new dependency edge, `@ifc-lite/data` -> `@ifc-lite/encoding`.** It is acyclic — `@ifc-lite/encoding` has no dependencies of its own and imports nothing from `@ifc-lite/data` — and free in practice: every package that consumes `@ifc-lite/data` (parser, export, sdk, bcf, create, lists) already installs `@ifc-lite/encoding`. Released as a patch for `@ifc-lite/data`: no exported API changes, and the behavioural difference is a decode that was missing.

### Patch Changes

- [#2394](https://github.com/LTplus-AG/ifc-lite/pull/2394) [`eb39b27`](https://github.com/LTplus-AG/ifc-lite/commit/eb39b27f5eba186b23b3a683c25fff2c60084d9c) Thanks [@BIMvoice](https://github.com/BIMvoice)! - `decodeIfcString` now collapses the doubled reverse solidus (`\\` → `\`), so a Windows path or a regex stored in an IFC string attribute reads back as its real value instead of with every separator doubled.

  ISO 10303-21 doubles two characters inside a STEP string literal: the apostrophe (`''`) and the reverse solidus (`\\`). The apostrophe is un-doubled by this decoder's callers (they strip the surrounding quotes and un-double before decoding, which must happen in that order). The reverse solidus was collapsed by nobody at all — it fell into the "unknown escape, pass through" branch — so `C:\\temp` in a file surfaced as `C:\\temp` rather than `C:\temp`.

  The pair is collapsed **after** the `\X2\` / `\X4\` / `\X\` / `\S\` / `\P..\` directive arms, not in a pre-pass. A directive immediately followed by an escaped backslash ends in three backslashes (`\X2\00FC\X0\` + `\\`); collapsing pairs left-to-right first would eat the directive's own terminator and leave an unterminated `\X2\`. Conversely a leading escaped backslash makes the text after it literal (`\\X2\00FC\X0\` is the characters `\X2\00FC\X0\`, not `ü`).

  Strings with no escapes are unchanged, and `\X2\00E9\X0\` still decodes to `é`. The one behaviour change beyond the fix itself is on malformed input: `\X4\\X0\` (an empty, and therefore invalid, hex payload) now decodes to `\X4\X0\` rather than keeping both backslashes, because what is left after the invalid directive genuinely is a doubled reverse solidus.

  The Rust decoder in `ifc-lite-core` gets the same arm, and the shared cross-language vector fixture gains cases for both escapes plus a new end-to-end set that pins the composed un-double-then-decode contract — the two decoders agreeing was not enough to catch this, since neither of them owns the `''` half.

## 1.15.1

### Patch Changes

- [#2311](https://github.com/LTplus-AG/ifc-lite/pull/2311) [`273b068`](https://github.com/LTplus-AG/ifc-lite/commit/273b06827ef1469f63c396d204474a9f2400c642) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Reject a UUID string containing non-hexadecimal characters in `uuidToIfcGuid` instead of silently zeroing them. The function stripped dashes and checked the resulting string's length (32), but never checked that every character was actually a hex digit — `parseInt('gg', 16)` returns `NaN`, and `Uint8Array` coerces `NaN` to `0`, so a garbage input like `'gggggggg-gggg-gggg-gggg-gggggggggggg'` silently produced the all-zero UUID's GUID instead of throwing. `uuidToIfcGuid` is reachable with arbitrary caller-supplied strings via the SDK's `bcf.uuidToIfcGuid`.

## 1.15.0

### Minor Changes

- [#1879](https://github.com/LTplus-AG/ifc-lite/pull/1879) [`8799484`](https://github.com/LTplus-AG/ifc-lite/commit/87994844a5edb66404fa12b0719c89f5ec026c4d) Thanks [@louistrue](https://github.com/louistrue)! - Opt-in determinism hooks for reproducible IFC generation. `generateUuid` and `generateIfcGuid` accept an optional `RandomSource` (a `() => number` in `[0, 1)`) so GUIDs can be drawn from a seeded generator, and `IfcCreator` gains `ProjectParams.Timestamp` (fixed creation instant for the STEP header, IfcOwnerHistory and work-schedule defaults) and `ProjectParams.GuidSource` (deterministic GlobalId source). Same options twice yields byte-identical output; defaults are unchanged (wall clock + platform CSPRNG).

### Patch Changes

- [#1882](https://github.com/LTplus-AG/ifc-lite/pull/1882) [`382fa7c`](https://github.com/LTplus-AG/ifc-lite/commit/382fa7cf97c04bad07963e25052cbaeb6c2ba7e3) Thanks [@louistrue](https://github.com/louistrue)! - Reject `IfcCreator` `Timestamp` values that are finite but outside the ±8.64e15 ms Date range. They previously cleared the `Number.isFinite` guard and failed much later as a `RangeError` from `toISOString()` while writing the file header; they are now rejected in the constructor, where the error can still name the parameter. Also corrects the `RandomSource` documentation: the unseeded path uses Web Crypto when the runtime provides it and falls back to `Math.random` when it does not, rather than guaranteeing a platform CSPRNG.

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
