---
"@ifc-lite/create": minor
---

New in-store builders `addStairToStore` and `addRailingToStore` (#6232). `addStairToStore` writes an IfcStair that aggregates an IfcStairFlight with its risers and treads. The flight body is one extruded stepped profile, with an optional waist along the pitch. `addRailingToStore` writes an IfcRailing along a polyline path: a swept circular handrail with posts at each vertex and, optionally, at a set spacing. Both lay out their attributes for the anchor's schema (IFC2X3, IFC4, IFC4X3) and refuse IFC5.
