---
"@ifc-lite/clash": minor
"@ifc-lite/renderer": patch
---

Show the focused clash's REAL contact interface instead of an AABB box (#1402). New `@ifc-lite/clash/contact`: `contactClusters(meshA, meshB)` returns the contact patches — the shared-face polygon for coplanar/flush overlaps (surface), the intersection line for crossings (line), or a point — classified by area/length, via a Moller triangle-triangle test plus shared-face clustering (coplanar pairs Sutherland-Hodgman clipped on their common plane and unioned into a boundary polygon; cross pairs unioned along the intersection line). Computed on demand for the single focused pair. The renderer gains `setClashContactLines()` to draw the contact polygon outlines / intersection lines; the viewer prefers this over the box.
