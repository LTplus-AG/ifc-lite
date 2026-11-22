---
"@ifc-lite/create": minor
---

`editHostedElementInStore` (and `bim.store.editHostedElement`) no longer leaves the door or window's previous `IfcProductDefinitionShape` behind after a size edit. The old shape kept referencing the representation the new `IfcRepresentationMap` maps, so the export had a product shape with no `ShapeOfProduct` and a representation owned twice, both refused by schema validation; repeated resizes also kept the previous mapping wrappers. The retirement the mirror and stair edits already did inline is now one helper, `retireProductShape(store, editor, shapeId)`, which is exported for callers that remove a product with `StoreEditor.removeEntity` and want its now-unused shape and representations gone too. Records anything else still references (shared type maps, contexts, styled items) are kept.
