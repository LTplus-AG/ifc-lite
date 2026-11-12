---
"@ifc-lite/wasm": patch
---

Swept solids whose `Directrix` is an IFC 4.3 `IfcGradientCurve` (kerbs, barriers, ducts and pavement layers along a road or rail alignment) now follow the vertical profile instead of the flat `BaseCurve` at z = 0, so they sit at the alignment's height. A `StartParam`/`EndParam` trim on such a curve now cuts the sweep instead of dropping the item as unsupported; an `IfcLengthMeasure` bound is a length along the 3D curve and an `IfcParameterValue` is the curve parameter. Applies to `IfcSurfaceCurveSweptAreaSolid`, `IfcFixedReferenceSweptAreaSolid` and `IfcSweptDiskSolid`. Other directrix types are unchanged.
