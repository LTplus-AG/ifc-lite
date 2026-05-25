---
"@ifc-lite/wasm": patch
---

Fix the broken door-handle silhouette on Revit-exported `IfcDoor`
fixtures (issue #674, PR #793). `process_surface_of_revolution_face`
collapsed each profile point's radial vector to
`radius = sqrt(rx² + ry²)`, discarding the sign of the projection
onto `axis_x`. Profiles that sat entirely on the `-axis_x` half of
the axis frame — for example the Revit door-handle bulb, an
`IfcCircle` arc whose centre is offset 15 mm from the revolution
axis on the bar side — got mirrored to the `+axis_x` ray and rendered
180° away from where they should sit, leaving a visible gap between
the lever bar and the rosette.

The sweep now rotates the profile's actual `(rx, ry)` 2D radial
vector through the sweep angle, so profiles offset to either side of
the axis stay on their side. Triangle counts are unchanged
(repositioning, not re-sampling).
