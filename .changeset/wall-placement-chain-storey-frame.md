---
"@ifc-lite/create": patch
---

Compose intermediate `IfcLocalPlacement.PlacementRelTo` hops in wall extraction

`extractWallSegmentsForStorey` read only a wall's own `RelativePlacement` and
ignored `PlacementRelTo`. That is right for a wall placed directly under its
storey, but the standard `IfcElementAssembly` grouping (curtain walls, precast
panel runs, railing systems) inserts an intermediate placement between the
member and the storey — and its translation and rotation were silently
dropped, so the member was extracted at the wrong position relative to its
siblings and the enclosed room was never detected.

Composition stops at the storey's own placement rather than continuing to the
root, because storey-local is the frame the write side uses: the generated
`IfcSpace` is authored with the storey placement as its `PlacementRelTo`.
`existingSpaceFootprintsByStorey` shares that frame and now uses the same
composition.

A storey with no `ObjectPlacement` — optional on `IfcProduct` — has no chain to stop the composition, so nothing is composed at all for it rather than composing every hop up to the world root and returning world coordinates where storey-local ones are the contract.
