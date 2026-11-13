---
"@ifc-lite/wasm": patch
---

Swept solids whose `Directrix` is an IFC 4.3 `IfcGradientCurve` (kerbs, barriers, ducts and pavement layers along a road or rail alignment) now follow the vertical profile instead of the flat `BaseCurve` at z = 0, so they sit at the alignment's height. This applies to `IfcSurfaceCurveSweptAreaSolid`, `IfcFixedReferenceSweptAreaSolid` and `IfcSweptDiskSolid`, and sections are oriented by the curve's own tangents, so two sweeps that meet at a point share their section there. A `StartParam`/`EndParam` trim on such a curve now cuts the sweep instead of dropping the item as unsupported. On the two swept-area solids a bound is an `IfcCurveMeasureSelect`: an `IfcLengthMeasure` is a length along the 3D curve and an `IfcParameterValue` is the curve parameter. An `IfcSweptDiskSolid` bound is always an `IfcParameterValue`. Other directrix types are unchanged.
