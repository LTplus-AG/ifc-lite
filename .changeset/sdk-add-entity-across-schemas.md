---
'@ifc-lite/sdk': minor
---

**store**: `bim.store.addEntity` can author IFC2X3-only and IFC4X3-only classes (issue [#2003](https://github.com/LTplus-AG/ifc-lite/issues/2003)).

The SDK gates `addEntity` on the parser's `isKnownType` and registers the same check as `@ifc-lite/mutations`' entity-type normalizer, so while that check answered from the IFC4 codegen pin alone the guard did not degrade — it refused outright. `bim.store.addEntity('arch', { type: 'IfcRoad', … })` threw `unknown IFC type 'IfcRoad'` for roughly 251 perfectly valid classes, and the SDK could not author them at all.

Nothing changes for the IFC4 classes the pin carries, and the guard still rejects what it was written to reject: `IfcWal` still throws.
