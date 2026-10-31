---
"@ifc-lite/wasm": patch
---

`IfcSurfaceCurveSweptAreaSolid` and `IfcFixedReferenceSweptAreaSolid` now roll a non-circular section about the directrix as ISO 10303-42 defines it, from the `ReferenceSurface` (`IfcSurfaceOfLinearExtrusion`, `IfcPlane`) or the `FixedReference`, instead of a rotation-minimising frame. Revit slab edges and light fixtures swept along an arc no longer come out rolled 90° (#8437). Sweeps without a usable reference, and circular profiles, are unchanged.
