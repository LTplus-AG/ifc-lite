---
"@ifc-lite/parser": minor
"@ifc-lite/export": patch
"@ifc-lite/cli": patch
---

Widen the byte-range readers so they accept either the raw source bytes or the `IfcSourceBytes` accessor (#2183). Behaviour-neutral groundwork: every widened helper normalises through `asSourceBytes` and reads via `decodeUtf8`/`slice`, and no call site changes shape. (`IfcDataStore.source` still held a `Uint8Array` at this step; the type flip lands in the same release, below.)

`@ifc-lite/parser` now exports `asSourceBytes` and the `IfcSourceBytes` type. They were internal in the previous step because nothing outside the package consumed them; the widened readers in `@ifc-lite/export`, `@ifc-lite/cli` and the viewer are that consumer, and `IfcDataStore.source` is on its way to the type regardless.

Widened: `BufferEntitySource`, `extractLengthUnitScale`, `extractProjectUnits`, `SpatialHierarchyBuilder.build`, `buildEntityRefsFromIndex`, `collectReferencedEntityIds`, `collectStyleEntities`, `collectRefsInByteRange`, and the CLI's dangling-reference scan.
