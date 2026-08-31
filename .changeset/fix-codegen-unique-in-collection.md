---
'@ifc-lite/codegen': patch
---

Fix the EXPRESS code generator dropping a `UNIQUE` collection constraint into
the element type instead of stripping it.

EXPRESS allows `UNIQUE` directly in front of a collection's element type
(e.g. `LIST [1:?] OF UNIQUE IfcGridAxis`, real syntax from `IfcGrid.UAxes` in
both `IFC4_ADD2_TC1.exp` and `IFC4X3.exp`) — it constrains the collection's
elements, it is not part of the element type name. `parseNestedCollection`
never stripped it, so the parsed attribute type carried the leftover keyword
verbatim (`type: 'UNIQUE IfcGridAxis'`), and a collection nested one level
under a `UNIQUE` (`LIST [1:?] OF UNIQUE LIST [1:2] OF IfcLengthMeasure`)
fell through the "ends with Measure" heuristic entirely and lost an array
dimension (`number[]` instead of `IfcLengthMeasure[][]`).

Eight IFC4 attributes and two additional IFC4X3-only attributes were affected
(`IfcTypeProduct.RepresentationMaps`, `IfcGrid.{UAxes,VAxes,WAxes}`,
`IfcIndexedPolygonalFaceWithVoids.InnerCoordIndices`, `IfcPath.EdgeList`,
`IfcPolyLoop.Polygon`, `IfcPropertyEnumeration.EnumerationValues`,
`IfcPropertyTableValue.DefiningValues`, `IfcVirtualGridIntersection.IntersectingAxes`,
`IfcStructuralLoadConfiguration.Locations`, plus IFC4X3's
`IfcTriangulatedFaceSet.Faces` and `IfcIndexedPolygonalTextureMap.InnerTexCoordIndices`).
`packages/codegen/generated/ifc4/entities.ts` and `generated/ifc4x3/entities.ts`
carried the bug outright (invalid TypeScript, e.g. `UAxes: UNIQUE IfcGridAxis[];`);
`packages/parser/src/generated/entities.ts` had it hand-patched to valid syntax
in one prior commit without ever touching the generator, so
`schema-registry.ts` — which carries the same attribute type as a plain
string, so `tsc` never flagged it — kept shipping `type: 'UNIQUE IfcGridAxis'`
as runtime metadata in every published `@ifc-lite/parser` release.

Regenerated and committed `packages/codegen/generated/{ifc4,ifc4x3}/{entities,schema-registry}.ts`
and `packages/parser/src/generated/{entities,schema-registry}.ts` to match the
fixed generator; a fresh regeneration against the committed `.exp` schemas is
now byte-identical to what's committed.
