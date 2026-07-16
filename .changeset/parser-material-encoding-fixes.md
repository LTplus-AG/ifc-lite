---
"@ifc-lite/encoding": patch
"@ifc-lite/parser": patch
"@ifc-lite/cache": patch
---

Harden IFC string decoding, material-usage resolution, the worker scanner, and the binary cache.

- encoding: `decodeIfcString` no longer throws a `RangeError` on a `\X4\` sequence whose 8-hex value exceeds the Unicode maximum (`0x10FFFF`); it now emits U+FFFD instead. The previous throw propagated uncaught through the columnar batch-name path and aborted the entire model load.
- parser: `onDemandMaterialMap` is now list-valued, so a second `IfcRelAssociatesMaterial` targeting the same element is preserved instead of last-wins overwritten. `buildMaterialUsageIndex` gains a relationship-graph fallback for server-loaded stores (no forward map) and no longer memoises an empty index built from a store that had neither a map nor a source (so a later-populated store can rebuild). `IfcMaterialConstituent` siblings without an explicit `Fraction` now share the remaining fraction evenly instead of collapsing to weight 0.
- parser: the inline worker scanner's type-name cache now byte-verifies on a hit (matching `tokenizer.ts`), so a 32-bit hash collision can no longer alias two distinct type names on the default scan path.
- parser: batch GlobalId+Name extraction now collapses STEP doubled single-quotes (`''` -> `'`), matching `EntityExtractor`, so names like `John''s Wall` render correctly.
- cache: the writer no longer sets the dead `HasSpatial` header flag (no Spatial section is written or read), and the string-table read path preserves positions via `StringTable.fromArray` instead of re-interning (which deduped, shifting later indices when a duplicate was present). On-disk format is unchanged.
