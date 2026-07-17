---
"@ifc-lite/encoding": patch
"@ifc-lite/parser": patch
"@ifc-lite/cache": patch
---

Harden IFC string decoding, material-usage resolution, the worker scanner, and the binary cache.

- encoding: `decodeIfcString` no longer throws a `RangeError` on a `\X4\` sequence whose 8-hex value exceeds the Unicode maximum (`0x10FFFF`); it now emits U+FFFD instead. The previous throw propagated uncaught through the columnar batch-name path and aborted the entire model load. Surrogate values in `\X4\` and lone surrogates in `\X2\` also decode to U+FFFD now (surrogate pairs split across `\X2\` groups still combine), matching the Rust decoder (`char::from_u32` / `String::from_utf16_lossy`) so both parse paths yield identical strings.
- parser: `onDemandMaterialMap` is now list-valued, so a second `IfcRelAssociatesMaterial` targeting the same element is preserved instead of last-wins overwritten. `buildMaterialUsageIndex` gains a relationship-graph fallback for server-loaded stores: it works on the real server store shape (empty `source` buffer, facade relationship graph with closure-only accessors), with `collectMaterialLeaves` surfacing each definition as one opaque full-weight leaf when no source is available. An empty index built from a store with no material inputs at all is no longer memoised (so a later-populated store can rebuild). `IfcMaterialConstituent` weights now always sum to 1: siblings without an explicit `Fraction` share the remainder instead of collapsing to weight 0, sets where explicit fractions already fill the whole are renormalised (`{1.0, unset}` -> 2/3, 1/3 rather than 1.5x totals), and non-finite or non-positive fractions/layer thicknesses are treated as unset.
- parser: the inline worker scanner's type-name cache now byte-verifies on a hit (matching `tokenizer.ts`), so a 32-bit hash collision can no longer alias two distinct type names on the default scan path.
- parser: batch GlobalId+Name extraction now collapses STEP doubled single-quotes (`''` -> `'`), matching `EntityExtractor`, so names like `John''s Wall` render correctly.
- cache: the writer no longer sets the dead `HasSpatial` header flag (no Spatial section is written or read), and the string-table read path preserves positions via `StringTable.fromArray` instead of re-interning (which deduped, shifting later indices when a duplicate was present). On-disk format is unchanged.
