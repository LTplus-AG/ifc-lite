---
"@ifc-lite/wasm": minor
"@ifc-lite/server-bin": minor
---

`IfcStructuralCurveMember` now renders. A structural analysis model's curve members carry their geometry as an `IfcTopologyRepresentation` typed `'Edge'` holding an `IfcEdge`, and both halves of that were unreachable: the representation filter selected only `IfcShapeRepresentation`s whose type named a body, and no processor was registered for `IfcEdge`. Every structural curve member therefore meshed to zero triangles and never reached the viewer at all. Each member's edge is now tessellated as a thin two-triangle ribbon between its `EdgeStart` and `EdgeEnd` vertex points, so an analysis model shows its members instead of loading empty.

Scoped deliberately: only plain `IfcEdge` on an `IfcStructuralCurveMember` (including `IfcStructuralCurveMemberVarying`). `IfcOrientedEdge`, `IfcEdgeCurve`, `IfcStructuralSurfaceMember` and the `'Vertex'`-typed representations on `IfcStructuralPointConnection` are still unhandled and still mesh empty.
