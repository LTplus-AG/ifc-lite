---
'@ifc-lite/ids': patch
---

Fix an IDS length comparison silently rescaling by 1000x when the entity's own `IFCPROJECT` declares no length unit in a multi-`IFCPROJECT` (federated-merge) file.

`resolveEntityMeasureScales` resolved the owning project and then took `extractLengthUnitScale` for it unconditionally. That call answers `1.0` both for "this project declares metres" and "this project declares no `LENGTHUNIT` at all" - `UnitsInContext` is OPTIONAL on `IfcContext`, so a federated model can legitimately arrive with none, and absence read as success. A 300 mm value owned by such a project was reported as 300 m, and its area/volume were derived from that same wrong length scale squared/cubed. Only a *declared* length unit now overrides the store-wide scale; an undeclared one takes the file-wide length, area and volume answer together, the same safe-miss direction the walk-failed fallback already takes.
