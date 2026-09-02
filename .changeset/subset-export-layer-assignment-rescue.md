---
'@ifc-lite/export': patch
---

A `visibleOnly`/subset STEP export (viewer hide/isolate export, the anonymize-export subset path, and `MergedExporter`) dropped `IfcPresentationLayerAssignment` (and its `IfcPresentationLayerWithStyle` subtype) whenever the export included the layer's assigned geometry — the same reference-direction gap already fixed for georeferencing (#3696) and styled items: `IfcPresentationLayerAssignment.AssignedItems` points AT the representation/items it names, but nothing in the file points back at the layer assignment, so the forward closure walk from the visible roots never reached it.

`collectStyleEntities` (`packages/export/src/reference-collector.ts`) now also runs its reverse pass over `IFCPRESENTATIONLAYERASSIGNMENT`/`IFCPRESENTATIONLAYERWITHSTYLE`, alongside the `IFCSTYLEDITEM`/`IFCSTYLEDREPRESENTATION` pass it already did: a layer assignment naming an item already in the closure is rescued in. Both `StepExporter` (`visibleOnly` and `subsetEntityIds`) and `MergedExporter` share this function, so both paths are fixed by the one change. A layer assignment naming only entities excluded from the export (a hidden product, or the anonymize-export privacy scrub) is still correctly left out.
