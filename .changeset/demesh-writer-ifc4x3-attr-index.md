---
"@ifc-lite/export": patch
---

Stop silently dropping IFC4X3-only element types from de-meshed and LOD0 exports (#2032).

Both `demesh-writer.ts` and `lod0-generator.ts` carried a private `findAttrIndex` that resolved positional attribute slots through the parser's IFC4-pinned registry. For a class that exists only in IFC4X3 — `IfcSignal`, `IfcPavement`, `IfcCourse` and the rest of the infrastructure additions — that registry returns nothing, so every attribute index came back null.

In the de-mesh writer that meant `Representation` could not be located and the element was skipped with reason `no-representation-attribute`. In the LOD0 generator it meant `ObjectPlacement` could not be located and the element was dropped from the walk entirely, with no skip reason recorded anywhere — so an infrastructure model could lose elements from its LOD0 export with nothing in the output to say so.

Both now resolve slots through the cross-schema union already used by `attribute-real-slots.ts` and `attribute-slot-types.ts`.
