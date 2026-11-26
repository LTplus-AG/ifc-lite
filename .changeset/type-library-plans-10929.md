---
"@ifc-lite/geometry": minor
"@ifc-lite/drawing-2d": patch
"@ifc-lite/viewer": patch
---

`Drawing2DGenerator.generate`, and with it `generateFloorPlan` and `generateSection`, no longer cuts type-library geometry: `IfcWallType`, `IfcDoorType` and other representation maps meshed at the origin (`geometryClass` 1 and 2) are left out by the rule the viewer's Model view applies. A file with no placed elements still draws its orphan type geometry. The rule now lives in `@ifc-lite/geometry/geometry-class` as `selectModelMeshes` and `isModelViewGeometryClass`, and the viewer uses it from there.
