---
"@ifc-lite/create": minor
---

`addStructuralPointConnectionToStore` accepts a number as spring stiffness in `BoundaryCondition`, and refuses a non-finite one. On IFC4 and IFC4X3 each stiffness is now written as a typed SELECT member (`IFCBOOLEAN(.T.)`, `IFCLINEARSTIFFNESSMEASURE(1000.)`) instead of a bare `.T.`/`.F.`, and a number is no longer turned into a boolean. IFC2X3 writes numbers verbatim; its fixed/free output is unchanged.
