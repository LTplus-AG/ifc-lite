---
"@ifc-lite/collab": minor
---

Add `seedFromStep` for seeding a Y.Doc from a legacy STEP IFC model (plan §4).
Entities are keyed by their stable `IfcGloballyUniqueId` (`/<guid>`) so concurrent
edits converge across peers regardless of file-local express ids. To keep the
package parser-independent, `seedFromStep` consumes a minimal structural
`StepSeedSource` (entities → `{ guid, ifcClass, attributes, psets }`) that the
consumer adapts from its parsed model; it seeds entities, attributes, and
property sets and is idempotent. Exposes `guidToPath` so consumers can build a
matching `resolveEntity` for the mutation bridge.
