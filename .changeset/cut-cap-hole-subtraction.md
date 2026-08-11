---
"@ifc-lite/renderer": patch
---

Section cut caps and `IfcAnnotationFillArea` fills now subtract their holes. The shared triangulator bridged hole rings in but almost never clipped an ear from the bridged ring, so a 4x4 profile with a 2x2 hole covered an area of 2 instead of 12 and any cut through a wall opening or slab void rendered a near-empty cap. Rings are now nested by the even-odd rule, so an island inside a hole fills, matching the 2D canvas and SVG export paths which already fill with `evenodd`. Hole-free profiles are unchanged.
