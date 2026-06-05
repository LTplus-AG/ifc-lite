---
"@ifc-lite/wasm": patch
---

Geometry correctness: seven fixes found by the IFC-vs-IfcOpenShell sweep (#943), each verified on both the Manifold and legacy BSP CSG kernels.

- `IfcPolygonalBoundedHalfSpace` clip now removes the side the `AgreementFlag` designates as material (party/outside walls no longer collapse to a sliver).
- Trimmed `IfcLine` basis on `IfcSurfaceOfRevolution` honours its cartesian trim (revolved fixtures were ~9.5× oversized).
- Opening-cut epsilons scale with coordinate magnitude, so thin walls at building-scale coordinates are actually cut through instead of left sealed.
- `IfcCShapeProfileDef` uses `Width` (not `Girth`) for the flange.
- Radius-aware arc tessellation for trimmed conics — large-radius curved walls render smooth instead of faceted.
- `IfcL/U/T/IShapeProfileDef` honour `FilletRadius` / `EdgeRadius` (rounded steel-section root fillets and toes).
