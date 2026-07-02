---
"@ifc-lite/renderer": patch
---

Add an optional `ownerId` to `DrawingLine2D` so the IfcAnnotation / IfcGridAxis symbolic overlay can carry the express id of the entity that authored each segment. The section-cut and drawing-2d cutters leave it undefined; it lets the viewer drop an annotation's curves when the owning entity is hidden, without a mesh. Supports the terrain/annotation visibility fixes in #1480.
