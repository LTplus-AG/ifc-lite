---
'@ifc-lite/cli': patch
---

`ask`'s "total volume", "largest X" and "smallest X" recipes summed GrossVolume/NetVolume over `bim.query()`'s unfiltered entity list, so an `IfcSpace` or `IfcAnnotation` carrying a volume quantity inflated the answer. `ask` now scopes these to building elements the same way `stats` does, via the shared `filterBuildingElements` helper.
