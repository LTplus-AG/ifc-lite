---
"@ifc-lite/create": patch
---

`removeStructuralEntityInStore` now removes shape aspects that describe a removed member's product shape, such as the `VaryingThicknessLocation` aspect `addStructuralSurfaceMemberToStore` copies onto an IFC2X3 `IfcStructuralSurfaceMemberVarying`. Before, they survived and kept the member's shape and topology alive. An aspect of another product's shape is kept.
