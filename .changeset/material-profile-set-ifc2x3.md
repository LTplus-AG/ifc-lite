---
"@ifc-lite/export": patch
---

`exportToStep({ schema: 'IFC2X3' })` no longer throws on `IfcMaterialProfileSet`, `IfcMaterialProfile`, `IfcMaterialProfileSetUsage` (+ `IfcMaterialProfileSetUsageTapering`/`IfcMaterialProfileWithOffsets`) — IFC4-only, non-rooted material-profile types with no IFC2X3 representation. They're now withheld the same way `IfcStructuralLoadConfiguration` is (#5114): omitted from the output, with the referencing `IfcRelAssociatesMaterial` redirected to an `IFCPROXY` instead of the export crashing or shipping a dangling reference.
