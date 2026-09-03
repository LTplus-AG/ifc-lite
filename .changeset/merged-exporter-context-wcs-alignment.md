---
'@ifc-lite/export': patch
---

`MergedExporter` no longer unifies a model's `IfcGeometricRepresentationContext` onto the primary model's when the two disagree on `WorldCoordinateSystem`. The context is the root anchor of every placement in it; dropping a model's own context in favour of the primary's silently re-interpreted every one of that model's untouched coordinates against the wrong origin, a wrong-place error equal to the WCS delta. A model whose context WCS matches the primary's (including the common case of both at the identity origin) still unifies exactly as before; a mismatched context is now kept as that model's own root, the same way an incompatible length unit already keeps its own project.
