---
"@ifc-lite/wasm": patch
---

Place elements on IFC2X3 and IFC4 grid intersections correctly. An `IfcGridPlacement` in those schemas has no `PlacementRelTo`, so the mesher now reads its attributes in the layout the file declares and positions the element in the frame of the grid that owns the axes, instead of at the world origin.
