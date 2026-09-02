---
'@ifc-lite/cli': patch
---

`ifc-lite stats`'s per-material volume no longer doubles when an element carries more than one `IfcElementQuantity` set reporting `GrossVolume`/`NetVolume` (e.g. a vendor-specific quantity set alongside the standard `Qto_` one) — `computeMaterialSummary` broke only out of the per-qset loop, so a second matching quantity set kept adding to the same element's volume instead of restating it. It now takes the first Gross/NetVolume found across every quantity set on the element, the same single-slot rule `aggregateWalls` already used for wall volume.
