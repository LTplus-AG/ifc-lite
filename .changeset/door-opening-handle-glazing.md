---
"@ifc-lite/wasm": patch
---

Fix the three Revit-door geometry defects called out in #604: opening-cut
slivers when the opening's depth equals the host wall's depth, missing door
handle hardware (`IfcAdvancedBrep` over `IfcSurfaceOfRevolution` and
`IfcCylindricalSurface`), and broken door glazing. The opening extension now
overshoots the wall by a unit-independent pad whose floor is strictly above
the rectangular clipper's epsilon, surfaces of revolution are tessellated
from their generator profile and recovered angular extent, and circular edge
boundaries are sampled along the arc instead of collapsing to two-point
loops.
