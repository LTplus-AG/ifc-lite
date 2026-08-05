---
"@ifc-lite/query": patch
---

Fix three `EntityNode` relationship helpers that traversed the graph in the wrong direction.

The parser builds every edge as `addEdge(relatingObject, relatedObject)` (`columnar-parser.ts:476`), so `forward` always means relating → related. Three helpers were oriented against that:

- `filledBy()` used `inverse`. `IfcRelFillsElement` is `(RelatingOpeningElement, RelatedBuildingElement)`, so the opening is the source and the filler the target — reaching the filler from the opening is a forward traversal. As written the method returned an empty array for every opening, which is indistinguishable from "this opening has no filler".
- `definingType()` used `forward` and `instances()` used `inverse`. `IfcRelDefinesByType` has the type as its relating object, so the type is the source and each occurrence the target; both helpers were the wrong way round. The element → type lookups in `on-demand-extractors.ts` already used `inverse` for this, so the two disagreed.

`filledBy()` is the one with an observable consequence today: `@ifc-lite/clash` calls `opening.filledBy()` to exclude a host element from clashing with the door or window filling its own opening (`adapters/step.ts:172`). Because the call always returned nothing, that exclusion never fired and every door and window could report a false-positive clash against the opening it legitimately fills. `definingType()` and `instances()` have no in-repo callers, so their fix is latent — but they are public API.

The gap survived because the unit-test fixture encoded the reverse orientation for `IfcRelDefinesByType`, so the mock and the reversed code agreed with each other. The fixture is corrected to match the parser, and `IfcRelFillsElement` — previously absent from it entirely — is now covered.
