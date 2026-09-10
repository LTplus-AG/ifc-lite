---
'@ifc-lite/codegen': patch
---

express-parser: strip an EXPRESS element qualifier from every aggregate shape, not only the numerically bounded one (#4212).

`UNIQUE` and `OPTIONAL` in front of an aggregate's element type (`LIST [1:?] OF UNIQUE IfcGridAxis`) constrain the elements; they are not part of the element type name and have no TypeScript equivalent. #3565 dropped them in `parseNestedCollection`, but `parseAttribute` only reached that function when the aggregate carried numeric bounds. A symbolic bound (`LIST [1:Dim] OF UNIQUE X`), no bound at all (`LIST OF UNIQUE X`), or an `OPTIONAL UNIQUE` element qualifier fell to a string-replace fallback that carried the qualifier into `attr.type` verbatim, so the emitter wrote `UNIQUE X[]` into the entity interface and `type: 'UNIQUE X'` into `schema-registry.ts`, where it sits inside a string literal that no typecheck reads. Aggregate bounds are now matched loosely and only become `arrayBounds` when both ends are numeric, and every element type goes through `parseNestedCollection`.

The three schemas committed in this package (IFC2X3_TC1, IFC4_ADD2_TC1, IFC4X3) use numeric bounds for all 36 of their `OF UNIQUE` occurrences (12, 11 and 13), so their regenerated output is byte identical. The fix matters for any other `.exp` fed to the CLI.
