---
"@ifc-lite/export": patch
---

A full IFC2X3 to IFC4 export now writes an incomplete varying structural action as an IfcStructuralCurveAction or IfcStructuralSurfaceAction with PredefinedType CONST, as the subset export does. It keeps the initial load, links the retained reaction through an IfcRelAssignsToProduct named Causes, and reports the omitted varying locations and subsequent loads. Before, it kept the IFC2X3 keyword, which IFC4 does not declare.
