---
"@ifc-lite/wasm": patch
---

An `IfcGridPlacement` whose `IfcVirtualGridIntersection` has non-zero `OffsetDistances` now honours `IfcGridAxis.SameSense`. An axis with `SameSense = .F.` runs against its curve, so its offset lands on the opposite side. The intersection of the two axis lines is unchanged, and `.T.`, `.U.` and absent values keep the curve direction.
