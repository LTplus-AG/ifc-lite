---
"@ifc-lite/data": minor
"@ifc-lite/create": patch
"@ifc-lite/export": patch
"@ifc-lite/collab": patch
"@ifc-lite/viewer": patch
---

An `IfcAxis2Placement3D` with an absent (`$`) `RefDirection` now gets the same local X axis everywhere in TypeScript as the renderer draws (#5922). The new `firstProjAxis(axis)` export in `@ifc-lite/data` is the one TypeScript copy of that fill. It mirrors `build_axis2_matrix` in the Rust geometry crate: world X projected onto the plane normal to the Axis, and `(0,0,1) x Axis` when that projection is shorter than 1e-6. So an Axis of exactly -X gets `(0,-1,0)`.

Model compare used world Y there. That turned the compared frame 180 degrees about the Axis relative to the viewer. The LOD0 exporter, the viewer's storey display elevation, and collab `placementToMatrix` each had their own fallback, and those gave a frame 90 degrees off for ±X Axes. The viewer's slab split read such a solid Position as identity. All of these now call `firstProjAxis`, as does `@ifc-lite/create` when it completes an Axis-only placement.
