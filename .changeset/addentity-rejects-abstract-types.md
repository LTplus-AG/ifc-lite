---
"@ifc-lite/parser": patch
"@ifc-lite/sdk": patch
---

`bim.store.addEntity` and the MCP `entity_create` tool now reject abstract IFC classes (#2035).

`IfcProduct`, `IfcRoot`, `IfcRelationship` and the other ~123 EXPRESS `ABSTRACT SUPERTYPE`s are real classes, so the existing `isKnownType` guard accepted them — `addEntity('IfcProduct', …)` wrote `#N=IFCPRODUCT(...)` into the overlay and out to the exported file, which is not valid IFC.

`@ifc-lite/parser` now exports `isInstantiable(type)`, answering `known && !abstract` from the same cross-schema union (2X3 + 4 + 4X3) `isKnownType` already resolves against. `@ifc-lite/sdk` wires it into both the `bim.store.addEntity` guard and the shared entity-type normalizer that `@ifc-lite/mutations`' `StoreEditor.addEntity` consumes — the same choke point the MCP `entity_create` tool goes through via `ensureEditor()`. Passing an abstract type now throws instead of silently authoring an invalid STEP record.
