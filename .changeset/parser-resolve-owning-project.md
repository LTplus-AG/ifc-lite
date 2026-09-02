---
'@ifc-lite/parser': minor
---

Add `resolveOwningIfcProjectId(entityIndex, relationships, expressId)`: resolves the express id of the specific `IFCPROJECT` that owns an entity, for a file with more than one (the shape `MergedExporter`'s documented `auto` unit-reconciliation mode produces for a federated merge of differently-unit'd models, see issue #1332). Also add an optional `projectId` parameter to `extractLengthUnitScale` and `extractProjectUnits` so a caller can read a SPECIFIC project's declared units instead of always the file's first one; both default to the prior first-project behaviour when omitted, so this is not a breaking change.

`@ifc-lite/ids` uses these to fix an entity in a later `IFCPROJECT` being scaled by the first project's units in IDS property/quantity comparisons (see the accompanying `@ifc-lite/ids` changeset).
