---
"@ifc-lite/parser": minor
"@ifc-lite/viewer": minor
---

The properties card now links the physical and the analytical model (Part of #9668). Select a beam, column, slab, wall or footing that a structural member or connection is assigned to, and the Structural Analysis card lists those items. Select a structural member or connection, and the card lists the physical elements it idealises. Click a row to select that entity. An entity with no link shows no such section. Works for IFC2X3, IFC4 and IFC4X3.

`@ifc-lite/parser` exports `structuralCounterparts(extraction, expressId)`, which answers the same question from either end and returns `{ side, expressIds }` or `null`. The index over both directions is built once per extraction.
