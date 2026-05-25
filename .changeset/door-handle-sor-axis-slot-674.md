---
"@ifc-lite/wasm": patch
---

Fix the door-handle bend rendering with the lever floating
detached from the rosette on Revit-exported `IfcDoor` fixtures
(issue #674 redux, PR #799).

`process_surface_of_revolution_face` in `advanced_face.rs` read
`surface.get(1)` for the axis placement, but per IFC 4.3 the
`IfcSurfaceOfRevolution` schema is:

  IfcSweptSurface (parent)
    0 SweptCurve
    1 Position           (optional IfcAxis2Placement3D)
  IfcSurfaceOfRevolution (child)
    2 AxisPosition       (IfcAxis1Placement)

Revit exports `IFCSURFACEOFREVOLUTION(#sc,$,#ap)` — slot 1 is
null. Reading slot 1 returned None, the fallback
`(Point3::origin(), +Z)` kicked in, and the angular-extent
calculation projected boundary points around (0,0,0) instead of
the true revolution axis. The bend swept ~13° through the wrong
region of space and the bulb ended up pointing "down and outward"
from the rosette.

Switched to `surface.get(2)`. AABB on the door fixture lands at
x=[115, 245] y=[67, 122] vs IfcOpenShell's [120, 250] / [70, 120]
(5 mm offset from tessellation density). The bulb now rotates
through the correct quadrant and the handle connects.
