---
'@ifc-lite/parser': patch
---

Fix `resolveEntityLengthUnitScale` silently rescaling a material-layer thickness by 1000x when the entity's own `IFCPROJECT` declares no length unit in a multi-`IFCPROJECT` (federated-merge) file.

`resolveEntityLengthUnitScale` resolved the owning project and then took `extractLengthUnitScale` for it unconditionally. That call answers `1.0` both for "this project declares metres" and "this project declares no `LENGTHUNIT` at all" - `UnitsInContext` is OPTIONAL on `IfcContext`, so a federated model can legitimately arrive with none. A 300 mm `IfcMaterialLayer.LayerThickness` owned by such a project was reported as 300 m. Only a project that actually declares a length unit now overrides the file-wide answer; an undeclared one falls back to the first project's scale, the same safe-miss direction the walk-failed fallback already takes.
