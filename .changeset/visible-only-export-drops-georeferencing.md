---
'@ifc-lite/export': patch
---

Fix `visibleOnly`/`subsetEntityIds` STEP exports silently dropping `IfcMapConversion`/`IfcProjectedCRS`.

`IfcMapConversion.SourceCRS` points AT the `IfcGeometricRepresentationContext` it converts — nothing points the other way, and `IfcCoordinateOperation` is otherwise reached only through an inverse attribute the closure walk never follows. `IfcGeometricRepresentationContext` is always a closure root, but that only pulls in what it references forward, so every `visibleOnly` export (the viewer's hide/isolate export) and every federated `visibleOnly` export in `MergedExporter` of a georeferenced model dropped its `IfcMapConversion`/`IfcProjectedCRS` — grid alignment, EPSG code, vertical datum — leaving the exported file un-georeferenced at the local origin for the next tool.

`subsetEntityIds` (the anonymize-export "keep georeferencing" path, #3351) already had its own fix for the same inverse-attribute gap via `subset-roots.ts`'s explicit rooting; this closes the equivalent gap in the ordinary `visibleOnly` closure, which had none. A new `collectGeoreferencingEntities` (in `georef-closure.ts`) does the same reverse-pass rescue `collectStyleEntities` already does for styled items, and respects any caller-supplied `excludeIds` so a deliberately-scrubbed map conversion (the anonymize-export "remove georeferencing" option) is never resurrected by it.
