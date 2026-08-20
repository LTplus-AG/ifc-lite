---
"@ifc-lite/export": patch
---

Fix a STEP export with `includeGeometry: false`: an entity retyped across the geometry boundary (e.g. `IfcWall` to `IfcCartesianPoint`, or the reverse) disagreed with itself about whether its line survived. The source-iteration pass's own geometry skip classified the entity by its RAW authored type, while `isGeometryExcluded` — the predicate `hasEmittableHostBytes`/`willBeEmitted` use to decide whether an edit counts as a delivered modification — classified it by the EFFECTIVE (retyped) type. A wall retyped to a geometry class still shipped its rewritten geometry line into `DATA` despite `includeGeometry: false`, while the header claimed a modification for it; the reverse retype (geometry to non-geometry) silently dropped a legitimate edit with no line and no count. The source-iteration skip now reads `isGeometryExcluded` too, so both agree.
