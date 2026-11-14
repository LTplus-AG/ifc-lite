---
"@ifc-lite/export": patch
---

Converting IFC2X3 to IFC4 now writes IfcStructuralLinearActionVarying and IfcStructuralPlanarActionVarying as an IfcStructuralCurveAction or IfcStructuralSurfaceAction with PredefinedType NOTDEFINED and a new IfcStructuralLoadConfiguration holding their loads. Converting IFC4 to IFC2X3 writes such an action back as the varying action. Both directions convert only an action the other direction converts back (its representation has exactly one IfcShapeAspect for the load locations, its loads share one type the IFC2X3 action admits, and an IFC4 PredefinedType is linear between the values), apply to an unedited full export, and are reported as structural conversion warnings.
